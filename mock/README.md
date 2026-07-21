# Mock viewer harness

A standalone browser page that runs the **real** `PDFViewerComponent` from
`pdf-viewer.ts` outside Obsidian, so viewer layout, scrolling, zooming and the
comment-marker collision layout can be measured and iterated on with DevTools.

Obsidian's DOM helpers (`createDiv`, `setCssStyles`, `activeWindow`, …) are
polyfilled in `obsidian-shim.ts`; the page links the real `styles.css` and
defines stand-ins for the Obsidian theme variables. Comment cards are faked
(plain text instead of `MarkdownRenderer`) but positioned with the same greedy
downward sweep as `view.ts renderCommentMarkers()`.

## Usage

```bash
npm run mock                 # bundle to mock/mock.js (add `:watch` to rebuild on change)
cp <some.pdf> mock/test.pdf  # the harness loads ./test.pdf
python3 -m http.server 8099  # from the REPO ROOT, so ../styles.css resolves
# open http://localhost:8099/mock/index.html
```

`mock.js`, `pdf.worker.js` and `test.pdf` are gitignored build inputs/outputs.

## Measurement API

`window.mock` exposes:

| Call | Purpose |
|---|---|
| `mock.measure()` | Geometry snapshot: page vs viewport width, `scrollWidth`, `overflowBeyondPage` (scrollable dead space beyond the paper), `maxScrollLeft`, marker overlap count |
| `mock.countMarkerOverlaps()` | `0` means the collision sweep is holding |
| `mock.setScale(s)` | Commit a zoom the way the plugin does |
| `mock.setPaneWidth(px)` | Resize the comments pane programmatically |
| `mock.repositionMarkers()` | Re-run the collision sweep |
| `mock.timing` | Cold-load timings (fetch, eager all-page render) |

The stats strip under the zoom buttons shows the same numbers live.
