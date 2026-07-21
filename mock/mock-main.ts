/**
 * Standalone browser harness for the PDF Commenter viewer.
 *
 * It reproduces the plugin's DOM skeleton and drives the REAL PDFViewerComponent
 * from pdf-viewer.ts, so layout/scroll/zoom behaviour observed here is the
 * behaviour the plugin has. Comment markers are faked (plain text instead of
 * MarkdownRenderer) but positioned with the same greedy collision sweep used by
 * view.ts renderCommentMarkers().
 */
import './obsidian-shim';
import { PDFViewerComponent } from '../pdf-viewer';

const MARKER_GAP = 10;

type MockAnnotation = {
    id: string;
    pageNumber: number;
    yNorm: number;
    text: string;
};

const LOREM = [
    'Short note.',
    'This comment is a little longer and will wrap onto two or three lines once the pane gets narrow enough to matter.',
    'A much longer comment intended to stress the collision layout: it should occupy a tall card, pushing subsequent markers downward and revealing whether the greedy sweep reflows correctly when the pane width changes and the text rewraps to a different number of lines.',
    'Medium length remark about the paragraph above.',
    'Another one.',
    'Comments anchored close together on the same page are the interesting case for collision prevention, because their ideal tops are only a few pixels apart.',
];

function buildAnnotations(pageCount: number): MockAnnotation[] {
    const out: MockAnnotation[] = [];
    let n = 0;
    const spec: Array<[number, number]> = [
        [1, 0.12], [1, 0.18], [1, 0.22], [1, 0.65],
        [2, 0.3], [2, 0.34], [3, 0.5], [4, 0.2], [4, 0.8],
    ];
    for (const [page, yNorm] of spec) {
        if (page > pageCount) continue;
        out.push({
            id: `mock-${n}`,
            pageNumber: page,
            yNorm,
            text: LOREM[n % LOREM.length],
        });
        n += 1;
    }
    return out;
}

class MockHarness {
    private root: HTMLElement;
    private pdfContainer!: HTMLElement;
    private commentsPane!: HTMLElement;
    private commentsTrack!: HTMLElement;
    private viewerRow!: HTMLElement;
    private resizer!: HTMLElement;
    private zoomLabel!: HTMLElement;
    private statsEl!: HTMLElement;
    private viewer: PDFViewerComponent | null = null;
    private annotations: MockAnnotation[] = [];
    private selectedId: string | null = null;
    private isSyncingScroll = false;
    private isZooming = false;

    constructor(root: HTMLElement) {
        this.root = root;
        this.buildDom();
    }

    private buildDom(): void {
        const container = this.root;
        container.classList.add('pdf-view-container');

        const controls = container.createDiv({ cls: 'controls-section' });
        const header = controls.createDiv({ cls: 'pdf-header-row' });
        header.createEl('h2', { text: 'Mock viewer (real PDFViewerComponent)' });

        const zoomRow = controls.createDiv({ cls: 'zoom-controls' });
        const zoomOut = zoomRow.createEl('button', { text: '−', cls: 'zoom-btn' });
        this.zoomLabel = zoomRow.createSpan({ text: '150%', cls: 'zoom-label' });
        const zoomIn = zoomRow.createEl('button', { text: '+', cls: 'zoom-btn' });
        this.statsEl = zoomRow.createSpan({ cls: 'mock-stats' });

        this.viewerRow = container.createDiv({ cls: 'pdf-viewer-row' });
        this.pdfContainer = this.viewerRow.createDiv({ cls: 'pdf-viewer-container' });
        this.resizer = this.viewerRow.createDiv({ cls: 'pdf-pane-resizer' });
        this.commentsPane = this.viewerRow.createDiv({ cls: 'pdf-comments-pane' });
        this.commentsTrack = this.commentsPane.createDiv({ cls: 'pdf-comments-track' });

        zoomOut.addEventListener('click', () => void this.stepZoom(-0.25));
        zoomIn.addEventListener('click', () => void this.stepZoom(0.25));

        this.wireScrollSync();
        this.wirePinchZoom();
        this.wireResizer();
        this.observePaneWidth();

        window.addEventListener('resize', () => this.updateStats());
    }

    private wireScrollSync(): void {
        const sync = (from: 'pdf' | 'comments') => {
            if (this.isSyncingScroll) return;
            this.isSyncingScroll = true;
            try {
                if (from === 'pdf') this.commentsPane.scrollTop = this.pdfContainer.scrollTop;
                else this.pdfContainer.scrollTop = this.commentsPane.scrollTop;
            } finally {
                this.isSyncingScroll = false;
            }
        };
        this.pdfContainer.addEventListener('scroll', () => { sync('pdf'); this.updateStats(); }, { passive: true });
        this.commentsPane.addEventListener('scroll', () => sync('comments'), { passive: true });
    }

    /** Port of view.ts pinch handling: CSS-transform preview, debounced commit. */
    private wirePinchZoom(): void {
        let pinchTargetScale: number | null = null;
        let pinchCommitTimer: number | null = null;
        const clampScale = (s: number) => Math.max(0.5, Math.min(3, s));

        const anchorByScroll = () => {
            const A = this.pdfContainer.clientHeight / 2;
            const centerY = this.pdfContainer.scrollTop + A;
            const pages = Array.from(this.pdfContainer.querySelectorAll<HTMLElement>('.pdf-page-container'));
            for (const pageEl of pages) {
                const top = pageEl.offsetTop;
                if (centerY < top || centerY > top + pageEl.offsetHeight) continue;
                if (!pageEl.offsetHeight) continue;
                const pageNumber = Number(pageEl.dataset.pageNumber ?? NaN);
                if (!Number.isFinite(pageNumber)) continue;
                return { pageNumber, yNorm: Math.max(0, Math.min(1, (centerY - top) / pageEl.offsetHeight)) };
            }
            return null;
        };

        const restoreAnchor = (anchor: { pageNumber: number; yNorm: number } | null) => {
            if (!anchor) return;
            const pageEl = this.pdfContainer.querySelector<HTMLElement>(
                `.pdf-page-container[data-page-number="${anchor.pageNumber}"]`
            );
            if (!pageEl) return;
            const next = pageEl.offsetTop + anchor.yNorm * pageEl.offsetHeight - this.pdfContainer.clientHeight / 2;
            if (Number.isFinite(next)) this.pdfContainer.scrollTop = Math.max(0, next);
        };

        this.pdfContainer.addEventListener('wheel', (e: WheelEvent) => {
            if (!e.ctrlKey || !this.viewer) return;
            e.preventDefault();
            if (this.isZooming) return;

            const currentScale = this.viewer.getScale();
            const base = pinchTargetScale ?? currentScale;
            const next = clampScale(base * Math.exp(-e.deltaY * 0.002));
            pinchTargetScale = next;

            const oldF = base / (currentScale || 1);
            const newF = next / (currentScale || 1);
            if (oldF > 0 && newF > 0) {
                const A = this.pdfContainer.clientHeight / 2;
                const nextScrollTop = this.pdfContainer.scrollTop + A * (1 / oldF - 1 / newF);
                if (Number.isFinite(nextScrollTop)) this.pdfContainer.scrollTop = Math.max(0, nextScrollTop);
            }

            this.viewer.setPreviewScale(next);
            this.zoomLabel.textContent = `${Math.round(next * 100)}%`;
            this.updateStats();

            if (pinchCommitTimer) window.clearTimeout(pinchCommitTimer);
            pinchCommitTimer = window.setTimeout(() => {
                void (async () => {
                    if (!this.viewer || pinchTargetScale == null) return;
                    const anchor = anchorByScroll();
                    try {
                        this.isZooming = true;
                        await this.viewer.setScale(pinchTargetScale);
                        this.viewer.clearPreviewScale();
                        restoreAnchor(anchor);
                        this.zoomLabel.textContent = `${Math.round(this.viewer.getScale() * 100)}%`;
                    } finally {
                        this.isZooming = false;
                        this.updateCommentsTrackHeight();
                        this.renderCommentMarkers();
                        pinchTargetScale = null;
                        this.updateStats();
                    }
                })();
            }, 160);
        }, { passive: false });
    }

    /** Prototype of the draggable comments-pane divider (todo item 3). */
    private wireResizer(): void {
        const MIN_PANE = 280;
        let dragging = false;
        let moved = false;
        let rafId: number | null = null;

        const widthFromClientX = (clientX: number): number => {
            const rowRect = this.viewerRow.getBoundingClientRect();
            const raw = rowRect.right - clientX;
            const max = Math.max(MIN_PANE, rowRect.width * 0.6);
            return Math.round(Math.max(MIN_PANE, Math.min(max, raw)));
        };

        this.resizer.addEventListener('pointerdown', (e: PointerEvent) => {
            dragging = true;
            moved = false;
            this.resizer.setPointerCapture(e.pointerId);
            this.resizer.classList.add('is-dragging');
            e.preventDefault();
        });

        this.resizer.addEventListener('pointermove', (e: PointerEvent) => {
            if (!dragging) return;
            moved = true;
            this.setPaneWidth(widthFromClientX(e.clientX));
            if (rafId != null) return;
            rafId = requestAnimationFrame(() => {
                rafId = null;
                this.repositionMarkers();
                this.updateStats();
            });
        });

        const end = (e: PointerEvent) => {
            if (!dragging) return;
            dragging = false;
            try { this.resizer.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
            this.resizer.classList.remove('is-dragging');
            if (!moved) return;
            this.updateCommentsTrackHeight();
            this.repositionMarkers();
            this.updateStats();
        };
        this.resizer.addEventListener('pointerup', end);
        this.resizer.addEventListener('pointercancel', end);

        this.resizer.addEventListener('dblclick', () => {
            this.commentsPane.style.flex = '';
            this.commentsPane.style.width = '';
            this.updateCommentsTrackHeight();
            this.repositionMarkers();
            this.updateStats();
        });
    }

    /** Mirrors view.ts observeCommentsPaneWidth(). */
    private observePaneWidth(): void {
        let lastWidth = this.commentsPane.clientWidth;
        let rafId: number | null = null;
        const ro = new ResizeObserver(() => {
            const w = this.commentsPane.clientWidth;
            if (w === lastWidth) return;
            lastWidth = w;
            if (rafId != null) return;
            rafId = requestAnimationFrame(() => {
                rafId = null;
                this.repositionMarkers();
                this.updateStats();
            });
        });
        ro.observe(this.commentsPane);
    }

    setPaneWidth(px: number): void {
        this.commentsPane.style.flex = `0 0 ${px}px`;
        this.commentsPane.style.width = `${px}px`;
    }

    private async stepZoom(delta: number): Promise<void> {
        if (!this.viewer) return;
        const next = Math.max(0.5, Math.min(3, this.viewer.getScale() + delta));
        this.isZooming = true;
        try {
            await this.viewer.setScale(next);
            this.zoomLabel.textContent = `${Math.round(next * 100)}%`;
        } finally {
            this.isZooming = false;
            this.updateCommentsTrackHeight();
            this.renderCommentMarkers();
            this.updateStats();
        }
    }

    async setScale(scale: number): Promise<void> {
        if (!this.viewer) return;
        this.isZooming = true;
        try {
            await this.viewer.setScale(scale);
            this.zoomLabel.textContent = `${Math.round(scale * 100)}%`;
        } finally {
            this.isZooming = false;
            this.updateCommentsTrackHeight();
            this.renderCommentMarkers();
            this.updateStats();
        }
    }

    /** Timings for the scroll-smoothness diagnosis (todo item 4). */
    timing: Record<string, number> = {};

    async load(url: string): Promise<void> {
        const tFetch = performance.now();
        const res = await fetch(url);
        const data = await res.arrayBuffer();
        this.timing.fetchMs = Math.round(performance.now() - tFetch);
        this.viewer = new PDFViewerComponent(this.pdfContainer, [], { workerSrc: './pdf.worker.js' });
        const tRender = performance.now();
        // loadPdf() renders EVERY page before it resolves; nothing is interactive until then.
        await this.viewer.loadPdf(data);
        this.timing.eagerRenderAllPagesMs = Math.round(performance.now() - tRender);
        this.timing.pageCount = this.viewer.getPageCount();
        this.annotations = buildAnnotations(this.viewer.getPageCount());
        this.updateCommentsTrackHeight();
        this.renderCommentMarkers();
        this.updateStats();
    }

    private updateCommentsTrackHeight(): void {
        this.commentsTrack.style.height = `${this.pdfContainer.scrollHeight}px`;
    }

    /** Mirrors view.ts renderCommentMarkers() layout maths with fake content. */
    renderCommentMarkers(): void {
        this.commentsTrack.empty();
        const items: { ann: MockAnnotation; idealTop: number; el: HTMLElement }[] = [];
        for (const a of this.annotations) {
            const pageEl = this.pdfContainer.querySelector<HTMLElement>(
                `.pdf-page-container[data-page-number="${a.pageNumber}"]`
            );
            if (!pageEl) continue;
            items.push({ ann: a, idealTop: pageEl.offsetTop + a.yNorm * pageEl.offsetHeight, el: null! });
        }
        items.sort((a, b) => a.idealTop - b.idealTop);

        for (const item of items) {
            const marker = this.commentsTrack.createDiv({ cls: 'pdf-comment-marker' });
            const isSelected = item.ann.id === this.selectedId;
            if (!isSelected) marker.classList.add('is-collapsed');
            marker.classList.toggle('is-selected', isSelected);
            marker.dataset.annotationId = item.ann.id;
            const preview = marker.createDiv({ cls: 'pdf-comment-preview' });
            preview.textContent = item.ann.text;
            marker.addEventListener('click', () => {
                this.selectedId = this.selectedId === item.ann.id ? null : item.ann.id;
                this.renderCommentMarkers();
            });
            item.el = marker;
        }

        let nextAvailableTop = 0;
        for (const item of items) {
            const placedTop = Math.max(item.idealTop, nextAvailableTop);
            item.el.style.top = `${placedTop}px`;
            nextAvailableTop = placedTop + item.el.offsetHeight + MARKER_GAP;
        }
        if (nextAvailableTop > this.pdfContainer.scrollHeight) {
            this.commentsTrack.style.height = `${nextAvailableTop}px`;
        }
    }

    /** Mirrors view.ts repositionMarkers(): re-measure heights, re-run the sweep. */
    repositionMarkers(): void {
        const markers = Array.from(this.commentsTrack.querySelectorAll<HTMLElement>('.pdf-comment-marker'));
        const positioned: { el: HTMLElement; idealTop: number }[] = [];
        for (const marker of markers) {
            const ann = this.annotations.find(a => a.id === marker.dataset.annotationId);
            if (!ann) continue;
            const pageEl = this.pdfContainer.querySelector<HTMLElement>(
                `.pdf-page-container[data-page-number="${ann.pageNumber}"]`
            );
            if (!pageEl) continue;
            positioned.push({ el: marker, idealTop: pageEl.offsetTop + ann.yNorm * pageEl.offsetHeight });
        }
        positioned.sort((a, b) => a.idealTop - b.idealTop);

        let nextAvailableTop = 0;
        for (const { el, idealTop } of positioned) {
            const placedTop = Math.max(idealTop, nextAvailableTop);
            el.style.top = `${placedTop}px`;
            nextAvailableTop = placedTop + el.offsetHeight + MARKER_GAP;
        }
        if (nextAvailableTop > this.pdfContainer.scrollHeight) {
            this.commentsTrack.style.height = `${nextAvailableTop}px`;
        }
    }

    /** Geometry snapshot used to verify the horizontal-scroll fix (todo item 2). */
    measure(): Record<string, number | boolean | string> {
        const page = this.pdfContainer.querySelector<HTMLElement>('.pdf-page-container');
        const sc = this.pdfContainer.querySelector<HTMLElement>('.pdf-scroll-container');
        const pageW = page?.offsetWidth ?? 0;
        const clientW = this.pdfContainer.clientWidth;
        const scrollW = this.pdfContainer.scrollWidth;
        return {
            scale: this.viewer?.getScale() ?? 0,
            pageWidth: pageW,
            containerClientWidth: clientW,
            containerScrollWidth: scrollW,
            // How much horizontal scroll range exists beyond the paper itself.
            overflowBeyondPage: Math.max(0, scrollW - Math.max(pageW, clientW)),
            maxScrollLeft: Math.max(0, scrollW - clientW),
            pageWiderThanViewport: pageW > clientW,
            scrollContainerTransform: sc ? getComputedStyle(sc).transform : 'none',
            commentsPaneWidth: this.commentsPane.offsetWidth,
            markerOverlaps: this.countMarkerOverlaps(),
        };
    }

    /** 0 means the collision sweep is holding. */
    countMarkerOverlaps(): number {
        const markers = Array.from(this.commentsTrack.querySelectorAll<HTMLElement>('.pdf-comment-marker'));
        const boxes = markers
            .map(m => ({ top: parseFloat(m.style.top) || 0, h: m.offsetHeight }))
            .sort((a, b) => a.top - b.top);
        let overlaps = 0;
        for (let i = 1; i < boxes.length; i++) {
            if (boxes[i].top < boxes[i - 1].top + boxes[i - 1].h) overlaps += 1;
        }
        return overlaps;
    }

    private updateStats(): void {
        const m = this.measure();
        this.statsEl.textContent =
            `page ${m.pageWidth}px | client ${m.containerClientWidth}px | scrollW ${m.containerScrollWidth}px | ` +
            `dead space ${m.overflowBeyondPage}px | overlaps ${m.markerOverlaps}`;
    }
}

const harness = new MockHarness(document.body.createDiv({ cls: 'mock-root' }));
(window as unknown as Record<string, unknown>).mock = harness;
void harness.load('./test.pdf');
