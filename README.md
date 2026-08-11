# Annotation Overlay

DOM-aware visual annotation overlay for web pages. Draw arrows, boxes, text labels, and freehand strokes directly on any page. Every annotation automatically links to the underlying DOM element — output JSON carries CSS selectors, not just pixel coordinates.

**Zero dependencies. Single file. 862 lines of vanilla JS.**

Born from the [visual-design-loop](https://github.com/cc10143/annotation-overlay) workflow: inject → annotate → get structured feedback → fix code.

## Why

Existing annotation tools fall into two camps:

| Approach | Examples | Problem |
|---|---|---|
| Screenshot + draw | claude-visual-feedback, Tandem draw mode | Pixel coordinates only. Have to manually `elementFromPoint` to find the DOM element. Multi-color annotations require post-processing. |
| Build plugin injection | PinFix | Only works with Vite/Webpack dev servers. Can't annotate static HTML, third-party pages, or production. |
| Chrome extension | Vibe Annotations, Agentation | Requires installing an extension. Can't use with Tandem, Playwright, or other browser automation. |
| Heavy library | Redline (Fabric.js CDN) | 200KB+ dependency, requires network. Show/hide canvas causes flicker. |

**Annotation Overlay** bridges the gap — inject anywhere, zero deps, structured output.

## Quick Start

### Inject via browser console / Tandem evaluate

```js
// Copy the entire contents of annotation-overlay.js and evaluate it in the page.
// The overlay auto-installs. Press Ctrl+Shift+A to activate.
```

Then:
1. `Ctrl+Shift+A` — toggle the toolbar
2. Select a tool (arrow / box / text / freehand) and a color
3. Draw on the page — each annotation prompts for a comment
4. Press **Done** or `Ctrl+Shift+A` again — JSON copied to clipboard

### Inject via script tag

```html
<script src="annotation-overlay.js"></script>
```

The overlay stays hidden until `Ctrl+Shift+A` is pressed. Remove the script tag before production builds.

### Auto-activate via URL

Append `?__anno=1` to any URL. The overlay activates immediately on page load.

## Drawing Tools

| Tool | How to use | DOM target |
|---|---|---|
| **Arrow** (➤) | Click & drag from start to end | Element under arrowhead |
| **Box** (□) | Click & drag to enclose region | Element under box center |
| **Text** (T) | Click to place, type comment | Element under click point |
| **Freehand** (✎) | Click & drag to draw freely | Element under bounding-box center |

## Keyboard Shortcuts

| Key | Action |
|---|---|
| `Ctrl+Shift+A` | Toggle overlay on/off |
| `Ctrl+Z` | Undo last annotation |
| `Escape` | Cancel current drawing / close overlay |
| `Enter` | Confirm comment |
| `Shift+Enter` | New line in comment |

## Colors

Five preset colors:

- Red `#e94560`
- Blue `#4080f0`
- Green `#2ecc71`
- Yellow `#f1c40f`
- Purple `#9b59b6`

Click a swatch in the toolbar to switch. All annotations in the output JSON carry their color.

## Output Format

```json
{
  "version": "1",
  "url": "https://example.com/page",
  "viewport": { "width": 1440, "height": 900 },
  "timestamp": "2026-08-11T12:00:00Z",
  "annotations": [
    {
      "id": "a1b2c3d4",
      "type": "arrow",
      "comment": "Change button color to match brand",
      "selector": "div.card:nth-child(1) > button.btn-primary",
      "tagName": "BUTTON",
      "classes": ["btn-primary"],
      "elementText": "Buy Now",
      "color": "#e94560",
      "position": {
        "start": { "x": 100, "y": 200 },
        "end": { "x": 300, "y": 400 }
      }
    }
  ]
}
```

### Field Reference

| Field | Description |
|---|---|
| `type` | `arrow` / `circle` / `text` / `freehand` |
| `selector` | Unique CSS selector (DOM walk + `:nth-child` disambiguation) |
| `tagName` | Lowercase HTML tag name |
| `classes` | Array of CSS class names on the target element |
| `elementText` | First 80 characters of the target element's text content |
| `color` | Hex color used for the annotation stroke |
| `position` | Tool-specific geometry (arrow=start+end, circle=x+y+w+h, text=x+y, freehand=points[]) |

## Public API

```js
window.__annotationOverlay.activate()    // Show toolbar, start annotating
window.__annotationOverlay.deactivate()  // Hide overlay, restore page
window.__annotationOverlay.toggle()      // Toggle between activate/deactivate
window.__annotationOverlay.serialize()   // → JSON string of all annotations
window.__annotationOverlay.clear()       // Remove all annotations
```

## Integration Examples

### With Tandem (Claude Code browser)

```js
// 1. Open page in Tandem
// 2. tandem_devtools_evaluate — paste annotation-overlay.js contents
// 3. __annotationOverlay.activate()
// 4. User annotates → Done
// 5. tandem_devtools_evaluate: __annotationOverlay.serialize() → structured JSON
// 6. Use selector to grep source code, read computed styles, apply fixes
```

### With Playwright

```js
// Inject into a Playwright page
const overlay = await page.evaluate(fs.readFileSync('annotation-overlay.js', 'utf8'));
// ...wait for user to annotate and press Done...
const result = await page.evaluate(() => __annotationOverlay.serialize());
const annotations = JSON.parse(result);
```

### With any browser automation

The overlay is a self-contained IIFE. Inject it into any page context, call the public API, read structured results. No CDN, no npm install, no build step.

## Architecture

```
┌──────────────────────────────────────────────────┐
│              annotation-overlay.js                │
│                                                   │
│  ┌──────────┐  ┌──────────┐  ┌────────────────┐  │
│  │ Toolbar  │  │  Canvas  │  │  DOM Bridge    │  │
│  │  UI      │  │  2D      │  │  elementFrom   │  │
│  │          │  │  Engine  │  │  Point + CSS   │  │
│  │          │  │          │  │  selector gen  │  │
│  └────┬─────┘  └────┬─────┘  └───────┬────────┘  │
│       │             │               │            │
│       └─────────────┴───────┬───────┘            │
│                             │                    │
│                   ┌─────────▼─────────┐          │
│                   │  Annotation Model │          │
│                   │  + JSON Serializer│          │
│                   └───────────────────┘          │
└──────────────────────────────────────────────────┘
```

**Key design decisions:**

- **Canvas 2D over Fabric.js / SVG** — zero dependencies, DPR-aware, no CDN fetch
- **`pointer-events:none` toggle over canvas show/hide** — no flicker when `elementFromPoint` peeks through to the page
- **CSS selector generation with `:nth-child` disambiguation** — unique selectors without requiring IDs
- **Single-file IIFE** — inject via eval, script tag, or browser automation with no module system

## Comparison

| | Annotation Overlay | Redline | PinFix | Vibe Annotations |
|---|---|---|---|---|
| Zero dependencies | ✓ | ✗ (Fabric.js CDN) | ✓ | ✗ (Chrome ext + npm) |
| Works on any page | ✓ | ✓ | ✗ (build tool only) | ✓ (same-origin ext) |
| Freehand drawing | ✓ | ✓ | ✗ (click-to-pin) | ✗ (click-to-select) |
| CSS selectors in output | ✓ | ✓ | ✓ (data attr) | ✓ |
| Structured JSON output | ✓ | ✓ | ✗ (text chat) | ✓ (MCP) |
| Injects via eval/script tag | ✓ | ✓ | ✗ | ✗ |
| No browser extension needed | ✓ | ✓ | ✓ | ✗ |

## License

MIT
