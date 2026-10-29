import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadHttpOptions, startHttpServer, type HttpServerOptions } from "../src/http.js";
import { createCloudflareAccessVerifier } from "../src/cloudflare-access.js";
import { AUD, TEAM, makeKey, mintJwt, stubJwks } from "./helpers/cloudflare-access.js";

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

const ACCESS_JWT_HEADER = "Cf-Access-Jwt-Assertion";

const INITIALIZE = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "raw", version: "1.0.0" },
  },
});

/** POST an initialize request with the given credential headers and return the status. */
async function initializeStatus(url: string, headers: Record<string, string>): Promise<number> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...headers,
    },
    body: INITIALIZE,
  });
  await response.arrayBuffer();
  return response.status;
}

function accessSetup() {
  const key = makeKey("kid-1");
  const jwks = stubJwks([key]);
  const cloudflareAccess = createCloudflareAccessVerifier({
    teamDomain: TEAM,
    audience: AUD,
    fetchJwks: jwks.fetchJwks,
  });
  return { key, jwks, cloudflareAccess };
}

test("loadHttpOptions validates Cloudflare Access settings and counts them as authentication", () => {
  const complete = { CF_ACCESS_TEAM_DOMAIN: TEAM, CF_ACCESS_AUD: AUD };

  assert.equal(loadHttpOptions({}).cloudflareAccess, undefined);
  assert.equal(typeof loadHttpOptions(complete).cloudflareAccess, "function");

  assert.throws(() => loadHttpOptions({ CF_ACCESS_TEAM_DOMAIN: TEAM }), /must be set together/);
  assert.throws(() => loadHttpOptions({ CF_ACCESS_AUD: AUD }), /must be set together/);
  assert.throws(
    () => loadHttpOptions({ CF_ACCESS_TEAM_DOMAIN: "evil.example.com", CF_ACCESS_AUD: AUD }),
    /CF_ACCESS_TEAM_DOMAIN/
  );

  // Access alone is enough to bind publicly; nothing configured still is not.
  assert.doesNotThrow(() => loadHttpOptions({ MCP_HTTP_HOST: "0.0.0.0", ...complete }));
  assert.throws(() => loadHttpOptions({ MCP_HTTP_HOST: "0.0.0.0" }), /without authentication/);
});

test("with only Cloudflare Access configured, a valid token is required and API keys do not work", async () => {
  await withQualtricsEnv(async () => {
    const { key, cloudflareAccess } = accessSetup();
    const running = await startHttpServer(baseOptions({ authToken: undefined, cloudflareAccess }));
    const origin = new URL(running.url).origin;
    try {
      assert.equal(await initializeStatus(running.url, {}), 401, "no credential");
      assert.equal(await initializeStatus(running.url, { "X-API-Key": TOKEN }), 401, "no API key is configured");
      assert.equal(await initializeStatus(running.url, { "X-API-Key": "" }), 401, "an empty key is not a match for no key");
      assert.equal(await initializeStatus(running.url, { Authorization: "Bearer " }), 401);
      assert.equal(await initializeStatus(running.url, { [ACCESS_JWT_HEADER]: "garbage" }), 401);
      assert.equal(
        await initializeStatus(running.url, { [ACCESS_JWT_HEADER]: mintJwt(key, { aud: ["other-app"] }) }),
        401,
        "token for a different Access application"
      );
      assert.equal(
        await initializeStatus(running.url, { [ACCESS_JWT_HEADER]: mintJwt(makeKey("kid-1")) }),
        401,
        "token signed by a key Cloudflare never published"
      );
      assert.equal(await initializeStatus(running.url, { [ACCESS_JWT_HEADER]: mintJwt(key) }), 200);

      const rejected = await fetch(running.url, { method: "POST", body: INITIALIZE });
      assert.match(rejected.headers.get("www-authenticate") ?? "", /Bearer/);

      assert.equal((await fetch(`${origin}/healthz`)).status, 200, "health stays open for probes");
    } finally {
      await running.close();
    }
  });
});

test("a full MCP session works with only a Cloudflare Access token", async () => {
  await withQualtricsEnv(async () => {
    const { key, cloudflareAccess } = accessSetup();
    const running = await startHttpServer(baseOptions({ authToken: undefined, cloudflareAccess }));
    // Every request in the session carries the header, as Access forwards it on each one.
    const client = await connectClient(running.url, { [ACCESS_JWT_HEADER]: mintJwt(key) });
    try {
      const { tools } = await client.listTools();
      assert.equal(tools.length, 112);
    } finally {
      await client.close();
      await running.close();
    }
  });
});

test("an API key and Cloudflare Access are alternatives: either one is enough", async () => {
  await withQualtricsEnv(async () => {
    const { key, cloudflareAccess } = accessSetup();
    const running = await startHttpServer(baseOptions({ cloudflareAccess }));
    try {
      const jwt = mintJwt(key);
      assert.equal(await initializeStatus(running.url, { "X-API-Key": TOKEN }), 200, "API key alone");
      assert.equal(await initializeStatus(running.url, { Authorization: `Bearer ${TOKEN}` }), 200);
      assert.equal(await initializeStatus(running.url, { [ACCESS_JWT_HEADER]: jwt }), 200, "Access token alone");

      assert.equal(await initializeStatus(running.url, {}), 401, "neither");
      assert.equal(
        await initializeStatus(running.url, { "X-API-Key": "wrong", [ACCESS_JWT_HEADER]: "garbage" }),
        401,
        "both invalid"
      );
      assert.equal(
        await initializeStatus(running.url, { "X-API-Key": "wrong", [ACCESS_JWT_HEADER]: jwt }),
        200,
        "a valid Access token is enough despite a bad key"
      );
      assert.equal(
        await initializeStatus(running.url, { "X-API-Key": TOKEN, [ACCESS_JWT_HEADER]: "garbage" }),
        200,
        "a valid key is enough despite a bad token"
      );
    } finally {
      await running.close();
    }
  });
});

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

/** Run the real entrypoint in a child process with a controlled environment. */
function spawnEntrypoint(env: Record<string, string>) {
  const clean = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith("QUALTRICS_") && !key.startsWith("MCP_")
    )
  ) as Record<string, string>;
  const child = spawn(process.execPath, ["--import", "tsx", "src/http.ts"], {
    cwd: repoRoot,
    env: { ...clean, ...env },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  // A regression must fail the test, not hang it or leave a server running.
  const watchdog = setTimeout(() => child.kill("SIGKILL"), 30_000);
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) =>
      child.on("exit", (code, signal) => {
        clearTimeout(watchdog);
        resolve({ code, signal });
      })
  );
  return { child, exited, getStderr: () => stderr };
}

test("the HTTP entrypoint exits 1 at startup when Qualtrics config is missing", async () => {
  const { exited, getStderr } = spawnEntrypoint({ MCP_HTTP_PORT: "0" });
  const { code } = await exited;
  assert.equal(code, 1);
  assert.match(getStderr(), /missing configuration/);
  assert.doesNotMatch(getStderr(), /listening on/);
});

test("the HTTP entrypoint exits 0 promptly on SIGTERM", async () => {
  const { child, exited, getStderr } = spawnEntrypoint({
    QUALTRICS_API_TOKEN: "test-token",
    QUALTRICS_DATA_CENTER: "test",
    MCP_HTTP_PORT: "0",
    MCP_AUTH_TOKEN: TOKEN,
  });
  try {
    const deadline = Date.now() + 15_000;
    while (!/listening on/.test(getStderr())) {
      assert.ok(Date.now() < deadline, `server never started: ${getStderr()}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    child.kill("SIGTERM");
    const { code, signal } = await exited;
    assert.equal(signal, null);
    assert.equal(code, 0);
  } finally {
    child.kill("SIGKILL");
  }
});
