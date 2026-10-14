#!/usr/bin/env node

/**
 * Optional Streamable HTTP entrypoint.
 *
 * The stdio entrypoint (src/index.ts) remains the default and is untouched.
 * This one exposes the same tool catalog over MCP Streamable HTTP so the server
 * can run once (for example in a container) and be reached by remote MCP clients.
 *
 * Each MCP session gets its own server instance, so write scopes enabled with
 * `set_write_scopes` (and the client-side rate limiter) never leak between sessions.
 *
 * Environment:
 *   MCP_HTTP_HOST            Bind address (default 127.0.0.1)
 *   MCP_HTTP_PORT            Port (default 3000; 0 picks a free port)
 *   MCP_HTTP_PATH            MCP endpoint path (default /mcp)
 *   MCP_AUTH_TOKEN           Bearer token required on every MCP request
 *   MCP_ALLOW_UNAUTHENTICATED=true
 *                            Permit a non-loopback bind without MCP_AUTH_TOKEN
 *                            (only for use behind an authenticating proxy)
 *   MCP_ALLOWED_HOSTS        Comma-separated Host header allowlist (DNS rebinding protection)
 *   MCP_ALLOWED_ORIGINS      Comma-separated Origin header allowlist
 *   MCP_SESSION_TTL_MS       Idle session lifetime (default 1800000)
 *   MCP_MAX_BODY_BYTES       Maximum request body size (default 16777216)
 */

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { realpathSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { pathToFileURL } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createQualtricsServer } from "./server.js";

export interface HttpServerOptions {
  host: string;
  port: number;
  path: string;
  authToken?: string;
  allowedHosts?: string[];
  allowedOrigins?: string[];
  sessionTtlMs: number;
  maxBodyBytes: number;
}

export interface RunningHttpServer {
  server: HttpServer;
  url: string;
  close(): Promise<void>;
}

interface Session {
  transport: StreamableHTTPServerTransport;
  close: () => Promise<void>;
  lastSeen: number;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost", "[::1]"]);

function splitList(value: string | undefined): string[] | undefined {
  const items = (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function positiveInt(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer (got "${value}")`);
  }
  return parsed;
}

export function loadHttpOptions(env: NodeJS.ProcessEnv = process.env): HttpServerOptions {
  const host = env.MCP_HTTP_HOST || "127.0.0.1";
  const authToken = env.MCP_AUTH_TOKEN || undefined;
  const path = env.MCP_HTTP_PATH || "/mcp";
  if (!path.startsWith("/") || path === "/healthz") {
    throw new Error('MCP_HTTP_PATH must start with "/" and must not be "/healthz"');
  }

  if (!authToken && !LOOPBACK_HOSTS.has(host) && env.MCP_ALLOW_UNAUTHENTICATED !== "true") {
    throw new Error(
      [
        `Refusing to listen on ${host} without authentication.`,
        "Set MCP_AUTH_TOKEN to require a bearer token, bind to 127.0.0.1,",
        "or set MCP_ALLOW_UNAUTHENTICATED=true if an authenticating reverse proxy sits in front.",
      ].join("\n")
    );
  }

  return {
    host,
    port: positiveInt(env.MCP_HTTP_PORT, 3000, "MCP_HTTP_PORT"),
    path,
    authToken,
    allowedHosts: splitList(env.MCP_ALLOWED_HOSTS),
    allowedOrigins: splitList(env.MCP_ALLOWED_ORIGINS),
    sessionTtlMs: positiveInt(env.MCP_SESSION_TTL_MS, 30 * 60 * 1000, "MCP_SESSION_TTL_MS"),
    maxBodyBytes: positiveInt(env.MCP_MAX_BODY_BYTES, 16 * 1024 * 1024, "MCP_MAX_BODY_BYTES"),
  };
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function isAuthorized(req: IncomingMessage, token: string | undefined): boolean {
  if (!token) return true;
  const header = req.headers.authorization ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return false;
  // Compare fixed-length digests so neither length nor content leaks via timing.
  return timingSafeEqual(digest(match[1]), digest(token));
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  if (res.headersSent) return;
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

function jsonRpcError(res: ServerResponse, status: number, message: string, headers: Record<string, string> = {}) {
  sendJson(res, status, { jsonrpc: "2.0", error: { code: -32000, message }, id: null }, headers);
}

class BodyTooLargeError extends Error {}

async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > maxBytes) throw new BodyTooLargeError();
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.length === 0) return undefined;
  return JSON.parse(text);
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

export async function startHttpServer(options: HttpServerOptions): Promise<RunningHttpServer> {
  const sessions = new Map<string, Session>();
  const dnsProtection = Boolean(options.allowedHosts || options.allowedOrigins);

  async function createSession(): Promise<StreamableHTTPServerTransport> {
    const mcpServer = await createQualtricsServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      allowedHosts: options.allowedHosts,
      allowedOrigins: options.allowedOrigins,
      enableDnsRebindingProtection: dnsProtection,
      onsessioninitialized: (sessionId) => {
        sessions.set(sessionId, {
          transport,
          lastSeen: Date.now(),
          close: () => mcpServer.close(),
        });
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };
    await mcpServer.connect(transport);
    return transport;
  }

  async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? "GET";
    if (method !== "POST" && method !== "GET" && method !== "DELETE") {
      return jsonRpcError(res, 405, "Method not allowed.", { Allow: "GET, POST, DELETE" });
    }

    const sessionId = headerValue(req, "mcp-session-id");

    if (method !== "POST") {
      const session = sessionId ? sessions.get(sessionId) : undefined;
      if (!session) return jsonRpcError(res, sessionId ? 404 : 400, "Missing or unknown Mcp-Session-Id.");
      session.lastSeen = Date.now();
      return session.transport.handleRequest(req, res);
    }

    let body: unknown;
    try {
      body = await readJsonBody(req, options.maxBodyBytes);
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        return jsonRpcError(res, 413, `Request body exceeds ${options.maxBodyBytes} bytes.`);
      }
      return jsonRpcError(res, 400, "Request body is not valid JSON.");
    }

    if (sessionId) {
      const session = sessions.get(sessionId);
      if (!session) return jsonRpcError(res, 404, "Unknown Mcp-Session-Id.");
      session.lastSeen = Date.now();
      return session.transport.handleRequest(req, res, body);
    }

    const isInitialize = Array.isArray(body)
      ? body.some((message) => isInitializeRequest(message))
      : isInitializeRequest(body);
    if (!isInitialize) {
      return jsonRpcError(res, 400, "Missing Mcp-Session-Id; send an initialize request first.");
    }

    const transport = await createSession();
    await transport.handleRequest(req, res, body);
  }

  const httpServer = createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;

    if (pathname === "/healthz" && (req.method === "GET" || req.method === "HEAD")) {
      return sendJson(res, 200, { status: "ok" });
    }
    if (pathname !== options.path) {
      return sendJson(res, 404, { error: "Not found" });
    }
    if (!isAuthorized(req, options.authToken)) {
      return sendJson(res, 401, { error: "Unauthorized" }, { "WWW-Authenticate": 'Bearer realm="qualtrics-mcp-server"' });
    }

    handleMcp(req, res).catch((error) => {
      console.error(`Request failed: ${error instanceof Error ? error.message : String(error)}`);
      jsonRpcError(res, 500, "Internal server error.");
    });
  });

  const sweepIntervalMs = Math.max(1000, Math.min(options.sessionTtlMs, 60_000));
  const sweeper = setInterval(() => {
    const cutoff = Date.now() - options.sessionTtlMs;
    for (const [id, session] of sessions) {
      if (session.lastSeen < cutoff) {
        sessions.delete(id);
        session.close().catch(() => undefined);
      }
    }
  }, sweepIntervalMs);
  sweeper.unref();

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(options.port, options.host, () => {
      httpServer.off("error", reject);
      resolve();
    });
  });

  const address = httpServer.address() as AddressInfo;
  const hostForUrl = address.family === "IPv6" ? `[${address.address}]` : address.address;

  return {
    server: httpServer,
    url: `http://${hostForUrl}:${address.port}${options.path}`,
    async close() {
      clearInterval(sweeper);
      const open = [...sessions.values()];
      sessions.clear();
      await Promise.all(open.map((session) => session.close().catch(() => undefined)));
      httpServer.closeAllConnections();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

async function main() {
  try {
    const options = loadHttpOptions();
    const running = await startHttpServer(options);
    console.error(`Qualtrics MCP Server (Streamable HTTP) listening on ${running.url}`);
    if (!options.authToken) {
      console.error("Warning: MCP_AUTH_TOKEN is not set; requests are not authenticated.");
    }

    const shutdown = () => {
      running.close().finally(() => process.exit(0));
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
  }
}

// Run only when executed directly (including through a package-manager bin symlink),
// so tests can import startHttpServer without starting a listener.
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main();
}
