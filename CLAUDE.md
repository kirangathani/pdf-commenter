# PDF Commenter — Obsidian Plugin

## What This Is

An Obsidian plugin that provides a custom PDF viewer with an annotation/commenting system. Users load a vault-relative PDF, view it with zoom controls (including pinch-to-zoom), select text, and create comments anchored to specific positions in the PDF. Comments are backed by individual markdown notes with frontmatter, rendered with Obsidian's `MarkdownRenderer`, and support `[[wikilinks]]`.

## Project Structure

All source files are in the repo root (no `src/` directory).

| File | Role |
|---|---|
| `main.ts` | Plugin entry point. Extends `Plugin`. Registers the custom view type, ribbon icon, and command. |
| `view.ts` | `PdfCommenterView` extends `FileView`. Contains all UI: controls bar, PDF container, comments pane, annotation CRUD, scroll sync, pinch-to-zoom orchestration, highlight rendering, note creation/migration. This is the largest file (~1200 lines). |
| `pdf-viewer.ts` | `PDFViewerComponent`. Wraps pdfjs-dist: loads PDFs, renders pages to canvas, renders text layers for selection, handles zoom with progressive rendering (visible pages first, background render for rest), context menu integration. |
| `context-menu.ts` | `ContextMenu` class. Generic right-click menu positioned at cursor, used for Copy / Comment / Copy to Active Note / Create Note actions. |
| `styles.css` | All CSS. Layout uses flexbox. Purple (`#7c3aed`) accent colour for comment markers and buttons. Uses Obsidian CSS variables for theme compatibility. |
| `pdf.worker.js` | Copied from `pdfjs-dist` at build time by esbuild plugin. Shipped alongside `main.js` in the plugin folder. Loaded at runtime via blob URL to avoid CORS issues with Obsidian's `app://` protocol. |
| `esbuild.config.mjs` | Build config. Single entry point `main.ts` → `main.js` (CJS). Custom plugin `copy-pdf-worker` copies the pdfjs worker file post-build. |
| `wikilink-suggest.ts` | `WikilinkSuggest` class. Inline autocomplete popup for `[[wikilinks]]` in the comment textarea. Fuzzy-filters vault markdown files, keyboard nav, positioned below/above textarea. |
| `manifest.json` | Plugin id `pdf-commenter`, name `PDF Commenter`. `minAppVersion: 0.15.0`, `isDesktopOnly: true`. |

## Build & Dev

- **Dev mode**: `npm run dev` — esbuild watch mode with inline source maps.
- **Production**: `npm run build` — type-checks with `tsc -noEmit`, then esbuild with minification, no source maps.
- **Version bump**: `npm run version` — runs `version-bump.mjs`, updates `manifest.json` and `versions.json`.
- Output: `main.js` (gitignored), `pdf.worker.js`, `styles.css`, `manifest.json` go into the plugin folder.

## Key Dependencies

- `pdfjs-dist@2.16.105` — PDF rendering. Version 2.x chosen for compatibility with older Electron (classic workers as `.js`). Loaded via `require('pdfjs-dist/build/pdf.js')`.
- `obsidian` (latest) — Obsidian plugin API (external in esbuild).
- TypeScript 4.7, esbuild 0.17, ESLint with `@typescript-eslint`.

## Conventions

- **Indentation**: Tabs, width 4 (`.editorconfig`).
- **Line endings**: LF.
- **Module format**: ESNext in source, bundled to CJS by esbuild.
- **Target**: ES2018 (esbuild), ES6 (tsconfig).
- **Strict null checks** enabled; `noImplicitAny` enabled.
- No test framework is set up.
- Git branches: `master` (main), `dev` (active development).

## Architecture Notes

### Annotation Data Model

```typescript
type PdfAnnotation = {
    id: string;                    // timestamp + random hex
    createdAt: number;             // epoch ms
    selectedText: string;          // the highlighted PDF text
    commentText?: string;          // legacy inline text (back-compat)
    notePath?: string;             // vault path to backing markdown note
    anchor: { pageNumber: number; yNorm: number }; // normalised Y position on page
    highlights: PageRects[];       // normalised rects for highlight overlay
};
```

### Storage

- **Sidecar JSON**: `<pdfPath>.mg-comments.json` — `PdfAnnotationsFile` with `version: 1`, stores all annotations for a PDF.
- **Per-PDF folder**: A folder named after the PDF (sanitised) is created in the vault root. Each annotation gets a markdown note inside this folder: `comment-<isoDate>-<id>.md`.
- **Note format**: YAML frontmatter (`pdfPath`, `annotationId`, `pageNumber`, `yNorm`, `createdAt`) + blockquote of selected text + user comment body.
- On load, annotations missing `notePath` are auto-migrated (notes created, sidecar updated).

### Zoom System

Two-phase zoom for pinch-to-zoom:
1. **Preview phase**: CSS `transform: scale(factor)` on `.pdf-scroll-container` for instant visual feedback.
2. **Commit phase**: After 160ms debounce, calls `PDFViewerComponent.setScale()` which re-renders canvases at the new resolution. Visible pages render first (concurrency 2), remaining pages render in the background via `requestIdleCallback`.

Button zoom (+/- 0.25 steps) skips the preview phase and goes directly to commit. Scale range: 0.5–3.0, default 1.5.

### Scroll Sync

The comments pane and PDF container have synchronised scroll positions. The comments track height matches `pdfContainer.scrollHeight`. Comment markers are absolutely positioned based on the target page element's `offsetTop + yNorm * offsetHeight`.

### PDF.js Worker Loading

The worker file cannot be loaded via `plugin:` URLs due to CORS restrictions in Obsidian's `app://obsidian.md` origin. Instead, the plugin reads the worker file from disk using Node `fs`, creates a `Blob`, and generates a blob URL. Resolution tries multiple candidate directory names (`pluginDir`, runtime manifest `dir`, `pluginId`) to handle dev/production mismatches.

## Known Issues / Debt

- No automated tests.
- No way to delete a comment that already has content.
- No error recovery if sidecar JSON is corrupted.
- Annotations are tied to absolute text positions; replacing the PDF with a different version silently misaligns them.
- Comment hotkey is `Ctrl+Alt+M`; save comment is `Ctrl/Cmd+Enter` when textarea is focused.
- Empty comments (no text typed) are auto-deleted on deselect.
