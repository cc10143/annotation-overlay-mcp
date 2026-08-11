import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { getAll, clear, count } from "./store.js";

export function createMcpServer() {
  const server = new Server(
    { name: "annotation-overlay-mcp", version: "2.0.0" },
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
          "Use this to consume user feedback after they press Submit in the overlay.",
        inputSchema: {
          type: "object",
          properties: {},
          required: [],
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
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { count: count(), annotations: anns },
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
