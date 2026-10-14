import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadHttpOptions, startHttpServer, type HttpServerOptions } from "../src/http.js";

const TOKEN = "test-bearer-token";

function withQualtricsEnv<T>(fn: () => Promise<T>): Promise<T> {
  const original = {
    apiToken: process.env.QUALTRICS_API_TOKEN,
    dataCenter: process.env.QUALTRICS_DATA_CENTER,
    readOnly: process.env.QUALTRICS_READ_ONLY,
    baseUrl: process.env.QUALTRICS_BASE_URL,
  };
  process.env.QUALTRICS_API_TOKEN = "test-token";
  process.env.QUALTRICS_DATA_CENTER = "test";
  process.env.QUALTRICS_READ_ONLY = "true";
  // Nothing listens here, so an allowed write fails fast without reaching a real Qualtrics host.
  process.env.QUALTRICS_BASE_URL = "http://127.0.0.1:1/API/v3";
  return fn().finally(() => {
    if (original.apiToken === undefined) delete process.env.QUALTRICS_API_TOKEN;
    else process.env.QUALTRICS_API_TOKEN = original.apiToken;
    if (original.dataCenter === undefined) delete process.env.QUALTRICS_DATA_CENTER;
    else process.env.QUALTRICS_DATA_CENTER = original.dataCenter;
    if (original.readOnly === undefined) delete process.env.QUALTRICS_READ_ONLY;
    else process.env.QUALTRICS_READ_ONLY = original.readOnly;
    if (original.baseUrl === undefined) delete process.env.QUALTRICS_BASE_URL;
    else process.env.QUALTRICS_BASE_URL = original.baseUrl;
  });
}

function baseOptions(overrides: Partial<HttpServerOptions> = {}): HttpServerOptions {
  return {
    host: "127.0.0.1",
    port: 0,
    path: "/mcp",
    authToken: TOKEN,
    sessionTtlMs: 60_000,
    maxBodyBytes: 1024 * 1024,
    ...overrides,
  };
}

async function connectClient(
  url: string,
  headers: Record<string, string> = { Authorization: `Bearer ${TOKEN}` }
): Promise<Client> {
  const client = new Client({ name: "http-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers },
  });
  await client.connect(transport);
  return client;
}

function scopeText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = result.content as Array<{ type: string; text?: string }>;
  return content.map((item) => item.text ?? "").join("\n");
}

test("loadHttpOptions defaults to loopback and refuses unauthenticated public binds", () => {
  const defaults = loadHttpOptions({});
  assert.equal(defaults.host, "127.0.0.1");
  assert.equal(defaults.port, 3000);
  assert.equal(defaults.path, "/mcp");
  assert.equal(defaults.authToken, undefined);

  assert.throws(() => loadHttpOptions({ MCP_HTTP_HOST: "0.0.0.0" }), /without authentication/);
  assert.doesNotThrow(() => loadHttpOptions({ MCP_HTTP_HOST: "0.0.0.0", MCP_AUTH_TOKEN: "x" }));
  assert.doesNotThrow(() =>
    loadHttpOptions({ MCP_HTTP_HOST: "0.0.0.0", MCP_ALLOW_UNAUTHENTICATED: "true" })
  );
  assert.throws(() => loadHttpOptions({ MCP_HTTP_PORT: "abc" }), /MCP_HTTP_PORT/);
  assert.throws(() => loadHttpOptions({ MCP_HTTP_PATH: "mcp" }), /MCP_HTTP_PATH/);
});

test("HTTP transport enforces bearer auth, serves health, and rejects bad requests", async () => {
  await withQualtricsEnv(async () => {
    const running = await startHttpServer(baseOptions());
    const origin = new URL(running.url).origin;
    try {
      const health = await fetch(`${origin}/healthz`);
      assert.equal(health.status, 200);

      const initialize = {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "raw", version: "1.0.0" },
        },
      };
      const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };

      const noAuth = await fetch(running.url, { method: "POST", headers, body: JSON.stringify(initialize) });
      assert.equal(noAuth.status, 401);
      assert.match(noAuth.headers.get("www-authenticate") ?? "", /Bearer/);

      const wrongAuth = await fetch(running.url, {
        method: "POST",
        headers: { ...headers, Authorization: "Bearer wrong" },
        body: JSON.stringify(initialize),
      });
      assert.equal(wrongAuth.status, 401);

      const wrongApiKey = await fetch(running.url, {
        method: "POST",
        headers: { ...headers, "X-API-Key": "wrong" },
        body: JSON.stringify(initialize),
      });
      assert.equal(wrongApiKey.status, 401);

      const apiKeyAuth = await fetch(running.url, {
        method: "POST",
        headers: { ...headers, "X-API-Key": TOKEN },
        body: JSON.stringify(initialize),
      });
      assert.equal(apiKeyAuth.status, 200);
      await apiKeyAuth.arrayBuffer();

      const auth = { ...headers, Authorization: `Bearer ${TOKEN}` };

      const notInitialize = await fetch(running.url, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      });
      assert.equal(notInitialize.status, 400);

      const badJson = await fetch(running.url, { method: "POST", headers: auth, body: "{nope" });
      assert.equal(badJson.status, 400);

      const unknownSession = await fetch(running.url, {
        method: "POST",
        headers: { ...auth, "Mcp-Session-Id": "does-not-exist" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }),
      });
      assert.equal(unknownSession.status, 404);

      const wrongPath = await fetch(`${origin}/elsewhere`, { headers: { Authorization: `Bearer ${TOKEN}` } });
      assert.equal(wrongPath.status, 404);
    } finally {
      await running.close();
    }
  });
});

test("HTTP transport rejects oversized bodies", async () => {
  await withQualtricsEnv(async () => {
    const running = await startHttpServer(baseOptions({ maxBodyBytes: 256 }));
    try {
      const response = await fetch(running.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${TOKEN}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", padding: "x".repeat(1024) }),
      });
      assert.equal(response.status, 413);
    } finally {
      await running.close();
    }
  });
});

test("HTTP transport exposes the full tool catalog and isolates write scopes per session", async () => {
  await withQualtricsEnv(async () => {
    const running = await startHttpServer(baseOptions());
    const first = await connectClient(running.url);
    const second = await connectClient(running.url);
    try {
      const { tools } = await first.listTools();
      assert.equal(tools.length, 112);
      assert.ok(tools.some((tool) => tool.name === "set_write_scopes"));

      const deleteBlock = {
        name: "delete_block",
        arguments: { surveyId: "SV_test", blockId: "BL_test", confirmDelete: true },
      };

      await first.callTool({ name: "set_write_scopes", arguments: { scopes: ["questionsAndBlocks"] } });

      // Session one is allowed to attempt the write (it then fails to reach the fake host).
      const allowed = scopeText(await first.callTool(deleteBlock));
      assert.doesNotMatch(allowed, /Write blocked/);

      // Session two never enabled a scope, so the same call must still be blocked.
      const blocked = scopeText(await second.callTool(deleteBlock));
      assert.match(blocked, /Write blocked/);
    } finally {
      await first.close();
      await second.close();
      await running.close();
    }
  });
});

test("a full MCP session works with the X-API-Key header alone", async () => {
  await withQualtricsEnv(async () => {
    const running = await startHttpServer(baseOptions());
    const client = await connectClient(running.url, { "X-API-Key": TOKEN });
    try {
      const { tools } = await client.listTools();
      assert.equal(tools.length, 112);
    } finally {
      await client.close();
      await running.close();
    }
  });
});
