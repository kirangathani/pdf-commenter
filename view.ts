import { FileView, WorkspaceLeaf, TFile, TFolder, MarkdownRenderer, normalizePath, FileSystemAdapter } from 'obsidian';
import { WikilinkSuggest } from './wikilink-suggest';
import { ContextMenuAction } from './context-menu';
import type { IPDFViewer } from './pdf-viewer';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import inlinedWorkerCode from 'virtual:pdf-worker';

export const VIEW_TYPE_PDF_COMMENTER = 'pdf-commenter-view';

type NormalizedRect = { x: number; y: number; w: number; h: number }; // 0..1 relative to page box
type PageRects = { pageNumber: number; rects: NormalizedRect[] };
type PdfAnnotation = {
    id: string;
    createdAt: number;
    selectedText: string;
    // Back-compat: older sidecars may have inline commentText. New flow uses notePath.
    commentText?: string;
    notePath?: string; // vault path to markdown note backing this comment
    anchor: { pageNumber: number; yNorm: number };
    highlights: PageRects[];
};
type PdfAnnotationsFile = {
    version: 1;
    pdfPath: string;
    annotations: PdfAnnotation[];
};

// Narrow interface for accessing internal Obsidian app properties
interface ObsidianAppInternal {
    plugins?: {
        plugins?: Record<string, { manifest?: { dir?: string } }>;
    };
}

function normalizePluginDir(input: string): string {
    // Handle values like:
    // - "magnifying-glass"
    // - ".obsidian/plugins/magnifying-glass"
    // - ".obsidian\\plugins\\magnifying-glass"
    const s = String(input ?? '').replace(/\\/g, '/');
    const parts = s.split('/').filter(Boolean);
    return parts.length ? parts[parts.length - 1] : s;
}

function createPdfJsWorkerBlobUrl(pluginDir: string, basePath: string | undefined, configDir: string): string | undefined {
    // Desktop-only: use Node fs to read the worker file from the plugin folder and create a blob URL.
    try {
        if (!basePath) {
            console.warn('[pdf-worker] basePath is undefined');
            return undefined;
        }

        const normalizedDir = normalizePluginDir(pluginDir);
        const workerPath = join(basePath, configDir, 'plugins', normalizedDir, 'pdf.worker.js');
        if (!existsSync(workerPath)) {
            console.warn('[pdf-worker] worker not found at', workerPath);
            return undefined;
        }

        const workerCode = readFileSync(workerPath, 'utf8');
        // Use a blob URL to avoid CORS restrictions from `app://obsidian.md` when loading module workers.
        const blob = new Blob([workerCode], { type: 'text/javascript' });
        return URL.createObjectURL(blob);
    } catch (e) {
        console.warn('[pdf-worker] failed to build workerSrc:', e);
        return undefined;
    }
}

function resolvePdfWorkerSrc(
    pluginDirCandidates: string[],
    basePath: string | undefined,
    configDir: string
): string | undefined {
    for (const dir of pluginDirCandidates) {
        if (!dir) continue;
        const src = createPdfJsWorkerBlobUrl(dir, basePath, configDir);
        if (src) return src;
    }
    return undefined;
}

// Lazy load PDF viewer to avoid import issues
let PDFViewerComponentCtor: (typeof import('./pdf-viewer'))['PDFViewerComponent'] | null = null;
async function getPDFViewerComponent() {
    if (!PDFViewerComponentCtor) {
        const module = await import('./pdf-viewer');
        PDFViewerComponentCtor = module.PDFViewerComponent;
    }
    return PDFViewerComponentCtor;
}

export class PdfCommenterView extends FileView {
    private pdfContainer: HTMLElement;
    private pdfViewer: IPDFViewer | null = null;
    private controlsSection: HTMLElement;
    private viewerRow: HTMLElement;
    private commentsPane: HTMLElement;
    private commentsTrack: HTMLElement;
    private annotations: PdfAnnotation[] = [];
    private currentPdfCommentsFolder: string | null = null;
    private isSyncingScroll = false;
    private pluginId: string;
    private pluginDir: string;

    private selectedAnnotationId: string | null = null;
    private activeInlineTextarea: HTMLTextAreaElement | null = null;
    private activeInlineSave: (() => Promise<void>) | null = null;
    private activeInlineDirty: boolean = false;
    private inlineKeyHandler: ((e: KeyboardEvent) => void) | null = null;
    private pendingFocusAnnotationId: string | null = null;
    private pendingNoteCreation: Map<string, Promise<TFile>> = new Map();
    private deselectHandler: ((e: MouseEvent) => void) | null = null;
    private pinchWheelHandler: ((e: WheelEvent) => void) | null = null;
    private activeWikilinkSuggest: WikilinkSuggest | null = null;

    // Undo stack for deferred comment deletion
    private deleteUndoStack: { annotation: PdfAnnotation; index: number; timer: ReturnType<typeof setTimeout> }[] = [];
    private undoKeyHandler: ((e: KeyboardEvent) => void) | null = null;
    private activeToast: HTMLElement | null = null;

    // Promoted from onOpen locals so onLoadFile can access them
    private titleEl: HTMLHeadingElement;
    private zoomLabel: HTMLSpanElement;
    private zoomOutBtn: HTMLButtonElement;
    private zoomInBtn: HTMLButtonElement;
    private isLoadingPdf = false;
    private isZooming = false;
    private renderGeneration = 0;

    // Search state
    private searchBar: HTMLElement | null = null;
    private searchInput: HTMLInputElement | null = null;
    private searchMatchLabel: HTMLSpanElement | null = null;
    private searchMatches: { source: 'pdf' | 'comment'; pageNumber: number }[] = [];
    private searchCurrentIdx = -1;
    private searchHighlightEls: HTMLElement[] = [];

    constructor(leaf: WorkspaceLeaf, opts: { pluginId: string; pluginDir: string }) {
        super(leaf);
        this.pluginId = opts.pluginId;
        this.pluginDir = opts.pluginDir;
    }

    getViewType(): string {
        return VIEW_TYPE_PDF_COMMENTER;
    }

    getDisplayText(): string {
        return this.file?.basename ?? 'PDF viewer';
    }

    canAcceptExtension(extension: string): boolean {
        return extension === 'pdf';
    }

    private getContextMenuActions(): ContextMenuAction[] {
        return [
            {
                id: 'copy',
                label: 'Copy',
                icon: '📋',
                callback: (text: string) => {
                    void navigator.clipboard.writeText(text);
                }
            },
            {
                id: 'comment',
                label: 'Comment',
                icon: '💬',
                callback: (text: string) => {
                    // Fire-and-forget; the context menu callback is sync
                    void this.handleCommentAction(text, { focusEditor: true });
                }
            },
            {
                id: 'copy-to-note',
                label: 'Copy to active note',
                icon: '📝',
                callback: (text: string) => {
                    void this.copyToActiveNote(text);
                }
            },
            {
                id: 'create-note',
                label: 'Create note from selection',
                icon: '➕',
                callback: (text: string) => {
                    void this.createNoteFromSelection(text);
                }
            }
        ];
    }

    private async copyToActiveNote(text: string): Promise<void> {
        const activeFile = this.app.workspace.getActiveFile();
        if (activeFile && activeFile.extension === 'md') {
            const content = await this.app.vault.read(activeFile);
            await this.app.vault.modify(activeFile, content + '\n\n' + text);
        }
    }

    private async createNoteFromSelection(text: string): Promise<void> {
        const fileName = `PDF Extract ${Date.now()}.md`;
        await this.app.vault.create(fileName, text);
    }

    async onOpen(): Promise<void> {
        await super.onOpen();

        try {
            const container = this.contentEl;
            container.empty();
            container.addClass('pdf-view-container');

            // Create controls section
            this.controlsSection = container.createEl('div', { cls: 'controls-section' });

            // Header with rename support
            const headerRow = this.controlsSection.createEl('div', { cls: 'pdf-header-row' });
            this.titleEl = headerRow.createEl('h2', { text: 'PDF viewer' });
            const renameBtn = headerRow.createEl('button', { cls: 'pdf-rename-btn', attr: { 'aria-label': 'Rename PDF' } });
            renameBtn.innerHTML = '&#9998;'; // pencil icon
            renameBtn.addEventListener('click', () => this.startRename());
            this.titleEl.addEventListener('dblclick', () => this.startRename());

            // Zoom controls
            const zoomContainer = this.controlsSection.createEl('div', { cls: 'zoom-controls' });

            this.zoomOutBtn = zoomContainer.createEl('button', { text: '−', cls: 'zoom-btn' });
            this.zoomLabel = zoomContainer.createEl('span', { text: '150%', cls: 'zoom-label' });
            this.zoomInBtn = zoomContainer.createEl('button', { text: '+', cls: 'zoom-btn' });

            // Initial state (no PDF loaded yet)
            this.updateZoomButtonsState();

            // Viewer row (PDF left + comments right), below the input/controls section
            this.viewerRow = container.createEl('div', { cls: 'pdf-viewer-row' });

            // Create PDF container (left)
            this.pdfContainer = this.viewerRow.createEl('div', { cls: 'pdf-viewer-container' });

            // Search bar overlaid on pdfContainer (hidden by default; recreated after each PDF load)
            this.createSearchBar();

            // Create empty comments pane (right)
            this.commentsPane = this.viewerRow.createEl('div', { cls: 'pdf-comments-pane' });
            this.commentsTrack = this.commentsPane.createEl('div', { cls: 'pdf-comments-track' });

            // Trackpad pinch-to-zoom (typically arrives as Ctrl+wheel on Chromium/Electron).
            // We do a two-phase zoom:
            // - Preview: CSS transform on the rendered pages for smooth feedback (markers may drift during pinch).
            // - Commit: debounce and re-render crisply via pdfViewer.setScale().
            let pinchTargetScale: number | null = null;
            let pinchCommitTimer: number | null = null;
            const clampScale = (s: number) => Math.max(0.5, Math.min(3, s));

            const getViewportCenterAnchor = () => {
                if (!this.pdfContainer) return null;
                const r = this.pdfContainer.getBoundingClientRect();
                const cx = r.left + r.width / 2;
                const cy = r.top + r.height / 2;
                const elAt = document.elementFromPoint(cx, cy) as HTMLElement | null;
                const pageEl = elAt?.closest?.('.pdf-page-container') as HTMLElement | null;
                if (!pageEl) return null;
                const pageRect = pageEl.getBoundingClientRect();
                if (!pageRect.height) return null;
                const pageNumber = Number(pageEl.dataset.pageNumber ?? NaN);
                if (!Number.isFinite(pageNumber)) return null;
                const yNorm = Math.max(0, Math.min(1, (cy - pageRect.top) / pageRect.height));
                return { pageNumber, yNorm };
            };

            // Debug helper: compute anchor using scrollTop math instead of elementFromPoint.
            // This helps diagnose cases where elementFromPoint hits gaps/overlays.
            const getViewportCenterAnchorByScroll = () => {
                if (!this.pdfContainer) return null;
                const A = this.pdfContainer.clientHeight / 2;
                const centerY = this.pdfContainer.scrollTop + A;
                const pages = Array.from(this.pdfContainer.querySelectorAll<HTMLElement>('.pdf-page-container'));
                for (const pageEl of pages) {
                    const top = pageEl.offsetTop;
                    const bottom = top + pageEl.offsetHeight;
                    if (centerY < top || centerY > bottom) continue;
                    const pageNumber = Number(pageEl.dataset.pageNumber ?? NaN);
                    if (!Number.isFinite(pageNumber) || pageEl.offsetHeight === 0) continue;
                    const yNorm = Math.max(0, Math.min(1, (centerY - top) / pageEl.offsetHeight));
                    return { pageNumber, yNorm };
                }
                return null;
            };

            const restoreViewportCenterAnchor = (anchor: { pageNumber: number; yNorm: number } | null) => {
                if (!anchor || !this.pdfContainer) return;
                const pageEl = this.pdfContainer.querySelector<HTMLElement>(
                    `.pdf-page-container[data-page-number="${anchor.pageNumber}"]`
                );
                if (!pageEl) return;
                const A = this.pdfContainer.clientHeight / 2;
                const topPx = pageEl.offsetTop + (anchor.yNorm * pageEl.offsetHeight);
                const nextScrollTop = topPx - A;
                if (Number.isFinite(nextScrollTop)) {
                    this.pdfContainer.scrollTop = Math.max(0, nextScrollTop);
                }
            };

            const schedulePinchCommit = () => {
                if (pinchCommitTimer) window.clearTimeout(pinchCommitTimer);
                pinchCommitTimer = window.setTimeout(() => {
                    void (async () => {
                        if (!this.pdfViewer || pinchTargetScale == null) return;
                        const anchor = getViewportCenterAnchor();
                        const anchorByScroll = getViewportCenterAnchorByScroll();
                        // IMPORTANT: during pinch preview we apply a CSS transform to the scroll container.
                        // `elementFromPoint` operates in transformed (visual) coordinates, while our restore uses
                        // untransformed layout metrics (offsetTop/offsetHeight). Prefer the scroll-based anchor
                        // so the coordinate system matches restoreViewportCenterAnchor.
                        const anchorChosen = anchorByScroll ?? anchor;
                        try {
                            this.isZooming = true;
                            this.updateZoomButtonsState();
                            await this.pdfViewer.setScale(pinchTargetScale);
                            // Ensure we end in a non-preview state
                            this.pdfViewer.clearPreviewScale();
                            // Keep the viewport centered on the same PDF spot after the real layout change.
                            restoreViewportCenterAnchor(anchorChosen);
                            this.zoomLabel.textContent = `${Math.round(this.pdfViewer.getScale() * 100)}%`;
                        } finally {
                            this.isZooming = false;
                            this.updateZoomButtonsState();
                            this.updateCommentsTrackHeight();
                            void this.renderCommentMarkers();
                            this.renderHighlights();
                            pinchTargetScale = null;
                        }
                    })();
                }, 160);
            };
            if (!this.pinchWheelHandler) {
                this.pinchWheelHandler = (e: WheelEvent) => {
                    // On most trackpads, pinch zoom comes through as ctrlKey+wheel.
                    if (!e.ctrlKey) return;
                    if (!this.pdfViewer) return;
                    // Don't fight a committed rerender in progress
                    if (this.isLoadingPdf || this.isZooming) {
                        e.preventDefault();
                        return;
                    }

                    // Consume so Obsidian/global zoom handlers don't interfere.
                    e.preventDefault();
                    e.stopImmediatePropagation();
                    e.stopPropagation();

                    const currentScale = this.pdfViewer.getScale();
                    const base = pinchTargetScale ?? currentScale;

                    // Smooth exponential mapping. deltaY > 0 means "zoom out" on Chromium.
                    const factor = Math.exp(-e.deltaY * 0.002);
                    const next = clampScale(base * factor);
                    pinchTargetScale = next;

                    // Keep viewport center anchored while we change the CSS transform.
                    // Because we are using a CSS transform (not relayout), scroll geometry doesn't change,
                    // so we compensate scrollTop using the transform factors.
                    if (this.pdfContainer) {
                        const oldF = base / (currentScale || 1);
                        const newF = next / (currentScale || 1);
                        if (oldF > 0 && newF > 0) {
                            const A = this.pdfContainer.clientHeight / 2;
                            const S = this.pdfContainer.scrollTop;
                            const nextScrollTop = S + A * (1 / oldF - 1 / newF);
                            if (Number.isFinite(nextScrollTop)) {
                                this.pdfContainer.scrollTop = Math.max(0, nextScrollTop);
                            }
                        }
                    }

                    // Preview zoom (visual only)
                    this.pdfViewer.setPreviewScale(next);
                    this.zoomLabel.textContent = `${Math.round(next * 100)}%`;

                    // Let the user keep pinching; commit after a short pause.
                    schedulePinchCommit();
                };
                // passive:false is required for preventDefault to work
                this.pdfContainer.addEventListener('wheel', this.pinchWheelHandler, { passive: false });
            }

            // Deselect comment when clicking outside comment boxes (in PDF area or blank space in comments pane)
            if (!this.deselectHandler) {
                this.deselectHandler = (e: MouseEvent) => {
                    if (!this.selectedAnnotationId) return;
                    const target = e.target as HTMLElement | null;
                    if (!target) return;

                    // If click is inside any comment marker, let the marker click handler manage selection.
                    if (target.closest?.('.pdf-comment-marker')) return;

                    // If there are unsaved changes in the active inline editor, save first (same as pressing Save)
                    if (this.activeInlineDirty && this.activeInlineSave) {
                        void this.activeInlineSave();
                        return;
                    }

                    // If the comment textarea is empty, delete the annotation instead of leaving a blank comment
                    const deselectId = this.selectedAnnotationId;
                    if (deselectId && this.activeInlineTextarea && !this.activeInlineTextarea.value.trim()) {
                        this.selectedAnnotationId = null;
                        void this.deleteAnnotation(deselectId);
                        return;
                    }

                    this.selectedAnnotationId = null;
                    void this.renderCommentMarkers();
                };
            }
            // Capture phase so it triggers even if inner elements stop propagation.
            this.pdfContainer.addEventListener('mousedown', this.deselectHandler, true);
            this.commentsPane.addEventListener('mousedown', this.deselectHandler, true);

            // Capture Ctrl/Cmd+Enter at window level (before Obsidian hotkeys),
            // but only when our inline comment textarea is focused.
            if (!this.inlineKeyHandler) {
                this.inlineKeyHandler = (e: KeyboardEvent) => {
                    // Ctrl+F: open search bar
                    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === 'f' || e.key === 'F')) {
                        if (this.app.workspace.getActiveViewOfType(PdfCommenterView) === this) {
                            e.preventDefault();
                            e.stopImmediatePropagation();
                            e.stopPropagation();
                            this.openSearchBar();
                            return;
                        }
                    }

                    // Escape: close search bar if open
                    if (e.key === 'Escape' && this.searchBar && !this.searchBar.hasClass('is-hidden')) {
                        if (this.app.workspace.getActiveViewOfType(PdfCommenterView) === this) {
                            e.preventDefault();
                            e.stopImmediatePropagation();
                            e.stopPropagation();
                            this.closeSearchBar();
                            return;
                        }
                    }

                    // Comment shortcut: Ctrl+Alt+M (only when this view is active)
                    const isCommentHotkey =
                        e.ctrlKey &&
                        e.altKey &&
                        !e.shiftKey &&
                        (e.key === 'm' || e.key === 'M' || e.code === 'KeyM');
                    if (isCommentHotkey) {
                        // Only handle if this view is the active view
                        if (this.app.workspace.getActiveViewOfType(PdfCommenterView) !== this) return;
                        const text = window.getSelection()?.toString().trim() ?? '';
                        if (!text) return;
                        e.preventDefault();
                        e.stopImmediatePropagation();
                        e.stopPropagation();
                        void this.handleCommentAction(text, { focusEditor: true });
                        return;
                    }

                    // Delete comment shortcut: Alt+Backspace when a comment is selected
                    if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && (e.key === 'Backspace' || e.code === 'Backspace')) {
                        if (this.selectedAnnotationId && this.app.workspace.getActiveViewOfType(PdfCommenterView) === this) {
                            e.preventDefault();
                            e.stopImmediatePropagation();
                            e.stopPropagation();
                            void this.deleteAnnotation(this.selectedAnnotationId);
                            return;
                        }
                    }

                    // Cycle comments: Alt+D (next) / Alt+Shift+D (prev)
                    if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'd' || e.key === 'D')) {
                        if (this.annotations.length > 0 && this.app.workspace.getActiveViewOfType(PdfCommenterView) === this) {
                            e.preventDefault();
                            e.stopImmediatePropagation();
                            e.stopPropagation();
                            this.cycleComment(e.shiftKey ? -1 : 1);
                            return;
                        }
                    }

                    // Undo deletion: Ctrl/Cmd+Z when no textarea is focused
                    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === 'z' || e.key === 'Z' || e.code === 'KeyZ')) {
                        const isTextareaFocused = this.activeInlineTextarea && document.activeElement === this.activeInlineTextarea;
                        if (!isTextareaFocused && this.deleteUndoStack.length > 0 && this.app.workspace.getActiveViewOfType(PdfCommenterView) === this) {
                            e.preventDefault();
                            e.stopImmediatePropagation();
                            e.stopPropagation();
                            this.undoLastDeletion();
                            return;
                        }
                    }

                    if (!this.activeInlineTextarea || document.activeElement !== this.activeInlineTextarea) return;
                    const isCombo =
                        (e.ctrlKey || e.metaKey) &&
                        (e.key === 'Enter' || e.code === 'Enter' || e.code === 'NumpadEnter');
                    if (!isCombo) return;
                    e.preventDefault();
                    // stop immediately so Obsidian/global handlers don't swallow it
                    e.stopImmediatePropagation();
                    e.stopPropagation();
                    void this.activeInlineSave?.();
                };
                window.addEventListener('keydown', this.inlineKeyHandler, true);
            }

            // Scroll sync so comment markers align with PDF content while scrolling
            const syncScroll = (from: 'pdf' | 'comments') => {
                if (this.isSyncingScroll) return;
                this.isSyncingScroll = true;
                try {
                    if (from === 'pdf') {
                        this.commentsPane.scrollTop = this.pdfContainer.scrollTop;
                    } else {
                        this.pdfContainer.scrollTop = this.commentsPane.scrollTop;
                    }
                } finally {
                    this.isSyncingScroll = false;
                }
            };
            this.pdfContainer.addEventListener('scroll', () => {
                syncScroll('pdf');
                this.updateSearchBarPosition();
            }, { passive: true });
            this.commentsPane.addEventListener('scroll', () => syncScroll('comments'), { passive: true });

            // Zoom handlers
            this.zoomOutBtn.addEventListener('click', () => {
                void (async () => {
                    if (this.pdfViewer) {
                        try {
                            this.isZooming = true;
                            this.updateZoomButtonsState();
                            const newScale = Math.max(0.5, this.pdfViewer.getScale() - 0.25);
                            await this.pdfViewer.setScale(newScale);
                            this.zoomLabel.textContent = `${Math.round(newScale * 100)}%`;
                        } finally {
                            this.isZooming = false;
                            this.updateZoomButtonsState();
                            this.updateCommentsTrackHeight();
                            void this.renderCommentMarkers();
                            this.renderHighlights();
                        }
                    }
                })();
            });

            this.zoomInBtn.addEventListener('click', () => {
                void (async () => {
                    if (this.pdfViewer) {
                        try {
                            this.isZooming = true;
                            this.updateZoomButtonsState();
                            const newScale = Math.min(3, this.pdfViewer.getScale() + 0.25);
                            await this.pdfViewer.setScale(newScale);
                            this.zoomLabel.textContent = `${Math.round(newScale * 100)}%`;
                        } finally {
                            this.isZooming = false;
                            this.updateZoomButtonsState();
                            this.updateCommentsTrackHeight();
                            void this.renderCommentMarkers();
                            this.renderHighlights();
                        }
                    }
                })();
            });

        } catch (error) {
            console.error('PDF Viewer onOpen error:', error);
        }
    }

    private showMessage(text: string, type: 'success' | 'error'): void {
        const msg = this.controlsSection.createEl('p', {
            text,
            cls: `${type}-message`
        });
        setTimeout(() => msg.remove(), 3000);
    }

    private updateZoomButtonsState(): void {
        const enabled = Boolean(this.pdfViewer) && !this.isLoadingPdf && !this.isZooming;
        if (this.zoomOutBtn) this.zoomOutBtn.disabled = !enabled;
        if (this.zoomInBtn) this.zoomInBtn.disabled = !enabled;
    }

    async onClose(): Promise<void> {
        await super.onClose();
        if (this.pdfViewer) {
            this.pdfViewer.destroy();
            this.pdfViewer = null;
        }
        if (this.pinchWheelHandler) {
            try { this.pdfContainer?.removeEventListener('wheel', this.pinchWheelHandler as EventListener); } catch { /* ignore */ }
            this.pinchWheelHandler = null;
        }
        if (this.inlineKeyHandler) {
            window.removeEventListener('keydown', this.inlineKeyHandler, true);
            this.inlineKeyHandler = null;
        }
        if (this.deselectHandler) {
            try { this.pdfContainer?.removeEventListener('mousedown', this.deselectHandler, true); } catch { /* ignore */ }
            try { this.commentsPane?.removeEventListener('mousedown', this.deselectHandler, true); } catch { /* ignore */ }
            this.deselectHandler = null;
        }
        this.activeInlineTextarea = null;
        this.activeInlineSave = null;
        this.activeInlineDirty = false;
        this.pendingFocusAnnotationId = null;
        this.pendingNoteCreation.clear();
        if (this.activeWikilinkSuggest) {
            this.activeWikilinkSuggest.destroy();
            this.activeWikilinkSuggest = null;
        }
        // Commit any pending deletions immediately on close
        for (const entry of this.deleteUndoStack) {
            clearTimeout(entry.timer);
            void this.commitDeletion(entry.annotation.id);
        }
        this.deleteUndoStack = [];
        this.dismissDeleteToast();
    }

    private resolveWorkerSrc(): string | undefined {
        // Prefer the build-time inlined worker (works with BRAT and any install method).
        if (inlinedWorkerCode) {
            try {
                const blob = new Blob([inlinedWorkerCode], { type: 'text/javascript' });
                return URL.createObjectURL(blob);
            } catch (e) {
                console.warn('[pdf-worker] failed to create blob from inlined worker:', e);
            }
        }

        // Fallback: read worker file from disk (works for direct installs / dev mode).
        const adapter = this.app.vault.adapter;
        if (!(adapter instanceof FileSystemAdapter)) return undefined;
        const basePath = adapter.getBasePath();
        const appInternal = this.app as unknown as ObsidianAppInternal;
        const runtimeDir = appInternal?.plugins?.plugins?.[this.pluginId]?.manifest?.dir;
        const candidates: string[] = Array.from(
            new Set([this.pluginDir, runtimeDir, this.pluginId].filter((v): v is string => Boolean(v)))
        );
        const configDir = this.app.vault.configDir;
        return resolvePdfWorkerSrc(candidates, basePath, configDir);
    }

    async onLoadFile(file: TFile): Promise<void> {
        // Update header to show the PDF name
        this.titleEl.textContent = file.basename;

        // Reset state
        this.currentPdfCommentsFolder = null;
        this.annotations = [];
        this.selectedAnnotationId = null;
        void this.renderCommentMarkers();
        this.renderHighlights();

        this.isLoadingPdf = true;
        this.updateZoomButtonsState();

        try {
            const pdfData = await this.app.vault.readBinary(file);

            // Destroy previous viewer
            if (this.pdfViewer) {
                this.pdfViewer.destroy();
            }

            // Create new viewer (lazy loaded)
            const ViewerClass = await getPDFViewerComponent();
            const workerSrc = this.resolveWorkerSrc();
            if (!workerSrc) {
                throw new Error('[pdf-worker] Could not resolve workerSrc');
            }
            this.pdfViewer = new ViewerClass(
                this.pdfContainer,
                this.getContextMenuActions(),
                { workerSrc, revokeWorkerSrc: true }
            );

            await this.pdfViewer.loadPdf(pdfData);
            // Recreate search bar (loadPdf empties pdfContainer, destroying the previous one)
            this.createSearchBar();
            await this.loadAnnotationsForCurrentPdf();
            this.updateCommentsTrackHeight();
            void this.renderCommentMarkers();
            this.renderHighlights();

            this.zoomLabel.textContent = `${Math.round(this.pdfViewer.getScale() * 100)}%`;
        } catch (error: unknown) {
            console.error('Error loading PDF:', error);
            const message = error instanceof Error ? error.message : String(error);
            this.showMessage(`Error: ${message}`, 'error');
            if (this.pdfViewer) {
                try { this.pdfViewer.destroy(); } catch { /* ignore */ }
                this.pdfViewer = null;
            }
        } finally {
            this.isLoadingPdf = false;
            this.updateZoomButtonsState();
            this.updateCommentsTrackHeight();
            void this.renderCommentMarkers();
        }
    }

    async onUnloadFile(file: TFile): Promise<void> {
        await super.onUnloadFile(file);
        if (this.pdfViewer) {
            this.pdfViewer.destroy();
            this.pdfViewer = null;
        }
        this.annotations = [];
        this.selectedAnnotationId = null;
        this.currentPdfCommentsFolder = null;
        this.activeInlineTextarea = null;
        this.activeInlineSave = null;
        this.activeInlineDirty = false;
        this.pendingFocusAnnotationId = null;
        this.pendingNoteCreation.clear();
        if (this.activeWikilinkSuggest) {
            this.activeWikilinkSuggest.destroy();
            this.activeWikilinkSuggest = null;
        }
        if (this.pdfContainer) this.pdfContainer.empty();
        if (this.commentsTrack) this.commentsTrack.empty();
    }

    private cycleComment(direction: 1 | -1): void {
        if (this.annotations.length === 0) return;

        // Sort annotations by visual position (same order as renderCommentMarkers)
        const sorted = this.annotations
            .map(a => {
                const pageEl = this.pdfContainer?.querySelector<HTMLElement>(
                    `.pdf-page-container[data-page-number="${a.anchor.pageNumber}"]`
                );
                const top = pageEl ? pageEl.offsetTop + (a.anchor.yNorm * pageEl.offsetHeight) : 0;
                return { annotation: a, top };
            })
            .sort((a, b) => a.top - b.top);

        const currentIdx = sorted.findIndex(s => s.annotation.id === this.selectedAnnotationId);
        let nextIdx: number;
        if (currentIdx === -1) {
            // Nothing selected — start at first (forward) or last (backward)
            nextIdx = direction === 1 ? 0 : sorted.length - 1;
        } else {
            nextIdx = (currentIdx + direction + sorted.length) % sorted.length;
        }

        const target = sorted[nextIdx].annotation;
        this.selectedAnnotationId = target.id;
        this.pendingFocusAnnotationId = target.id;
        void this.renderCommentMarkers();

        // Scroll the PDF so the target annotation's page position is visible
        const pageEl = this.pdfContainer?.querySelector<HTMLElement>(
            `.pdf-page-container[data-page-number="${target.anchor.pageNumber}"]`
        );
        if (pageEl) {
            const targetScrollTop = pageEl.offsetTop + (target.anchor.yNorm * pageEl.offsetHeight) - this.pdfContainer.clientHeight / 3;
            this.pdfContainer.scrollTop = Math.max(0, targetScrollTop);
        }
    }

    private createSearchBar(): void {
        if (!this.pdfContainer) return;
        this.searchBar = document.createElement('div');
        this.searchBar.className = 'pdf-search-bar is-hidden';
        this.pdfContainer.prepend(this.searchBar);
        this.searchInput = this.searchBar.createEl('input', {
            cls: 'pdf-search-input',
            attr: { type: 'text', placeholder: 'Find in PDF…' },
        });
        this.searchMatchLabel = this.searchBar.createEl('span', { cls: 'pdf-search-match-label' });
        const searchClose = this.searchBar.createEl('button', { cls: 'pdf-search-close-btn', text: '×' });

        this.searchInput.addEventListener('input', () => this.performSearch());
        this.searchInput.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                if (e.shiftKey) this.navigateSearch(-1); else this.navigateSearch(1);
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                this.closeSearchBar();
            }
        });
        searchClose.addEventListener('click', () => this.closeSearchBar());
    }

    private updateSearchBarPosition(): void {
        if (!this.searchBar || !this.pdfContainer || this.searchBar.hasClass('is-hidden')) return;
        this.searchBar.setCssStyles({ top: `${this.pdfContainer.scrollTop + 8}px` });
    }

    private openSearchBar(): void {
        if (!this.searchBar || !this.searchInput) return;
        this.searchBar.removeClass('is-hidden');
        this.updateSearchBarPosition();
        this.searchInput.focus();
        this.searchInput.select();
    }

    private closeSearchBar(): void {
        if (!this.searchBar) return;
        this.searchBar.addClass('is-hidden');
        this.clearSearchHighlights();
        if (this.searchInput) this.searchInput.value = '';
        if (this.searchMatchLabel) this.searchMatchLabel.textContent = '';
        this.searchMatches = [];
        this.searchCurrentIdx = -1;
    }

    private clearSearchHighlights(): void {
        for (const el of this.searchHighlightEls) el.remove();
        this.searchHighlightEls = [];
    }

    private performSearch(): void {
        this.clearSearchHighlights();
        this.searchMatches = [];
        this.searchCurrentIdx = -1;

        const query = this.searchInput?.value.trim().toLowerCase();
        if (!query) {
            if (this.searchMatchLabel) this.searchMatchLabel.textContent = '';
            return;
        }

        // Walk all text layer spans in the PDF container
        const pageContainers = this.pdfContainer.querySelectorAll<HTMLElement>('.pdf-page-container');
        for (const pageEl of Array.from(pageContainers)) {
            const pageNum = parseInt(pageEl.dataset.pageNumber ?? '0', 10);
            const spans = pageEl.querySelectorAll<HTMLElement>('.pdf-text-layer span, .textLayer span');
            for (const span of Array.from(spans)) {
                const text = span.textContent ?? '';
                const lower = text.toLowerCase();
                let startIdx = 0;
                while (true) {
                    const idx = lower.indexOf(query, startIdx);
                    if (idx === -1) break;
                    // Create a highlight overlay positioned over this span region
                    const highlightLayer = pageEl.querySelector('.pdf-highlight-layer') ?? pageEl;
                    const spanRect = span.getBoundingClientRect();
                    const parentRect = pageEl.getBoundingClientRect();

                    // Approximate character-level positioning
                    const charWidth = spanRect.width / (text.length || 1);
                    const left = spanRect.left - parentRect.left + idx * charWidth;
                    const width = charWidth * query.length;

                    const mark = document.createElement('div');
                    mark.className = 'pdf-search-highlight';
                    mark.setCssStyles({
                        position: 'absolute',
                        left: `${left}px`,
                        top: `${spanRect.top - parentRect.top}px`,
                        width: `${width}px`,
                        height: `${spanRect.height}px`,
                    });
                    highlightLayer.appendChild(mark);
                    this.searchHighlightEls.push(mark);

                    this.searchMatches.push({ source: 'pdf', pageNumber: pageNum });

                    startIdx = idx + 1;
                }
            }
        }

        // Walk comment previews in the comments pane
        const previews = this.commentsTrack.querySelectorAll<HTMLElement>('.pdf-comment-preview');
        for (const preview of Array.from(previews)) {
            const marker = preview.closest('.pdf-comment-marker') as HTMLElement | null;
            if (!marker) continue;
            // Use a TreeWalker to find text nodes inside rendered markdown
            const walker = document.createTreeWalker(preview, NodeFilter.SHOW_TEXT);
            let textNode: Text | null;
            while ((textNode = walker.nextNode() as Text | null)) {
                const text = textNode.textContent ?? '';
                const lower = text.toLowerCase();
                let startIdx = 0;
                while (true) {
                    const idx = lower.indexOf(query, startIdx);
                    if (idx === -1) break;

                    // Create a highlight using a Range for accurate positioning
                    const range = document.createRange();
                    range.setStart(textNode, idx);
                    range.setEnd(textNode, idx + query.length);
                    const rects = range.getClientRects();
                    const markerRect = marker.getBoundingClientRect();

                    for (const rect of Array.from(rects)) {
                        const mark = document.createElement('div');
                        mark.className = 'pdf-search-highlight';
                        mark.setCssStyles({
                            position: 'absolute',
                            left: `${rect.left - markerRect.left}px`,
                            top: `${rect.top - markerRect.top}px`,
                            width: `${rect.width}px`,
                            height: `${rect.height}px`,
                        });
                        marker.appendChild(mark);
                        this.searchHighlightEls.push(mark);
                        this.searchMatches.push({ source: 'comment', pageNumber: 0 });
                    }

                    startIdx = idx + 1;
                }
            }
        }

        if (this.searchMatches.length > 0) {
            this.searchCurrentIdx = 0;
            this.highlightCurrentMatch();
        }
        this.updateSearchLabel();
    }

    private navigateSearch(direction: 1 | -1): void {
        if (this.searchMatches.length === 0) return;
        // Remove active class from current
        if (this.searchCurrentIdx >= 0 && this.searchCurrentIdx < this.searchHighlightEls.length) {
            this.searchHighlightEls[this.searchCurrentIdx].removeClass('is-active');
        }
        this.searchCurrentIdx = (this.searchCurrentIdx + direction + this.searchMatches.length) % this.searchMatches.length;
        this.highlightCurrentMatch();
        this.updateSearchLabel();
    }

    private highlightCurrentMatch(): void {
        if (this.searchCurrentIdx < 0 || this.searchCurrentIdx >= this.searchHighlightEls.length) return;
        const el = this.searchHighlightEls[this.searchCurrentIdx];
        el.addClass('is-active');

        const match = this.searchMatches[this.searchCurrentIdx];
        if (match.source === 'comment') {
            // Scroll the comments pane to show the match
            const marker = el.closest('.pdf-comment-marker') as HTMLElement | null;
            if (marker) {
                const targetTop = marker.offsetTop - this.commentsPane.clientHeight / 3;
                this.commentsPane.scrollTop = Math.max(0, targetTop);
            }
        } else {
            // Scroll the PDF container to show the match
            const pageEl = el.closest('.pdf-page-container') as HTMLElement | null;
            if (pageEl) {
                const targetTop = pageEl.offsetTop + el.offsetTop - this.pdfContainer.clientHeight / 3;
                this.pdfContainer.scrollTop = Math.max(0, targetTop);
            }
        }
    }

    private updateSearchLabel(): void {
        if (!this.searchMatchLabel) return;
        if (this.searchMatches.length === 0) {
            const hasQuery = !!(this.searchInput?.value.trim());
            this.searchMatchLabel.textContent = hasQuery ? 'No results' : '';
        } else {
            this.searchMatchLabel.textContent = `${this.searchCurrentIdx + 1} of ${this.searchMatches.length}`;
        }
    }

    private updateCommentsTrackHeight(): void {
        if (!this.commentsTrack || !this.pdfContainer) return;
        // Keep the comments track the same scrollable height as the PDF container content
        this.commentsTrack.setCssStyles({ height: `${this.pdfContainer.scrollHeight}px` });
    }

    private async renderCommentMarkers(): Promise<void> {
        if (!this.commentsTrack || !this.pdfContainer) return;
        const gen = ++this.renderGeneration;
        this.commentsTrack.empty();

        const MARKER_GAP = 10;

        // Phase 1: Compute ideal top positions
        const items: { annotation: typeof this.annotations[0]; idealTop: number; markerEl: HTMLElement }[] = [];
        for (const a of this.annotations) {
            const pageEl = this.pdfContainer.querySelector<HTMLElement>(
                `.pdf-page-container[data-page-number="${a.anchor.pageNumber}"]`
            );
            if (!pageEl) continue;
            items.push({ annotation: a, idealTop: pageEl.offsetTop + (a.anchor.yNorm * pageEl.offsetHeight), markerEl: null! });
        }

        // Phase 2: Sort by ideal position
        items.sort((a, b) => a.idealTop - b.idealTop);

        // Phase 3: Create DOM elements without positioning
        this.commentsTrack.setCssStyles({ visibility: 'hidden' });
        const renderPromises: Promise<void>[] = [];
        let pendingFocusTextarea: HTMLTextAreaElement | null = null;

        for (const item of items) {
            const a = item.annotation;
            const isSelected = a.id === this.selectedAnnotationId;

            const marker = this.commentsTrack.createEl('div', { cls: 'pdf-comment-marker' });
            if (!isSelected) marker.addClass('is-collapsed');
            item.markerEl = marker;

            marker.dataset.annotationId = a.id;
            marker.toggleClass('is-selected', isSelected);
            marker.addEventListener('click', () => {
                this.selectedAnnotationId = a.id;
                void this.renderCommentMarkers();
            });

            // Delete button (top-right X)
            const deleteBtn = marker.createEl('button', { cls: 'pdf-comment-delete-btn', text: '\u00d7' });
            deleteBtn.setAttribute('aria-label', 'Delete comment');
            deleteBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                void this.deleteAnnotation(a.id);
            });

            if (isSelected) {
                const editor = marker.createEl('div', { cls: 'pdf-comment-inline-editor' });
                const textarea = editor.createEl('textarea', {
                    cls: 'pdf-comment-inline-textarea',
                    attr: { rows: '3', placeholder: 'Write a comment… (supports [[backlinks]])' },
                });
                const footer = editor.createEl('div', { cls: 'pdf-comment-inline-footer' });
                const saveBtn = footer.createEl('button', { cls: 'pdf-comment-inline-save', text: 'Save' });
                saveBtn.disabled = true;
                let isSaving = false;

                const autoResize = () => {
                    textarea.style.height = 'auto';
                    textarea.style.height = `${textarea.scrollHeight}px`;
                };

                // Provide default frontmatter/quote so saving works even before notePath is ready.
                textarea.dataset.fm = '';
                textarea.dataset.quote = `> ${a.selectedText.replace(/\n/g, '\n> ')}\n\n`;

                // Load the current comment body from the note (excluding frontmatter + quote block)
                const loadPromise = (async () => {
                    if (!a.notePath) return;
                    const af = this.app.vault.getAbstractFileByPath(a.notePath);
                    if (!(af instanceof TFile)) return;
                    const md = await this.app.vault.read(af);
                    const { frontmatter, body } = this.stripFrontmatter(md);
                    const { quoteBlock, commentBody } = this.splitLeadingQuote(body);
                    textarea.dataset.fm = frontmatter;
                    textarea.dataset.quote = quoteBlock;
                    textarea.value = commentBody.trimStart();
                    autoResize();
                })();
                renderPromises.push(loadPromise);

                textarea.addEventListener('click', (e) => e.stopPropagation());
                textarea.addEventListener('input', () => {
                    autoResize();
                    saveBtn.disabled = false;
                    this.activeInlineDirty = true;
                });

                const doSave = async () => {
                    if (isSaving) return;
                    // Ensure note exists
                    if (!a.notePath) {
                        const existing = this.pendingNoteCreation.get(a.id);
                        if (existing) {
                            try {
                                const note = await existing;
                                a.notePath = note.path;
                                await this.saveAnnotationsForCurrentPdf();
                            } catch (e) {
                                console.warn('[comment-inline] note creation failed:', e);
                                return;
                            }
                        } else if (this.file) {
                            const currentFile = this.file;
                            const p = (async () => {
                                if (!this.currentPdfCommentsFolder) {
                                    this.currentPdfCommentsFolder = await this.ensurePerPdfFolder(currentFile.path);
                                }
                                const note = await this.createCommentNote(a);
                                a.notePath = note.path;
                                await this.saveAnnotationsForCurrentPdf();
                                return note;
                            })();
                            this.pendingNoteCreation.set(a.id, p);
                            try {
                                const note = await p;
                                a.notePath = note.path;
                            } catch (e) {
                                console.warn('[comment-inline] note creation failed:', e);
                                return;
                            } finally {
                                this.pendingNoteCreation.delete(a.id);
                            }
                        } else {
                            return;
                        }
                    }

                    const af = this.app.vault.getAbstractFileByPath(a.notePath);
                    if (!(af instanceof TFile)) return;

                    isSaving = true;
                    saveBtn.disabled = true;
                    try {
                        const fm = textarea.dataset.fm ?? '';
                        const quote = textarea.dataset.quote ?? '';
                        const next = `${fm}${quote}${textarea.value}\n`;
                        await this.app.vault.modify(af, next);
                        this.activeInlineDirty = false;
                        this.selectedAnnotationId = null;
                        void this.renderCommentMarkers();
                    } catch (err) {
                        console.warn('[comment-inline] failed to save:', err);
                        saveBtn.disabled = false;
                    } finally {
                        isSaving = false;
                    }
                };

                this.activeInlineTextarea = textarea;
                this.activeInlineSave = doSave;
                this.activeInlineDirty = false;

                // Focus is deferred to after Phase 4 (visibility restore)
                if (this.pendingFocusAnnotationId === a.id) {
                    this.pendingFocusAnnotationId = null;
                    pendingFocusTextarea = textarea;
                }

                saveBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    void doSave();
                });

                if (this.activeWikilinkSuggest) this.activeWikilinkSuggest.destroy();
                this.activeWikilinkSuggest = new WikilinkSuggest(this.app, textarea);
            } else {
                const preview = marker.createEl('div', { cls: 'pdf-comment-preview' });
                renderPromises.push(this.renderNotePreviewInto(a, preview));
            }
        }

        // Phase 4: Wait for content to render, then measure and position
        await Promise.all(renderPromises);
        if (gen !== this.renderGeneration) return; // stale render, bail

        let nextAvailableTop = 0;
        for (const item of items) {
            const marker = item.markerEl;
            const measuredHeight = marker.offsetHeight;
            const placedTop = Math.max(item.idealTop, nextAvailableTop);
            marker.setCssStyles({ top: `${placedTop}px` });
            nextAvailableTop = placedTop + measuredHeight + MARKER_GAP;
        }

        this.commentsTrack.setCssStyles({ visibility: 'visible' });

        if (nextAvailableTop > this.pdfContainer.scrollHeight) {
            this.commentsTrack.setCssStyles({ height: `${nextAvailableTop}px` });
        }

        // Focus textarea after DOM is visible and positioned
        if (pendingFocusTextarea) {
            const ta = pendingFocusTextarea;
            requestAnimationFrame(() => {
                try {
                    ta.focus();
                    const len = ta.value.length;
                    ta.setSelectionRange(len, len);
                } catch {
                    // ignore
                }
            });
        }
    }

    private renderHighlights(): void {
        if (!this.pdfContainer) return;

        const pages = Array.from(this.pdfContainer.querySelectorAll<HTMLElement>('.pdf-page-container'));
        for (const pageEl of pages) {
            let layer = pageEl.querySelector<HTMLElement>('.pdf-highlight-layer');
            if (!layer) {
                layer = pageEl.createEl('div', { cls: 'pdf-highlight-layer' });
            }
            layer.empty();
        }

        // Draw rects per page from all annotations
        for (const ann of this.annotations) {
            for (const pr of ann.highlights) {
                const pageEl = this.pdfContainer.querySelector<HTMLElement>(
                    `.pdf-page-container[data-page-number="${pr.pageNumber}"]`
                );
                if (!pageEl) continue;

                const layer = pageEl.querySelector<HTMLElement>('.pdf-highlight-layer');
                if (!layer) continue;

                const pageW = pageEl.clientWidth || pageEl.offsetWidth;
                const pageH = pageEl.clientHeight || pageEl.offsetHeight;
                if (!pageW || !pageH) continue;

                for (const r of pr.rects) {
                    const el = layer.createEl('div', { cls: 'pdf-highlight-rect' });
                    el.setCssStyles({
                        left: `${r.x * pageW}px`,
                        top: `${r.y * pageH}px`,
                        width: `${r.w * pageW}px`,
                        height: `${r.h * pageH}px`,
                    });
                }
            }
        }
    }

    private getAnnotationsPathForPdf(pdfPath: string): string {
        return `${pdfPath}.mg-comments.json`;
    }

    private getPdfBaseName(pdfPath: string): string {
        const parts = String(pdfPath ?? '').split('/').filter(Boolean);
        const name = parts.length ? parts[parts.length - 1] : 'PDF';
        return name.toLowerCase().endsWith('.pdf') ? name.slice(0, -4) : name;
    }

    private sanitizeVaultName(name: string): string {
        return (name || 'Untitled').replace(/[\\/:*?"<>|]/g, '_').trim();
    }

    private stripFrontmatter(md: string): { frontmatter: string; body: string } {
        // Normalize line endings so parsing works on Windows too
        const s = (md ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        if (!s.startsWith('---')) return { frontmatter: '', body: s };
        const idx = s.indexOf('\n---', 3);
        if (idx === -1) return { frontmatter: '', body: s };
        const end = idx + '\n---'.length;
        const after = s.slice(end);
        const body = after.startsWith('\n') ? after.slice(1) : after;
        return { frontmatter: s.slice(0, end) + '\n', body };
    }

    private splitLeadingQuote(body: string): { quoteBlock: string; commentBody: string } {
        const lines = (body ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
        let i = 0;

        // Skip any leading blank lines before the quote block (defensive)
        while (i < lines.length && lines[i].trim() === '') i += 1;

        const quoteLines: string[] = [];
        while (i < lines.length) {
            const raw = lines[i].replace(/^\uFEFF/, ''); // just in case
            // Treat lines like "> ..." and "   > ..." as quote lines
            if (!/^\s*>/.test(raw)) break;
            // Normalize to start with ">" to keep the stored quoteBlock consistent
            const normalized = raw.replace(/^\s*>/, '>');
            quoteLines.push(normalized);
            i += 1;
        }

        // Skip blank lines after quote block
        while (i < lines.length && lines[i].trim() === '') i += 1;

        const commentBody = lines.slice(i).join('\n');
        const quoteBlock = quoteLines.length ? `${quoteLines.join('\n')}\n\n` : '';
        return { quoteBlock, commentBody };
    }

    private async ensurePerPdfFolder(pdfPath: string): Promise<string> {
        const base = this.sanitizeVaultName(this.getPdfBaseName(pdfPath));
        let candidate = normalizePath(base);
        let i = 0;
        while (true) {
            const existing = this.app.vault.getAbstractFileByPath(candidate);
            if (!existing) {
                await this.app.vault.createFolder(candidate);
                return candidate;
            }
            // If it exists and is a folder, reuse it
            if (existing instanceof TFolder) return candidate;
            i += 1;
            candidate = normalizePath(`${base}_${i}`);
        }
    }

    private async createCommentNote(ann: PdfAnnotation): Promise<TFile> {
        if (!this.file) throw new Error('No current PDF file');
        if (!this.currentPdfCommentsFolder) throw new Error('No comments folder');

        const createdIso = new Date(ann.createdAt).toISOString().replace(/[:.]/g, '-');
        const fileName = `comment-${createdIso}-${ann.id}.md`;
        const notePath = normalizePath(`${this.currentPdfCommentsFolder}/${fileName}`);

        const frontmatter =
            `---\n` +
            `pdfPath: "${this.file.path.replace(/"/g, '\\"')}"\n` +
            `annotationId: "${ann.id}"\n` +
            `pageNumber: ${ann.anchor.pageNumber}\n` +
            `yNorm: ${ann.anchor.yNorm}\n` +
            `createdAt: "${new Date(ann.createdAt).toISOString()}"\n` +
            `---\n\n`;

        const pdfLink = `[[${this.file.path}|${this.file.basename}]]`;
        const initialBody =
            `> ${ann.selectedText.replace(/\n/g, '\n> ')}\n\n` +
            `**Source:** ${pdfLink} (p. ${ann.anchor.pageNumber})\n\n` +
            `---\n\n` +
            `${(ann.commentText ?? '').trim()}\n`;

        const content = frontmatter + initialBody;
        const existing = this.app.vault.getAbstractFileByPath(notePath);
        if (existing instanceof TFile) return existing;
        return await this.app.vault.create(notePath, content);
    }

    private async renderNotePreviewInto(ann: PdfAnnotation, container: HTMLElement): Promise<void> {
        container.empty();

        // Make rendered wikilinks clickable (open in workspace) via event delegation.
        // We only attach this once per container instance.
        if (container.dataset.mgLinks !== '1') {
            container.dataset.mgLinks = '1';
            container.addEventListener('click', (evt) => {
                const target = evt.target as HTMLElement | null;
                if (!target) return;

                const linkEl = target.closest('.internal-link');
                if (!linkEl) return;

                const href =
                    linkEl.getAttribute('data-href') ??
                    linkEl.getAttribute('href') ??
                    linkEl.textContent ??
                    '';
                if (!href) return;

                evt.preventDefault();
                evt.stopPropagation();
                try {
                    // Use Obsidian link opener so it behaves like a normal wikilink click
                    void this.app.workspace.openLinkText(href, container.dataset.mgSource ?? '', true);
                } catch (e) {
                    console.warn('[comment-preview] failed to open link:', href, e);
                }
            });
        }

        if (ann.notePath) {
            const af = this.app.vault.getAbstractFileByPath(ann.notePath);
            if (af instanceof TFile) {
                const md = await this.app.vault.read(af);
                container.dataset.mgSource = af.path;
                const { body } = this.stripFrontmatter(md);
                const { commentBody } = this.splitLeadingQuote(body);
                await MarkdownRenderer.render(this.app, commentBody, container, af.path, this);
                return;
            }
        }
        // Fallback (pre-migration): show inline text if present
        const fallback = (ann.commentText ?? '').trim();
        container.createEl('div', {
            cls: 'pdf-comment-preview-empty',
            text: fallback ? fallback : '(no note yet)',
        });
    }

    private async loadAnnotationsForCurrentPdf(): Promise<void> {
        if (!this.file) return;
        const pdfPath = this.file.path;

        const sidecar = this.getAnnotationsPathForPdf(pdfPath);
        try {
            const af = this.app.vault.getAbstractFileByPath(sidecar);
            if (!(af instanceof TFile)) {
                this.annotations = [];
                this.currentPdfCommentsFolder = await this.ensurePerPdfFolder(pdfPath);
                return;
            }

            const raw = await this.app.vault.read(af);
            const parsed = JSON.parse(raw) as PdfAnnotationsFile;
            if (parsed?.version !== 1 || parsed?.pdfPath !== pdfPath || !Array.isArray(parsed.annotations)) {
                this.annotations = [];
                this.currentPdfCommentsFolder = await this.ensurePerPdfFolder(pdfPath);
                return;
            }

            this.annotations = parsed.annotations;

            // Ensure per-PDF folder exists; migrate missing notePath by creating notes
            this.currentPdfCommentsFolder = await this.ensurePerPdfFolder(pdfPath);
            let migrated = false;
            for (const ann of this.annotations) {
                if (!ann.notePath) {
                    const note = await this.createCommentNote(ann);
                    ann.notePath = note.path;
                    migrated = true;
                }
            }
            if (migrated) await this.saveAnnotationsForCurrentPdf();
        } catch (e) {
            console.warn('[annotations] Failed to load annotations:', e);
            this.annotations = [];
        }
    }

    private async saveAnnotationsForCurrentPdf(): Promise<void> {
        if (!this.file) return;
        const pdfPath = this.file.path;
        const sidecar = this.getAnnotationsPathForPdf(pdfPath);

        const payload: PdfAnnotationsFile = {
            version: 1,
            pdfPath,
            annotations: this.annotations,
        };
        const json = JSON.stringify(payload, null, 2);

        const existing = this.app.vault.getAbstractFileByPath(sidecar);
        if (existing instanceof TFile) {
            await this.app.vault.modify(existing, json);
        } else {
            await this.app.vault.create(sidecar, json);
        }
    }

    private static readonly DELETE_UNDO_TIMEOUT_MS = 30000;

    private async deleteAnnotation(annotationId: string): Promise<void> {
        const idx = this.annotations.findIndex(a => a.id === annotationId);
        if (idx === -1) return;
        const ann = this.annotations[idx];

        // Wait for any in-flight note creation to complete before deleting
        const pending = this.pendingNoteCreation.get(annotationId);
        if (pending) {
            try { await pending; } catch { /* ignore */ }
        }

        // Clear selection state if we're deleting the selected annotation
        if (this.selectedAnnotationId === annotationId) {
            this.selectedAnnotationId = null;
            this.activeInlineTextarea = null;
            this.activeInlineSave = null;
            this.activeInlineDirty = false;
        }

        // Remove from UI immediately but defer persistence
        this.annotations.splice(idx, 1);
        void this.renderCommentMarkers();
        this.renderHighlights();

        // Push onto undo stack with a deferred commit timer
        const timer = setTimeout(() => {
            this.commitDeletion(annotationId);
        }, PdfCommenterView.DELETE_UNDO_TIMEOUT_MS);
        this.deleteUndoStack.push({ annotation: ann, index: idx, timer });

        this.showDeleteToast();
    }

    private async commitDeletion(annotationId: string): Promise<void> {
        const stackIdx = this.deleteUndoStack.findIndex(e => e.annotation.id === annotationId);
        if (stackIdx === -1) return;
        const entry = this.deleteUndoStack[stackIdx];
        this.deleteUndoStack.splice(stackIdx, 1);

        // Persist sidecar (annotations array already has it removed)
        await this.saveAnnotationsForCurrentPdf();

        // Trash the backing note if it exists
        if (entry.annotation.notePath) {
            const noteFile = this.app.vault.getAbstractFileByPath(entry.annotation.notePath);
            if (noteFile instanceof TFile) {
                try { await this.app.fileManager.trashFile(noteFile); } catch { /* ignore */ }
            }
        }

        // Dismiss toast if no more pending deletions
        if (this.deleteUndoStack.length === 0) {
            this.dismissDeleteToast();
        }
    }

    private undoLastDeletion(): void {
        const entry = this.deleteUndoStack.pop();
        if (!entry) return;

        clearTimeout(entry.timer);

        // Re-insert at original index (clamped to current length)
        const insertIdx = Math.min(entry.index, this.annotations.length);
        this.annotations.splice(insertIdx, 0, entry.annotation);

        void this.renderCommentMarkers();
        this.renderHighlights();

        // Dismiss toast if no more pending deletions
        if (this.deleteUndoStack.length === 0) {
            this.dismissDeleteToast();
        }
    }

    private showDeleteToast(): void {
        // Update existing toast rather than stacking
        if (this.activeToast) {
            this.dismissDeleteToast();
        }

        const toast = this.contentEl.createEl('div', { cls: 'pdf-comment-delete-toast' });
        const msg = toast.createEl('span', { text: 'Comment deleted. You can undo a delete quickly with Ctrl+Z' });
        const undoBtn = toast.createEl('button', { cls: 'pdf-comment-toast-undo', text: 'Undo' });
        undoBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.undoLastDeletion();
        });
        this.activeToast = toast;
    }

    private dismissDeleteToast(): void {
        if (this.activeToast) {
            this.activeToast.remove();
            this.activeToast = null;
        }
    }

    private getSelectionHighlightRectsFromCurrentSelection(): PageRects[] {
        const selection = window.getSelection();
        if (!selection || selection.isCollapsed || selection.rangeCount === 0) return [];

        const range = selection.getRangeAt(0);
        const rects = Array.from(range.getClientRects()).filter(r => r && r.width > 0.5 && r.height > 0.5);
        if (!rects.length) return [];

        const out = new Map<number, NormalizedRect[]>();

        for (const rect of rects) {
            const cx = rect.left + rect.width / 2;
            const cy = rect.top + rect.height / 2;
            const elAtPoint = document.elementFromPoint(cx, cy);
            const pageEl = elAtPoint?.closest?.('.pdf-page-container') as HTMLElement | null;
            if (!pageEl) continue;

            const pageNumber = Number(pageEl.dataset.pageNumber ?? pageEl.getAttribute('data-page-number') ?? NaN);
            if (!Number.isFinite(pageNumber)) continue;

            const pageRect = pageEl.getBoundingClientRect();
            if (!pageRect.width || !pageRect.height) continue;

            // Normalize to page box, clamp to [0..1]
            const x = (rect.left - pageRect.left) / pageRect.width;
            const y = (rect.top - pageRect.top) / pageRect.height;
            const w = rect.width / pageRect.width;
            const h = rect.height / pageRect.height;

            const nr: NormalizedRect = {
                x: Math.max(0, Math.min(1, x)),
                y: Math.max(0, Math.min(1, y)),
                w: Math.max(0, Math.min(1, w)),
                h: Math.max(0, Math.min(1, h)),
            };

            const arr = out.get(pageNumber) ?? [];
            arr.push(nr);
            out.set(pageNumber, arr);
        }

        return Array.from(out.entries())
            .sort((a, b) => a[0] - b[0])
            .map(([pageNumber, rects]) => ({ pageNumber, rects }));
    }

    private async handleCommentAction(selectedText: string, opts?: { focusEditor?: boolean }): Promise<void> {
        const text = String(selectedText ?? '').trim();
        if (!text) return;

        const anchor = this.getSelectionAnchorFromCurrentSelection();
        if (!anchor) {
            return;
        }

        const highlights = this.getSelectionHighlightRectsFromCurrentSelection();
        const ann: PdfAnnotation = {
            id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
            createdAt: Date.now(),
            selectedText: text,
            anchor,
            highlights,
        };

        this.annotations.push(ann);

        // Select + optionally focus editor immediately (caret visible right away)
        this.selectedAnnotationId = ann.id;
        if (opts?.focusEditor) this.pendingFocusAnnotationId = ann.id;

        this.updateCommentsTrackHeight();
        void this.renderCommentMarkers();
        this.renderHighlights();
        await this.saveAnnotationsForCurrentPdf();

        // Kick off note creation in the background so the UI is responsive immediately
        if (this.file) {
            const currentFile = this.file;
            const createPromise = (async () => {
                if (!this.currentPdfCommentsFolder) {
                    this.currentPdfCommentsFolder = await this.ensurePerPdfFolder(currentFile.path);
                }
                const note = await this.createCommentNote(ann);
                ann.notePath = note.path;
                await this.saveAnnotationsForCurrentPdf();
                return note;
            })();
            this.pendingNoteCreation.set(ann.id, createPromise);
            void createPromise.finally(() => this.pendingNoteCreation.delete(ann.id));
        }
    }

    private getSelectionAnchorFromCurrentSelection(): { pageNumber: number; yNorm: number } | null {
        const selection = window.getSelection();
        if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;

        const range = selection.getRangeAt(0);
        const rect = range.getBoundingClientRect();
        if (!rect || rect.height === 0) return null;

        // Find the page element containing the selection
        const anchorEl =
            selection.anchorNode instanceof Element
                ? selection.anchorNode
                : selection.anchorNode?.parentElement ?? null;
        const commonEl =
            range.commonAncestorContainer instanceof Element
                ? range.commonAncestorContainer
                : range.commonAncestorContainer?.parentElement ?? null;

        const pageEl =
            (anchorEl?.closest?.('.pdf-page-container') ?? commonEl?.closest?.('.pdf-page-container')) as
                | HTMLElement
                | null;
        if (!pageEl) return null;

        const pageRect = pageEl.getBoundingClientRect();
        if (!pageRect || pageRect.height === 0) return null;

        const centerY = rect.top + rect.height / 2;
        let yNorm = (centerY - pageRect.top) / pageRect.height;
        yNorm = Math.max(0, Math.min(1, yNorm));

        const pageNumber = Number(pageEl.dataset.pageNumber ?? pageEl.getAttribute('data-page-number') ?? NaN);
        if (!Number.isFinite(pageNumber)) return null;

        return { pageNumber, yNorm };
    }

    // ── Rename PDF ──────────────────────────────────────────────

    private startRename(): void {
        if (!this.file) return;

        const currentName = this.file.basename;
        const input = document.createElement('input');
        input.type = 'text';
        input.value = currentName;
        input.className = 'pdf-rename-input';

        const titleParent = this.titleEl.parentElement;
        if (!titleParent) return;
        this.titleEl.style.display = 'none';
        titleParent.insertBefore(input, this.titleEl);
        input.focus();
        input.select();

        const finish = async (commit: boolean) => {
            if (input.dataset.done) return;
            input.dataset.done = '1';
            const newName = input.value.trim();
            input.remove();
            this.titleEl.style.display = '';

            if (commit && newName && newName !== currentName && this.file) {
                await this.renamePdf(newName);
            }
        };

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); void finish(true); }
            if (e.key === 'Escape') { e.preventDefault(); void finish(false); }
        });
        input.addEventListener('blur', () => void finish(true));
    }

    private async renamePdf(newBaseName: string): Promise<void> {
        const file = this.file;
        if (!file) return;

        const oldPath = file.path;
        const oldDir = oldPath.contains('/') ? oldPath.slice(0, oldPath.lastIndexOf('/')) : '';
        const newFileName = `${newBaseName}.pdf`;
        const newPath = oldDir ? `${oldDir}/${newFileName}` : newFileName;

        // Prevent overwriting an existing file
        if (this.app.vault.getAbstractFileByPath(newPath)) {
            console.warn('[rename] target already exists:', newPath);
            return;
        }

        const oldSidecarPath = this.getAnnotationsPathForPdf(oldPath);
        const oldFolderPath = this.currentPdfCommentsFolder;

        try {
            // 1. Rename the PDF file itself
            await this.app.fileManager.renameFile(file, newPath);

            // 2. Rename the sidecar JSON and update pdfPath inside it
            const oldSidecar = this.app.vault.getAbstractFileByPath(oldSidecarPath);
            if (oldSidecar instanceof TFile) {
                const newSidecarPath = this.getAnnotationsPathForPdf(newPath);
                await this.app.fileManager.renameFile(oldSidecar, newSidecarPath);

                // Update pdfPath stored inside the sidecar
                const sidecarFile = this.app.vault.getAbstractFileByPath(newSidecarPath);
                if (sidecarFile instanceof TFile) {
                    const raw = await this.app.vault.read(sidecarFile);
                    const parsed = JSON.parse(raw) as PdfAnnotationsFile;
                    parsed.pdfPath = newPath;
                    await this.app.vault.modify(sidecarFile, JSON.stringify(parsed, null, 2));
                }
            }

            // 3. Rename the per-PDF comments folder
            if (oldFolderPath) {
                const oldFolder = this.app.vault.getAbstractFileByPath(oldFolderPath);
                if (oldFolder instanceof TFolder) {
                    const newFolderName = this.sanitizeVaultName(newBaseName);
                    const newFolderPath = normalizePath(newFolderName);
                    // Only rename if target doesn't already exist
                    if (!this.app.vault.getAbstractFileByPath(newFolderPath)) {
                        await this.app.fileManager.renameFile(oldFolder, newFolderPath);
                        this.currentPdfCommentsFolder = newFolderPath;
                    }
                }
            }

            // 4. Update annotation notePaths to reflect renamed folder
            if (oldFolderPath && this.currentPdfCommentsFolder && oldFolderPath !== this.currentPdfCommentsFolder) {
                for (const ann of this.annotations) {
                    if (ann.notePath?.startsWith(oldFolderPath + '/')) {
                        ann.notePath = this.currentPdfCommentsFolder + ann.notePath.slice(oldFolderPath.length);
                    }
                }
            }

            // 5. Update pdfPath in all comment note frontmatter and wikilinks
            await this.updateCommentNoteFrontmatter(oldPath, newPath);

            // 6. Update the title display
            this.titleEl.textContent = newBaseName;

        } catch (e) {
            console.error('[rename] Failed to rename PDF:', e);
        }
    }

    private async updateCommentNoteFrontmatter(oldPdfPath: string, newPdfPath: string): Promise<void> {
        for (const ann of this.annotations) {
            if (!ann.notePath) continue;
            const noteFile = this.app.vault.getAbstractFileByPath(ann.notePath);
            if (!(noteFile instanceof TFile)) continue;

            try {
                const md = await this.app.vault.read(noteFile);
                // Replace the pdfPath in frontmatter
                const escapedOld = oldPdfPath.replace(/"/g, '\\"');
                const escapedNew = newPdfPath.replace(/"/g, '\\"');
                const updated = md.replace(
                    `pdfPath: "${escapedOld}"`,
                    `pdfPath: "${escapedNew}"`
                );
                // Also update the wikilink in the body if present
                const oldLink = `[[${oldPdfPath}|`;
                const newBaseName = newPdfPath.contains('/') ? newPdfPath.slice(newPdfPath.lastIndexOf('/') + 1) : newPdfPath;
                const newDisplayName = newBaseName.toLowerCase().endsWith('.pdf') ? newBaseName.slice(0, -4) : newBaseName;
                const newLink = `[[${newPdfPath}|${newDisplayName}`;
                const finalContent = updated.split(oldLink).join(newLink);

                if (finalContent !== md) {
                    await this.app.vault.modify(noteFile, finalContent);
                }
            } catch (e) {
                console.warn('[rename] failed to update note frontmatter:', ann.notePath, e);
            }
        }
    }
}
