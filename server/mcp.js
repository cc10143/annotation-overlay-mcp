import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  getAll,
  clear,
  count,
  getScreenshotPath,
  getAfterScreenshotPath,
  getAfterTabUrl,
  getPendingCapture,
  setPendingCapture,
  clearPendingCapture,
  setPendingMode,
  getPendingMode,
  clearPendingMode,
  getModeTabUrl,
} from "./store.js";
import { getHttpBindingInfo } from "./http.js";

export function createMcpServer() {
  const server = new Server(
    { name: "annotation-overlay-mcp", version: "2.3.1" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "read_annotations",
        description:
          "Read all pending visual annotation feedback. " +
          "Each annotation includes a CSS selector, fallback selector chain (id → cssPath → contentHash), " +
          "comment, annotation type (arrow/box/text/freehand/select/textsel), color, viewport position, and element metadata. " +
          "If a screenshot was captured on submit, `screenshotPath` is the absolute path to a PNG of the annotated viewport " +
          "(page with annotations overlaid, toolbar hidden) — pass it to a vision-capable tool to see what the user is pointing at. " +
          "If the agent requested a page capture via `capture_page`, `afterScreenshotPath` is the absolute path to the clean " +
          "(post-fix) viewport and `afterScreenshotTabUrl` is the URL of the tab that was captured — pair the two to verify a " +
          "fix actually landed, and confirm `afterScreenshotTabUrl` matches the page you expected. " +
          "`httpOwnedExternally` is true when another annotation-overlay instance holds the HTTP port (e.g. a stale `npm start`), " +
          "with `externalHttpVersion` naming that instance — read/clear still work against the shared store, but capture_page/" +
          "set_annotation_mode may fail until the stale process is killed. " +
          "Use this to consume user feedback after they press Submit in the overlay.",
        inputSchema: {
          type: "object",
          properties: {},
          required: [],
        },
      },
      {
        name: "capture_page",
        description:
          "Capture the current page viewport and save it as the 'after' state for before/after verification. " +
          "The server asks the extension (via its existing badge poll, ~10s interval) to capture the active tab of the focused window; " +
          "the shot is a clean viewport — the extension hides any annotation overlay chrome before capturing. " +
          "Returns the absolute path to the saved PNG plus `tabUrl`, the URL of the tab that was captured. " +
          "**Verify `tabUrl` matches the page you expect** — if the user switched tabs, the capture would show the wrong page. " +
          "Pair it with `screenshotPath` from read_annotations (the annotated 'before') and feed both to a vision-capable tool to " +
          "confirm a fix landed. May take up to ~15s (extension poll + capture). Requires the Chrome extension to be loaded.",
        inputSchema: {
          type: "object",
          properties: {},
          required: [],
        },
      },
      {
        name: "set_annotation_mode",
        description:
          "Show or hide the annotation toolbar on the active tab so the user can give visual feedback. " +
          "By default the overlay is injected but the toolbar stays hidden during normal browsing; call this with " +
          "enabled:true before asking the user to annotate, and enabled:false after processing. " +
          "The extension relays the change to the page's overlay via its ~10s badge poll and confirms when applied. " +
          "Returns { ok, enabled, tabUrl } — the URL of the tab the toolbar was toggled on, so you can verify it's the " +
          "page the user is looking at. Requires the Chrome extension to be loaded and the target page to be the active tab.",
        inputSchema: {
          type: "object",
          properties: {
            enabled: {
              type: "boolean",
              description: "true to show the annotation toolbar, false to hide it",
            },
          },
          required: ["enabled"],
        },
      },
      {
        name: "clear_annotations",
        description:
          "Clear all stored annotations. Call after processing feedback to prepare for the next annotation round.",
        inputSchema: {
          type: "object",
          properties: {},
          required: [],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name } = request.params;
    switch (name) {
      case "read_annotations": {
        const anns = getAll();
        const screenshotPath = getScreenshotPath();
        const afterScreenshotPath = getAfterScreenshotPath();
        const afterScreenshotTabUrl = getAfterTabUrl();
        const binding = getHttpBindingInfo();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  count: count(),
                  annotations: anns,
                  screenshotPath,
                  afterScreenshotPath,
                  afterScreenshotTabUrl,
                  httpOwnedExternally: binding.ownedExternally,
                  externalHttpVersion: binding.externalVersion,
                },
                null,
                2
              ),
            },
          ],
        };
      }
      case "capture_page": {
        const id = crypto.randomUUID();
        setPendingCapture(id);
        // Wait for the extension's service worker to notice the pending request
        // on its ~10s poll, capture the viewport, and POST the result. Poll the
        // store every second so the tool returns as soon as the capture lands.
        // (await yields the event loop — the HTTP server keeps serving.)
        const deadline = Date.now() + 25000;
        while (Date.now() < deadline) {
          const pending = getPendingCapture();
          if (!pending || pending.id !== id) break;
          await new Promise((r) => setTimeout(r, 1000));
        }
        const path = getAfterScreenshotPath();
        if (path) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  { ok: true, path, tabUrl: getAfterTabUrl() },
                  null,
                  2
                ),
              },
            ],
          };
        }
        // Timed out — clear our own pending request so the extension doesn't act
        // on a stale capture when it next comes online.
        clearPendingCapture(id);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  ok: false,
                  error:
                    "No capture received within 25s. Ensure the Chrome extension is loaded and the target page is the active tab.",
                },
                null,
                2
              ),
            },
          ],
        };
      }
      case "set_annotation_mode": {
        const enabled = !!(request.params.arguments && request.params.arguments.enabled);
        const id = setPendingMode(enabled);
        // Wait for the extension's service worker to relay the change to the
        // page's overlay and confirm via /api/mode-result (clears pendingMode).
        const deadline = Date.now() + 25000;
        while (Date.now() < deadline) {
          const pending = getPendingMode();
          if (!pending || pending.id !== id) break;
          await new Promise((r) => setTimeout(r, 1000));
        }
        const current = getPendingMode();
        if (!current || current.id !== id) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ ok: true, enabled, tabUrl: getModeTabUrl() }, null, 2),
              },
            ],
          };
        }
        // Timed out — clear our own pending request so a stale mode change
        // doesn't apply later.
        clearPendingMode(id);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  ok: false,
                  error:
                    "No mode change applied within 25s. Ensure the Chrome extension is loaded and the target page is the active tab.",
                },
                null,
                2
              ),
            },
          ],
        };
      }
      case "clear_annotations": {
        const removed = clear();
        return {
          content: [
            {
              type: "text",
              text: `Cleared ${removed} annotation(s). Ready for next round.`,
            },
          ],
        };
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  });

  return server;
}

export async function startMcpTransport(server) {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[annotation-overlay-mcp] MCP stdio transport connected");
}
