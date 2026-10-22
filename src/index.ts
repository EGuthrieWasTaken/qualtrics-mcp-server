#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createQualtricsServer } from "./server.js";

async function main() {
  let server: Awaited<ReturnType<typeof createQualtricsServer>> | undefined;

  // Node as PID 1 (e.g. in a container) has no default SIGTERM handler, so
  // `docker stop` would otherwise wait out its grace period and SIGKILL us.
  const shutdown = async () => {
    await server?.close().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  try {
    server = await createQualtricsServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
  }
}

main();
