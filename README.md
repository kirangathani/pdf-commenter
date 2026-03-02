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

Download `main.js`, `pdf.worker.js`, `styles.css`, and `manifest.json` from the [latest release](https://github.com/kirangathani/magnifying-glass/releases/latest) and place them in your vault at `.obsidian/plugins/pdf-commenter/`.

## Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+Alt+M` | Create comment from selection |
| `Ctrl+Enter` / `Cmd+Enter` | Save comment |

## Build from source

```
npm install
npm run dev     # watch mode
npm run build   # production build
```

Requires Node 16+.
