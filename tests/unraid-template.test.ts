import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const template = readFileSync(join(root, "unraid", "qualtrics-mcp-server.xml"), "utf8");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith(".ts") ? [path] : [];
  });
}

interface ConfigEntry {
  type: string;
  target: string;
  required: boolean;
}

function configEntries(): ConfigEntry[] {
  return [...template.matchAll(/<Config\s([^>]*?)\/?>/g)].map(([, attributes]) => {
    const attribute = (name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(attributes)?.[1] ?? "";
    return {
      type: attribute("Type"),
      target: attribute("Target"),
      required: attribute("Required") === "true",
    };
  });
}

test("every variable in the unRAID template is one the server actually reads", () => {
  const source = sourceFiles(join(root, "src"))
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");
  const variables = configEntries().filter((entry) => entry.type === "Variable");
  assert.ok(variables.length > 0);
  for (const { target } of variables) {
    assert.match(source, new RegExp(`\\b${target}\\b`), `${target} is not read anywhere in src/`);
  }
});

test("the unRAID template requires the Qualtrics settings and no single auth method", () => {
  const required = configEntries()
    .filter((entry) => entry.required)
    .map((entry) => entry.target);
  assert.ok(required.includes("QUALTRICS_API_TOKEN"));
  assert.ok(required.includes("QUALTRICS_DATA_CENTER"));
  // The server accepts an API key, Cloudflare Access, or both, so neither can be mandatory.
  assert.ok(!required.includes("MCP_AUTH_TOKEN"));
  assert.ok(!required.includes("CF_ACCESS_TEAM_DOMAIN"));
  assert.ok(!required.includes("CF_ACCESS_AUD"));
});

test("the unRAID template runs the HTTP entrypoint and maps the port and export directory the image uses", () => {
  assert.equal(/<PostArgs>([^<]*)<\/PostArgs>/.exec(template)?.[1], "build/http.js");
  assert.ok(statSync(join(root, "src", "http.ts")).isFile(), "PostArgs names build/http.js");

  const dockerfile = readFileSync(join(root, "Dockerfile"), "utf8");
  const containerPort = /MCP_HTTP_PORT=(\d+)/.exec(dockerfile)?.[1];
  const exportDir = /QUALTRICS_EXPORT_DIR=(\S+)/.exec(dockerfile)?.[1];
  assert.ok(containerPort && exportDir);

  const entries = configEntries();
  assert.ok(entries.some((entry) => entry.type === "Port" && entry.target === containerPort));
  assert.ok(entries.some((entry) => entry.type === "Path" && entry.target === exportDir));
});
