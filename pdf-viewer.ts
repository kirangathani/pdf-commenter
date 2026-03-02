import { ContextMenu, ContextMenuAction } from './context-menu';
import * as pdfjsLibModule from 'pdfjs-dist/build/pdf.js';

// PDF.js interfaces covering the subset of API we actually use
interface PDFRenderTask {
    promise?: Promise<void>;
    cancel(): void;
}

interface PDFPageProxy {
    getViewport(params: { scale: number }): PageViewport;
    render(params: { canvasContext: CanvasRenderingContext2D; viewport: PageViewport }): PDFRenderTask;
    getTextContent(): Promise<TextContent>;
}

interface PageViewport {
    width: number;
    height: number;
    transform: number[];
}

interface PDFTextItem {
    str: string;
    transform: number[];
    fontName?: string;
}

interface TextContent {
    items: (PDFTextItem | Record<string, unknown>)[];
}

interface PDFDocumentProxy {
    numPages: number;
    getPage(pageNumber: number): Promise<PDFPageProxy>;
    destroy(): void;
}

interface PDFLoadingTask {
    promise: Promise<PDFDocumentProxy>;
}

interface PDFJsLibrary {
    GlobalWorkerOptions?: { workerSrc: string };
    getDocument(params: { data: ArrayBuffer }): PDFLoadingTask;
    renderTextLayer?(params: {
        textContent: TextContent;
        container: HTMLElement;
        viewport: PageViewport;
        textDivs: HTMLElement[];
        enhanceTextSelection?: boolean;
    }): { promise?: Promise<void> };
    Util: { transform(a: number[], b: number[]): number[] };
}

/**
 * Public interface for PDFViewerComponent, consumed by view.ts.
 */
export interface IPDFViewer {
    loadPdf(data: ArrayBuffer): Promise<void>;
    setScale(scale: number): Promise<void>;
    getScale(): number;
    getPageCount(): number;
    setPreviewScale(scale: number): void;
    clearPreviewScale(): void;
    setOnTextSelected(callback: (text: string) => void): void;
    getSelectedText(): string;
    destroy(): void;
}

const pdfjsLib: PDFJsLibrary = pdfjsLibModule as unknown as PDFJsLibrary;

/**
 * Custom PDF Viewer using PDF.js
 * Renders PDF pages with text layer for selection
 */
export class PDFViewerComponent implements IPDFViewer {
    private container: HTMLElement;
    private pdfDoc: PDFDocumentProxy | null = null;
    private currentScale: number = 1.5;
    private pageContainers: Map<number, HTMLElement> = new Map();
    private contextMenu: ContextMenu;
    private onTextSelected: ((text: string) => void) | null = null;
    private workerSrc?: string;
    private revokeWorkerSrc?: boolean;
    private previewScale: number | null = null;
    private renderGeneration: number = 0;
    private inFlightRenderTasks: Map<number, PDFRenderTask> = new Map();
    private backgroundRenderGen: number | null = null;

    constructor(
        container: HTMLElement,
        contextMenuActions: ContextMenuAction[],
        options?: { workerSrc?: string; revokeWorkerSrc?: boolean }
    ) {
        this.container = container;
        this.container.classList.add('pdf-viewer');
        this.workerSrc = options?.workerSrc;
        this.revokeWorkerSrc = options?.revokeWorkerSrc;

        // Create context menu
        this.contextMenu = new ContextMenu(contextMenuActions);

        // Set up right-click handler
        this.container.addEventListener('contextmenu', (e) => this.handleContextMenu(e));

        // Set up selection change handler
        this.container.addEventListener('mouseup', () => this.handleSelectionChange());
    }

    private cancelInFlightRenders(): void {
        for (const task of this.inFlightRenderTasks.values()) {
            try {
                // PDF.js render tasks have cancel()
                if (task && typeof task.cancel === 'function') task.cancel();
            } catch {
                // ignore
            }
        }
        this.inFlightRenderTasks.clear();
    }

    private getScrollContainer(): HTMLElement | null {
        return this.container.querySelector<HTMLElement>('.pdf-scroll-container');
    }

    private getOrderedPageNumbersFromDom(): number[] {
        const sc = this.getScrollContainer();
        if (!sc) return [];
        const els = Array.from(sc.querySelectorAll<HTMLElement>('.pdf-page-container'));
        const nums: number[] = [];
        for (const el of els) {
            const n = Number(el.dataset.pageNumber ?? NaN);
            if (Number.isFinite(n)) nums.push(n);
        }
        nums.sort((a, b) => a - b);
        return nums;
    }

    private getVisiblePageNumbers(bufferPx: number): number[] {
        const sc = this.getScrollContainer();
        if (!sc) return [];

        const viewTop = this.container.scrollTop;
        const viewBottom = viewTop + this.container.clientHeight;
        const topBound = Math.max(0, viewTop - bufferPx);
        const bottomBound = viewBottom + bufferPx;

        const els = Array.from(sc.querySelectorAll<HTMLElement>('.pdf-page-container'));
        const out: number[] = [];
        for (const el of els) {
            const top = el.offsetTop;
            const bottom = top + el.offsetHeight;
            if (bottom < topBound || top > bottomBound) continue;
            const n = Number(el.dataset.pageNumber ?? NaN);
            if (Number.isFinite(n)) out.push(n);
        }
        out.sort((a, b) => a - b);
        return out;
    }

    private scaleExistingPageBoxSizes(factor: number): void {
        const sc = this.getScrollContainer();
        if (!sc) return;
        const els = Array.from(sc.querySelectorAll<HTMLElement>('.pdf-page-container'));
        for (const el of els) {
            const w0 = parseFloat(el.style.width) || el.offsetWidth || 0;
            const h0 = parseFloat(el.style.height) || el.offsetHeight || 0;
            if (w0 > 0) el.setCssStyles({ width: `${w0 * factor}px` });
            if (h0 > 0) el.setCssStyles({ height: `${h0 * factor}px` });
        }
    }

    private async renderPageIntoContainer(pageNum: number, generation: number): Promise<void> {
        if (!this.pdfDoc) return;
        if (generation !== this.renderGeneration) return;

        const sc = this.getScrollContainer();
        if (!sc) return;

        const pageContainer = this.pageContainers.get(pageNum) ??
            sc.querySelector<HTMLElement>(`.pdf-page-container[data-page-number="${pageNum}"]`);
        if (!pageContainer) return;
        this.pageContainers.set(pageNum, pageContainer);

        const page: PDFPageProxy = await this.pdfDoc.getPage(pageNum);
        if (generation !== this.renderGeneration) return;

        const viewport = page.getViewport({ scale: this.currentScale });
        pageContainer.setCssStyles({ width: `${viewport.width}px`, height: `${viewport.height}px` });

        const highlightLayer = pageContainer.querySelector<HTMLElement>('.pdf-highlight-layer');
        const oldCanvases = Array.from(pageContainer.querySelectorAll('.pdf-page-canvas'));
        const oldTextLayers = Array.from(pageContainer.querySelectorAll('.pdf-text-layer'));

        const canvas = document.createElement('canvas');
        canvas.className = 'pdf-page-canvas';
        const context = canvas.getContext('2d');
        if (!context) return;

        canvas.width = viewport.width;
        canvas.height = viewport.height;

        // Render the page to canvas (cancellable best-effort).
        const renderTask = page.render({ canvasContext: context, viewport });
        this.inFlightRenderTasks.set(pageNum, renderTask);
        try {
            if (renderTask?.promise) {
                await renderTask.promise;
            } else {
                // Older PDF.js may return a promise directly
                await (renderTask as PDFRenderTask | Promise<void>);
            }
        } catch {
            // cancelled or failed; ignore if superseded
            if (generation !== this.renderGeneration) return;
            return;
        } finally {
            // Only delete if this task is still the current one for this page.
            const cur = this.inFlightRenderTasks.get(pageNum);
            if (cur === renderTask) this.inFlightRenderTasks.delete(pageNum);
        }
        if (generation !== this.renderGeneration) return;

        // Swap in new layers atomically-ish: remove old after new is ready, preserving highlight layer.
        for (const el of oldCanvases) {
            try { el.remove(); } catch { /* ignore */ }
        }
        if (highlightLayer) {
            pageContainer.insertBefore(canvas, highlightLayer);
        } else {
            pageContainer.appendChild(canvas);
        }

        const textLayerDiv = document.createElement('div');
        textLayerDiv.className = 'pdf-text-layer';
        const textContent = await page.getTextContent();
        if (generation !== this.renderGeneration) return;
        await this.renderTextLayer(textLayerDiv, textContent, viewport);
        if (generation !== this.renderGeneration) return;

        for (const el of oldTextLayers) {
            try { el.remove(); } catch { /* ignore */ }
        }
        if (highlightLayer) {
            pageContainer.insertBefore(textLayerDiv, highlightLayer);
        } else {
            pageContainer.appendChild(textLayerDiv);
        }
    }

    private async renderPagesWithConcurrency(
        pages: number[],
        generation: number,
        concurrency: number
    ): Promise<void> {
        if (!pages.length) return;
        const limit = Math.max(1, Math.floor(concurrency));
        let idx = 0;

        const worker = async () => {
            while (true) {
                if (generation !== this.renderGeneration) return;
                const nextIdx = idx;
                idx += 1;
                if (nextIdx >= pages.length) return;
                const pageNum = pages[nextIdx];
                await this.renderPageIntoContainer(pageNum, generation);
            }
        };

        const workers = Array.from({ length: Math.min(limit, pages.length) }, () => worker());
        await Promise.all(workers);
    }

    private scheduleBackgroundRender(pages: number[], generation: number, concurrency: number): void {
        if (!pages.length) return;
        this.backgroundRenderGen = generation;

        const run = async () => {
            // If superseded, bail.
            if (generation !== this.renderGeneration) return;
            await this.renderPagesWithConcurrency(pages, generation, concurrency);
        };

        // Prefer idle time if available; fall back to setTimeout.
        if (typeof window.requestIdleCallback === 'function') {
            window.requestIdleCallback(() => { void run(); });
        } else {
            window.setTimeout(() => { void run(); }, 0);
        }
    }

    /**
     * Apply a temporary visual-only zoom (CSS transform) without re-rendering pages.
     * This is useful for pinch-to-zoom gestures; callers should later call setScale()
     * to re-render at the new scale and then clearPreviewScale().
     */
    setPreviewScale(scale: number): void {
        this.previewScale = scale;
        const scrollContainer = this.container.querySelector<HTMLElement>('.pdf-scroll-container');
        if (!scrollContainer) return;

        const factor = scale / (this.currentScale || 1);
        scrollContainer.setCssStyles({ transformOrigin: '0 0', transform: `scale(${factor})` });
    }

    /**
     * Remove any temporary preview zoom transform.
     */
    clearPreviewScale(): void {
        this.previewScale = null;
        const scrollContainer = this.container.querySelector<HTMLElement>('.pdf-scroll-container');
        if (!scrollContainer) return;
        scrollContainer.setCssStyles({ transform: '', transformOrigin: '' });
    }

    /**
     * Load a PDF from an ArrayBuffer
     */
    async loadPdf(data: ArrayBuffer): Promise<void> {
        try {
            if (this.workerSrc && pdfjsLib?.GlobalWorkerOptions) {
                pdfjsLib.GlobalWorkerOptions.workerSrc = this.workerSrc;
            }
            // Ensure no stale preview transform survives a fresh load.
            this.clearPreviewScale();

            // Clear previous content
            this.container.empty();
            this.pageContainers.clear();

            // Load the PDF document
            const loadingTask = pdfjsLib.getDocument({ data });
            this.pdfDoc = await loadingTask.promise;

            // Create scroll container
            const scrollContainer = document.createElement('div');
            scrollContainer.className = 'pdf-scroll-container';
            this.container.appendChild(scrollContainer);

            // Render all pages
            for (let pageNum = 1; pageNum <= this.pdfDoc.numPages; pageNum++) {
                await this.renderPage(pageNum, scrollContainer);
            }
        } catch (error) {
            console.error('Error loading PDF:', error);
            throw error;
        }
    }

    /**
     * Render a single page
     */
    private async renderPage(pageNum: number, scrollContainer: HTMLElement): Promise<void> {
        if (!this.pdfDoc) return;

        const page = await this.pdfDoc.getPage(pageNum);
        const viewport = page.getViewport({ scale: this.currentScale });

        // Create page container
        const pageContainer = document.createElement('div');
        pageContainer.className = 'pdf-page-container';
        pageContainer.setCssStyles({ width: `${viewport.width}px`, height: `${viewport.height}px` });
        pageContainer.dataset.pageNumber = String(pageNum);
        this.pageContainers.set(pageNum, pageContainer);

        // Create canvas for rendering
        const canvas = document.createElement('canvas');
        canvas.className = 'pdf-page-canvas';
        const context = canvas.getContext('2d');
        if (!context) return;

        canvas.width = viewport.width;
        canvas.height = viewport.height;

        // Render the page to canvas
        await page.render({
            canvasContext: context,
            viewport: viewport
        }).promise;

        pageContainer.appendChild(canvas);

        // Create text layer for selection
        const textLayerDiv = document.createElement('div');
        textLayerDiv.className = 'pdf-text-layer';

        // Get text content
        const textContent = await page.getTextContent();

        // Render text layer
        await this.renderTextLayer(textLayerDiv, textContent, viewport);

        pageContainer.appendChild(textLayerDiv);
        scrollContainer.appendChild(pageContainer);
    }

    /**
     * Render the text layer for a page
     */
    private async renderTextLayer(
        container: HTMLElement,
        textContent: TextContent,
        viewport: PageViewport,
    ): Promise<void> {
        // Use PDF.js built-in text layer renderer for correct positioning/selection.
        container.innerHTML = '';
        container.classList.add('textLayer');

        if (typeof pdfjsLib.renderTextLayer === 'function') {
            const task = pdfjsLib.renderTextLayer({
                textContent,
                container,
                viewport,
                textDivs: [],
                enhanceTextSelection: true,
            });
            // pdfjs-dist@2 returns { promise }
            if (task?.promise) await task.promise;
            return;
        }

        // Fallback: keep our simple renderer if renderTextLayer isn't available.
        for (const item of textContent.items) {
            if ('str' in item) {
                const textItem = item as PDFTextItem;
                if (!textItem.str) continue;
                const span = document.createElement('span');
                span.textContent = textItem.str;
                const tx = pdfjsLib.Util.transform(viewport.transform, textItem.transform);
                const fontHeight = Math.sqrt((tx[2] * tx[2]) + (tx[3] * tx[3]));
                const left = tx[4];
                const top = tx[5] - fontHeight;
                span.setCssStyles({
                    left: `${left}px`,
                    top: `${top}px`,
                    fontSize: `${fontHeight}px`,
                    fontFamily: textItem.fontName || 'sans-serif',
                });
                container.appendChild(span);
            }
        }
    }

    /**
     * Handle right-click context menu
     */
    private handleContextMenu(e: MouseEvent): void {
        const selectedText = this.getSelectedText();
        if (selectedText) {
            e.preventDefault();
            this.contextMenu.show(e.clientX, e.clientY, selectedText);
        }
    }

    /**
     * Handle text selection changes
     */
    private handleSelectionChange(): void {
        const selectedText = this.getSelectedText();
        if (selectedText && this.onTextSelected) {
            this.onTextSelected(selectedText);
        }
    }

    /**
     * Get currently selected text
     */
    getSelectedText(): string {
        const selection = window.getSelection();
        if (!selection || selection.isCollapsed) return '';

        // Check if selection is within our container
        const anchorNode = selection.anchorNode;
        if (anchorNode && this.container.contains(anchorNode)) {
            return selection.toString().trim();
        }

        return '';
    }

    /**
     * Set callback for text selection
     */
    setOnTextSelected(callback: (text: string) => void): void {
        this.onTextSelected = callback;
    }

    /**
     * Set zoom level
     */
    async setScale(scale: number): Promise<void> {
        if (scale === this.currentScale || !this.pdfDoc) return;
        // A real re-render should always happen from a clean visual state.
        this.clearPreviewScale();

        const prevScale = this.currentScale;
        this.currentScale = scale;

        // Cancel any in-flight renders from a previous scale and bump generation.
        this.renderGeneration += 1;
        const generation = this.renderGeneration;
        this.cancelInFlightRenders();

        const sc = this.getScrollContainer();
        if (!sc) return;

        // Keep scroll geometry stable by scaling existing page boxes immediately.
        // This makes downstream overlays (comments/highlights) re-align sooner once the caller re-renders them.
        const factor = prevScale ? (scale / prevScale) : 1;
        if (Number.isFinite(factor) && factor > 0) {
            this.scaleExistingPageBoxSizes(factor);
        }

        // Phase 1: render visible pages first (fast path)
        const visible = this.getVisiblePageNumbers(600);
        const all = this.getOrderedPageNumbersFromDom();
        const visibleSet = new Set<number>(visible);
        const remaining = all.filter((n) => !visibleSet.has(n));

        // If we somehow don't have DOM pages yet, fall back to the original full render.
        if (!all.length) {
            sc.innerHTML = '';
            this.pageContainers.clear();
            for (let pageNum = 1; pageNum <= this.pdfDoc.numPages; pageNum++) {
                if (generation !== this.renderGeneration) return;
                await this.renderPage(pageNum, sc);
            }
            return;
        }

        // Render visible pages with small concurrency (keeps UI responsive)
        await this.renderPagesWithConcurrency(visible.length ? visible : all.slice(0, 2), generation, 2);
        if (generation !== this.renderGeneration) return;

        // Phase 2: render the rest in the background (do not await)
        this.scheduleBackgroundRender(remaining, generation, 2);
    }

    /**
     * Get current scale
     */
    getScale(): number {
        return this.currentScale;
    }

    /**
     * Get number of pages
     */
    getPageCount(): number {
        return this.pdfDoc?.numPages ?? 0;
    }

    /**
     * Clean up resources
     */
    destroy(): void {
        this.contextMenu.hide();
        this.clearPreviewScale();
        // Cancel any ongoing work
        this.renderGeneration += 1;
        this.cancelInFlightRenders();
        if (this.pdfDoc) {
            this.pdfDoc.destroy();
            this.pdfDoc = null;
        }
        this.pageContainers.clear();

        if (this.revokeWorkerSrc && this.workerSrc?.startsWith('blob:')) {
            try { URL.revokeObjectURL(this.workerSrc); } catch { /* ignore */ }
        }
    }
}
