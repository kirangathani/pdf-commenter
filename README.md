# PDF Commenter

An Obsidian plugin for reading and annotating PDFs. Select text, leave comments, and link them to other notes in your vault with backlinks.

Comments are stored as individual markdown notes with frontmatter, not embedded in the PDF. Everything stays in your vault as plain files.

Desktop only.

## Features

- PDF viewer with zoom controls and pinch-to-zoom
- Select text and create comments anchored to that position
- Comments pane sits alongside the PDF with scroll sync
- Each comment is a markdown note — edit it, link to it, find it in search
- backlinks autocomplete in the comment editor
- Highlighted text regions rendered on the PDF pages
- Right-click context menu: copy text, create comment, copy to active note

## How it works

When you annotate a PDF, the plugin creates:
- A sidecar file (`<pdf>.mg-comments.json`) storing annotation positions and metadata
- A folder of markdown notes (one per comment) with frontmatter linking back to the PDF

## Install

### Via BRAT (recommended)

1. Install the [BRAT plugin](https://github.com/TfTHacker/obsidian42-brat) from Obsidian's community plugin browser (Settings > Community plugins > Browse, search "BRAT").
2. Open BRAT settings (Settings > BRAT).
3. Click **Add Beta plugin**.
4. Paste the repo URL: `kirangathani/pdf-commenter`
5. Click **Add Plugin**. BRAT will download the latest release and keep it updated.
6. Enable **PDF Commenter** in Settings > Community plugins.

### Manual install

Download `main.js`, `pdf.worker.js`, `styles.css`, and `manifest.json` from the [latest release](https://github.com/kirangathani/pdf-commenter/releases/latest) and place them in your vault at `.obsidian/plugins/pdf-commenter/`.

## Keyboard shortcuts

### General

| Shortcut | Action |
|----------|--------|
| `Ctrl+Alt+M` | Create comment from selected text |
| `Alt+Backspace` | Delete selected comment |
| `Ctrl+Z` / `Cmd+Z` | Undo last comment deletion |
| `Alt+D` | Cycle to next comment |
| `Alt+Shift+D` | Cycle to previous comment |
| `Ctrl+F` / `Cmd+F` | Open search bar |
| `Escape` | Close search bar / context menu |
| `Ctrl+Scroll` / `Cmd+Scroll` | Pinch-to-zoom |

### Comment editor

| Shortcut | Action |
|----------|--------|
| `Ctrl+Enter` / `Cmd+Enter` | Save comment |
| `[[` | Open wikilink autocomplete |
| `Arrow Up` / `Arrow Down` | Navigate autocomplete suggestions |
| `Enter` | Accept selected suggestion |
| `Escape` | Dismiss autocomplete |

### Search bar

| Shortcut | Action |
|----------|--------|
| `Enter` | Next search result |
| `Shift+Enter` | Previous search result |
| `Escape` | Close search bar |

## Build from source

```
npm install
npm run dev     # watch mode
npm run build   # production build
```

Requires Node 16+.

