import { createHttpServer } from "./http.js";
import { createMcpServer, startMcpTransport } from "./mcp.js";

async function main() {
  const mcpServer = createMcpServer();

  await Promise.all([
    createHttpServer(),
    startMcpTransport(mcpServer),
  ]);
}

main().catch((err) => {
  console.error("[annotation-overlay-mcp] Fatal:", err);
  process.exit(1);
});
