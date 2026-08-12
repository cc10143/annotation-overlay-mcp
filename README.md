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
3. **Submit** — click Submit to send structured JSON to the MCP server
4. **Agent reads** — Claude Code calls `read_annotations` → processes feedback
5. **Page refreshes** — extension auto-reinjects overlay → next round

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

## MCP Tools

### `read_annotations`

Read all pending annotations. Each annotation includes:

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

**`position` shape varies by type** (viewport coordinates):

| Type | position |
|------|----------|
| arrow | `{ "start": {"x","y"}, "end": {"x","y"} }` |
| circle / select / textsel | `{ "x", "y", "w", "h" }` |
| text | `{ "x", "y" }` |
| freehand | `{ "points": [{"x","y"}, ...] }` |

**`region`** (box/freehand only) is the container element that best represents the drawn area — e.g. the card `<div>` the user circled — with the same fallback chain as `selector`. Use it to locate the region when the box center happens to sit on a child element.

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
│  annotation-overlay.js  (src/, ~700 lines)            │
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
│         │  In-memory Store│                            │
│         └─────────────────┘                            │
└────────────────────────────────────────────────────────┘
```

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
