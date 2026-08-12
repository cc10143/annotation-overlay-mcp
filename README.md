# Annotation Overlay MCP

DOM-aware visual annotation overlay for web feedback. Draw arrows, boxes, text, freehand strokes, click elements, and annotate text selections — all in one toolbar. Submit structured annotations to Claude Code via MCP.

**6 interaction modes. Zero JS dependencies. Chrome Extension + MCP Server.**

```
[Browser Page]  ←→  [Chrome Extension]  ←→  [MCP Server]  ←→  [Claude Code]
   overlay.js         bridge.js              HTTP + stdio       read/clear tools
```

## Quick Start

### 1. Install & Start MCP Server

```bash
git clone https://github.com/cc10143/annotation-overlay-mcp.git
cd annotation-overlay-mcp
npm install
npm start
# → HTTP server on port 3847 + MCP stdio transport connected
```

### 2. Load Chrome Extension

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select the `extension/` directory

The overlay now auto-injects on every page. Press `Ctrl+Shift+A` to toggle the toolbar.

### 3. Configure Claude Code MCP

```json
// ~/.claude/settings.json
{
  "mcpServers": {
    "annotation-overlay-mcp": {
      "command": "node",
      "args": ["D:/KaiFa/annotation-overlay/server/index.js"]
    }
  }
}
```

Or use the CLI:

```bash
claude mcp add annotation-overlay-mcp -- node D:/KaiFa/annotation-overlay/server/index.js
```

## Usage

### Annotation Workflow

1. **Open any page** — the overlay auto-injects via Chrome extension
2. **Annotate** — use any of the 6 tools to mark issues
3. **Submit** — click Submit to send structured JSON to the MCP server. The extension automatically captures a **viewport screenshot with annotations overlaid** and uploads it; the server saves it to `~/.annotation-overlay/screenshots/`
4. **Agent reads** — Claude Code calls `read_annotations` → gets annotations + `screenshotPath` → feeds the screenshot to a vision-capable tool → processes feedback
5. **Fix & verify** — after the page reloads with fixes, the agent calls `capture_page` → gets `afterScreenshotPath` (a clean post-fix viewport) → compares it against the annotated `screenshotPath` to confirm the fix actually landed
6. **Page refreshes** — extension auto-reinjects overlay → next round

### Tools

| Tool | Label | How | DOM Link |
|------|-------|-----|----------|
| Arrow | ➤ | Click & drag → arrow | Element under arrowhead |
| Box | □ | Click & drag → rectangle | **Region container** + element at box center |
| Text | T | Click → type text label | Element under click point |
| Freehand | ✎ | Click & drag → freeform drawing | **Region container** + bbox center element |
| **Select** | **+** | Hover highlights blue → click to pin numbered badge | Clicked element |
| **TextSel** | **[ ]** | Select page text → annotate instantly | Containing element |

Drawing annotates **immediately** — no comment prompt interrupts your flow. To add a comment to an existing annotation, switch to the **Select** tool and **double-click** the drawing (or the numbered badge). Only the Text tool still prompts, because its text is the annotation itself.

### Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Ctrl+Shift+A` | Toggle overlay |
| `1–6` | Switch tool |
| `Ctrl+Z` | Undo last annotation |
| `Ctrl+Shift+Z` / `Ctrl+Y` | Redo |
| `Double-click` | Edit annotation comment (select tool) |
| `?` | Show shortcut panel |
| `Escape` | Cancel drawing / close overlay |
| `Enter` | Confirm comment |
| `Shift+Enter` | Newline in comment |

### Colors

5 preset colors: red `#e94560`, blue `#4080f0`, green `#2ecc71`, yellow `#f1c40f`, purple `#9b59b6`.

### Screenshot

On Submit, the extension captures the current viewport **with annotations overlaid** — the canvas strokes and numbered badges are DOM, so they appear in the shot naturally; only the toolbar is hidden during capture. The screenshot is uploaded to the MCP server and saved to `~/.annotation-overlay/screenshots/anno-<timestamp>.png`.

`read_annotations` returns the absolute `screenshotPath` in its response. Pass it to a vision-capable tool (e.g. a vision MCP) to see exactly what the user is pointing at — this is how a non-multimodal agent gets visual context for the annotations.

For **before/after verification**, the agent calls `capture_page` after the fix reloads the page. The extension captures the current viewport (clean — the overlay is inactive until toggled) and the server exposes it as `afterScreenshotPath` in `read_annotations`. Feeding both `screenshotPath` (annotated "before") and `afterScreenshotPath` (clean "after") to a vision-capable tool lets the agent confirm a fix landed instead of working blind.

_Extension only._ Without the extension bridge (standalone script injection), submit proceeds without a screenshot.

## MCP Tools

### `read_annotations`

Read all pending annotations. The response also includes `screenshotPath` — the absolute path to the last annotated viewport screenshot (saved on Submit) — and `afterScreenshotPath` — the absolute path to the last `capture_page` screenshot (clean post-fix viewport), both for vision-capable consumption.

Each annotation includes:

```json
{
  "id": "uuid",
  "type": "circle",                       // arrow | circle | text | freehand | select | textsel
  "comment": "user feedback text",        // empty until double-clicked in select mode
  "selector": "div.card:nth-child(1) > button.btn-primary",
  "fallbackSelectors": [
    { "type": "id", "value": "#submit-btn" },
    { "type": "cssPath", "value": "div.card:nth-child(1) > ..." },
    { "type": "contentHash", "value": "Buy Now-a3f8b2c1" }
  ],
  "tagName": "BUTTON",
  "classes": ["btn-primary"],
  "elementText": "Buy Now",
  "contentHash": "Buy Now-a3f8b2c1",
  "region": {                             // box/freehand only: the container element
    "selector": "#card",                  //   covering the drawn area (deepest ancestor
    "fallbackSelectors": [                //   whose rect covers ≥60% of the drawing)
      { "type": "id", "value": "#card" },
      { "type": "cssPath", "value": "div.card" },
      { "type": "contentHash", "value": "Card A-..." }
    ],
    "tagName": "div",
    "classes": ["card"]
  },
  "position": { "x": 100, "y": 200, "w": 200, "h": 100 },
  "color": "#e94560"
}
```

**`screenshotPath`** — added to the response when a screenshot was captured on submit, e.g. `"C:\Users\you\.annotation-overlay\screenshots\anno-2026-08-12T06-27-48.png"`. Pass it to a vision-capable tool to see the page with annotations overlaid.

**`afterScreenshotPath`** — added to the response after an agent-requested `capture_page`, e.g. `"C:\Users\you\.annotation-overlay\screenshots\anno-2026-08-12T06-30-12.png"`. This is the clean post-fix viewport; compare it against `screenshotPath` to verify a fix landed. **`afterScreenshotTabUrl`** is the URL of the tab that was captured — confirm it matches the page you expected (the capture is of the active tab). All three are cleared by `clear_annotations`.

**`position` shape varies by type** (viewport coordinates):

| Type | position |
|------|----------|
| arrow | `{ "start": {"x","y"}, "end": {"x","y"} }` |
| circle / select / textsel | `{ "x", "y", "w", "h" }` |
| text | `{ "x", "y" }` |
| freehand | `{ "points": [{"x","y"}, ...] }` |

**`region`** (box/freehand only) is the container element that best represents the drawn area — e.g. the card `<div>` the user circled — with the same fallback chain as `selector`. Use it to locate the region when the box center happens to sit on a child element.

### `capture_page`

Capture the current page viewport and save it as the **"after"** state for before/after verification. The server asks the extension (via its existing ~10s badge poll) to capture the active tab of the focused window; the shot is clean — the extension hides any annotation overlay chrome before capturing. Returns the absolute path to the saved PNG plus the URL of the captured tab, e.g.:

```json
{ "ok": true, "path": "C:\\Users\\you\\.annotation-overlay\\screenshots\\anno-2026-08-12T06-30-12.png", "tabUrl": "https://example.com/" }
```

**Verify `tabUrl` matches the page you expect** — `capture_page` captures the active tab, so if the user switched tabs it would show the wrong page (the server can't tell). May take up to ~15s (extension poll + capture). Requires the extension to be loaded. Pair the result with `screenshotPath` from `read_annotations` to confirm a fix landed.

### `clear_annotations`

Clear all stored annotations. Call after processing feedback.

## Selector Fallback Chain

When the agent regenerates the page, CSS selectors may break. Each annotation carries a fallback chain:

1. **id** — `#element-id` (most stable)
2. **cssPath** — `div.card:nth-child(1) > button.btn-primary`
3. **contentHash** — `Buy Now-a3f8b2c1` (first 40 chars of text + djb2 hash)

The agent should try each fallback in order when resolving elements after page changes.

## Standalone Use (Without Extension)

The overlay can be injected into any page via script tag or browser console:

```html
<script src="annotation-overlay.js"></script>
```

Or via Tandem evaluate / Playwright:

```js
// Tandem
tandem_devtools_evaluate({ function: "..." }) // paste annotation-overlay.js contents

// Playwright
await page.evaluate(fs.readFileSync('annotation-overlay.js', 'utf-8'));
```

Public API:

```js
__annotationOverlay.activate()    // show toolbar
__annotationOverlay.deactivate()  // hide overlay
__annotationOverlay.serialize()   // → JSON string
__annotationOverlay.clear()       // remove all annotations
__annotationOverlay.submit()      // send to MCP server via direct fetch
```

## Architecture

```
┌──────────────────────────────────────────────────────┐
│  annotation-overlay.js  (src/, ~1600 lines)          │
│                                                      │
│  ┌──────────┐  ┌──────────┐  ┌──────────────────┐   │
│  │ Toolbar  │  │  Canvas  │  │  DOM Bridge      │   │
│  │  6 tools │  │  2D ctx  │  │  elementFromPoint │   │
│  │  5 colors│  │  DPR     │  │  CSS selector gen │   │
│  │  Submit  │  │  undo    │  │  contentHash      │   │
│  └────┬─────┘  └────┬─────┘  └────────┬─────────┘   │
│       │             │                │               │
│       └─────────────┴───────┬────────┘               │
│                             │                         │
│                    ┌────────▼────────┐                │
│                    │  Annotation Model│               │
│                    │  + Serializer   │               │
│                    │  + Fallback     │               │
│                    └────────┬────────┘               │
└─────────────────────────────┼────────────────────────┘
                              │ postMessage
┌─────────────────────────────┼────────────────────────┐
│  Chrome Extension           ▼                         │
│  ┌──────────────┐  ┌──────────────┐                  │
│  │  bridge.js   │  │  service-    │                  │
│  │  (ISOLATED)  │  │  worker.js   │                  │
│  │  inject +    │  │  badge +     │                  │
│  │  relay       │  │  relay       │                  │
│  └──────┬───────┘  └──────┬───────┘                  │
└─────────┼──────────────────┼──────────────────────────┘
          │                  │ HTTP (port 3847)
┌─────────▼──────────────────▼──────────────────────────┐
│  MCP Server (Node.js, single process)                  │
│  ┌──────────────┐  ┌──────────────┐                   │
│  │  Express API │  │  MCP stdio   │                   │
│  │  POST/GET/   │  │  read_       │                   │
│  │  DELETE ann  │  │  clear tools │                   │
│  └──────┬───────┘  └──────┬───────┘                   │
│         └────────┬─────────┘                           │
│         ┌────────▼────────┐                            │
│         │  File Store      │                            │
│         └─────────────────┘                            │
└────────────────────────────────────────────────────────┘
```

> On Submit the extension captures the annotated viewport; the server saves it to `~/.annotation-overlay/screenshots/` and `read_annotations` surfaces the path via `screenshotPath`.

## Comparison

| | Annotation Overlay MCP | Vibe Annotations | Dongke-X/redline |
|---|---|---|---|
| Drawing tools | 4 (arrow/box/text/freehand) | None | Full HTML editor |
| Click-to-select | Yes (+ badge) | Yes | Full edit |
| Text selection annotation | Yes | No | No |
| MCP automation | Yes (stdio) | Yes (SSE/HTTP) | No (file-based) |
| Selector fallback | id→cssPath→contentHash | source maps | id→cssPath→contentHash |
| License | MIT | PolyForm Shield | Apache 2.0 |
| Dependencies | 3 (Express + cors + MCP SDK) | Many (WXT, etc.) | Many (React, etc.) |

## Configuration

| Env Var | Default | Description |
|---------|---------|-------------|
| `ANNO_PORT` | `3847` | HTTP server port |

## License

MIT — Copyright (c) 2026 gaogao
