# Spec: Run the Qualtrics MCP Server as a Docker Container

Status: Draft. Target: a PR to the upstream repository (`yrvelez/qualtrics-mcp-server`).

## 1. Goal

Let users run the server with only Docker installed, with no local Node.js or pnpm, and keep the behaviour of the current `node build/index.js` path. A user should be able to:

```bash
docker build -t qualtrics-mcp-server .
```

and then point any stdio-capable MCP client at `docker run --rm -i ... qualtrics-mcp-server`.

### Non-goals (this PR)

- **HTTP/SSE transport.** The server only speaks stdio (`src/index.ts` uses `StdioServerTransport`). A network transport would add a listening port, authentication, and multi-tenant token handling. That is a separate design and should not ride along with packaging.
- **Publishing an image to a registry.** The namespace, tags, and signing for GHCR or Docker Hub are the upstream maintainer's decision. The PR ships a buildable `Dockerfile`; publishing is listed under open questions.
- **docker-compose.** A stdio MCP server is started by the client, once per session, with stdin attached. A compose service with no stdin and no port gives users nothing useful.

## 2. Deliverables

| File | Change |
|---|---|
| `Dockerfile` | New. Multi-stage build (§3). |
| `.dockerignore` | New. Keeps secrets and build output out of the build context (§4). |
| `src/utils/file-save.ts` | Add an optional `QUALTRICS_EXPORT_DIR` override for the export directory (§5.1). |
| `src/index.ts` | Shut down cleanly on `SIGTERM`/`SIGINT` (§5.2). |
| `src/config/settings.ts` | Optional: make the missing-config hint mention Docker (§5.3). |
| `tests/file-save.test.ts` | Test the `QUALTRICS_EXPORT_DIR` override. |
| `README.md` | New "Docker" section with build, run, and MCP client configuration; add `QUALTRICS_EXPORT_DIR` to the configuration table (§6). |
| `.env.example` | Add a commented `QUALTRICS_EXPORT_DIR`, and a note that `docker --env-file` does not strip quotes. |
| `.github/workflows/docker.yml` | Optional: a build-and-smoke-test check (§8). The repo has no CI today, so ask the maintainer before adding it. |

`CLAUDE.md`/`AGENTS.md` need no changes: the tool count and behaviour are unchanged.

## 3. Dockerfile design

A draft of the Dockerfile below was built and run in a test environment; the results are in §7. Required properties:

1. **Pin Node 22 on Debian slim** (`node:22-bookworm-slim`). `package.json` requires `node >=22` and `.npmrc` sets `engine-strict=true`. The tests run on 22. Corepack, which provides the pinned pnpm, is removed from Node 25+, so a floating `node:latest` would eventually break the build. Prefer glibc over Alpine: the dev-only `@typescript/native-preview` (`tsgo`) ships a native binary per platform, and glibc is the one the lockfile is known to resolve.
2. **Install with pnpm, not npm.** `package.json` pins `packageManager: pnpm@9.15.9`. The repo has both `pnpm-lock.yaml` and `package-lock.json`, and they have drifted: `@typescript/native-preview` is `"latest"` in `package.json` and resolves to `7.0.0-dev.20260303.1` in the pnpm lock but `…20260305.1` in the npm lock. Use `corepack enable` and `pnpm install --frozen-lockfile` so the image matches what `pnpm install` gives developers.
3. **Multi-stage.** The build stage installs dev dependencies, runs `pnpm build` (`tsgo -p tsconfig.build.json`), then `pnpm prune --prod`. The runtime stage copies only `package.json`, the pruned `node_modules` (about 24 MB: `@modelcontextprotocol/sdk` and `zod` plus their dependencies), and `build/`. It does not include `tsx`, `esbuild`, `tsgo`, sources, tests, or examples.
4. **Copy the build context explicitly, never with `COPY . .`.** Copy only the lockfile, manifests, and tsconfig files first, so the dependency layer stays cached; then copy `src/`. This, together with `.dockerignore`, keeps `.env` and `.mcp.json` out of every layer.
5. **Run as non-root.** Use the image's built-in `node` user (uid 1000) with `HOME=/home/node`.
6. **Create the export directory, owned by `node`, in the image.** Response exports over 100 KB are written to a directory. Without this step, a mounted named volume is created root-owned and the first large export fails with `EACCES`.
7. **Use exec-form `ENTRYPOINT ["node", "build/index.js"]`** with no shell wrapper, so signals reach Node and nothing but the MCP stream is written to stdout.
8. **No `EXPOSE` and no `HEALTHCHECK`.** The server has no port, and a health check cannot talk to a stdio process without consuming its protocol stream.
9. **Add OCI labels** (`org.opencontainers.image.source`, `.description`, `.licenses=MIT`) so registries and `docker inspect` show where the image came from.

Reference implementation (verified apart from the labels and the `QUALTRICS_EXPORT_DIR` line, which depend on §5.1):

```dockerfile
# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build && pnpm prune --prod

FROM node:22-bookworm-slim
LABEL org.opencontainers.image.source="https://github.com/yrvelez/qualtrics-mcp-server" \
      org.opencontainers.image.description="MCP server for Qualtrics survey programming (stdio)" \
      org.opencontainers.image.licenses="MIT"
ENV NODE_ENV=production \
    HOME=/home/node \
    QUALTRICS_EXPORT_DIR=/home/node/Downloads
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/build ./build
RUN mkdir -p /home/node/Downloads && chown node:node /home/node/Downloads
USER node
VOLUME ["/home/node/Downloads"]
ENTRYPOINT ["node", "build/index.js"]
```

Notes:

- `pnpm prune --prod` keeps the pnpm workspace layout. The `ignoredBuiltDependencies: [esbuild]` setting in `pnpm-workspace.yaml` is harmless, because `esbuild` is a dev-only dependency of `tsx` and is pruned.
- Application files belong to root and are read-only for `node`. That is intended: at runtime the server writes only to the export directory.
- Optional extra: a `gcr.io/distroless/nodejs22-debian12:nonroot` runtime stage is smaller and has no shell. It needs `ENTRYPOINT ["/nodejs/bin/node", "build/index.js"]` and a pre-created export directory copied in from the build stage. Keep `bookworm-slim` as the default unless the maintainer prefers distroless.

## 4. `.dockerignore`

```
.git
.github
.claude
node_modules
build
*.tsbuildinfo
.env
.env.*
!.env.example
.mcp.json
*.csv
export_*
survey_responses*
qualtrics_*_data.*
*.log
*.tgz
tests
examples
docs
```

This mirrors `.gitignore` and also excludes `.git`, tests, examples, and docs, which the image does not need. Excluding `.env` and `.mcp.json` matters even though the Dockerfile copies explicit paths: it protects against someone changing the Dockerfile to `COPY . .` later, and it keeps secrets out of the build context sent to remote builders.

## 5. Source changes

### 5.1 Configurable export directory (`QUALTRICS_EXPORT_DIR`)

`src/utils/file-save.ts` hard-codes `path.join(os.homedir(), "Downloads")`. In a container this resolves to `/home/node/Downloads`, which:

- disappears with the container (`--rm`) unless the user mounts a volume there, and
- is reported to the model and user as a container path (`/home/node/Downloads/survey_SV_…csv`), which means nothing on the host.

Change: resolve the directory **at call time** (the existing tests change `HOME` per test) as

```ts
const downloadsDirectory =
  process.env.QUALTRICS_EXPORT_DIR || path.join(os.homedir(), "Downloads");
```

- The filename-only validation for `saveToFile` stays exactly as it is. The env var moves the base directory; it never lets a tool argument choose one.
- Default behaviour outside Docker is unchanged.
- Add a test: with `QUALTRICS_EXPORT_DIR` set to a temp directory, a forced save lands there and not under `HOME`.
- Tool descriptions in `response-tools.ts` and `survey-tools.ts` say "your Downloads folder". Change them to "the export directory (Downloads by default)" or leave them; this is cosmetic.
- README documents that the reported path is the in-container path, and shows the matching `-v` mount (§6).

### 5.2 Graceful shutdown on SIGTERM

Node running as PID 1 has no default handler for `SIGTERM`, so `docker stop` waits out the full 10 s grace period and then sends `SIGKILL`. Measured: 10.2 s without `--init`, 0.17 s with it. Do not rely on users remembering `--init`. Add a handler to `src/index.ts`:

```ts
const shutdown = async () => {
  await server.close().catch(() => undefined);
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
```

(`server` needs to be in scope, so it should be hoisted out of the `try`.) This also helps non-Docker launches. The README examples still include `--init` as a cheap extra safeguard.

### 5.3 (Optional) Container-aware config error

When a token or data center is missing, the error tells the user to `cp .env.example .env` and run `pnpm start`. Neither applies inside a container. Add one line, such as `Docker: pass -e QUALTRICS_API_TOKEN -e QUALTRICS_DATA_CENTER to docker run`. Make no other behaviour change: the server still exits 1, and stderr carries the message.

## 6. README additions

Add a "Docker" section under Setup covering:

**Build**

```bash
docker build -t qualtrics-mcp-server .
```

**Smoke test** (prints the tool count; needs no real credentials, because nothing calls Qualtrics until a tool runs):

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
| docker run --rm -i -e QUALTRICS_API_TOKEN=x -e QUALTRICS_DATA_CENTER=iad1 qualtrics-mcp-server
```

**MCP client configuration**

```json
{
  "mcpServers": {
    "qualtrics": {
      "command": "/usr/local/bin/docker",
      "args": [
        "run", "--rm", "-i", "--init",
        "-e", "QUALTRICS_API_TOKEN",
        "-e", "QUALTRICS_DATA_CENTER",
        "-v", "/Users/you/Downloads/qualtrics:/home/node/Downloads",
        "qualtrics-mcp-server"
      ],
      "env": {
        "QUALTRICS_API_TOKEN": "your_api_token",
        "QUALTRICS_DATA_CENTER": "your_data_center_id"
      }
    }
  }
}
```

Points to state explicitly in the README:

- **`-i` is mandatory and `-t` must not be used** (§7, items 1 and 2).
- **Pass secrets by name** (`-e QUALTRICS_API_TOKEN` with no `=value`). The Docker CLI then copies the value from its own environment, which the MCP client's `env` block sets. This keeps the token out of `args`, where it would be visible in `ps` output and client logs. The value is still visible to anyone who can run `docker inspect` on the host.
- **Use an absolute path to `docker`.** The existing macOS troubleshooting section applies unchanged: GUI-launched clients have a minimal `PATH`. Docker Desktop installs `/usr/local/bin/docker`. Docker Desktop must also be running, or the server fails to start with no message shown in the client.
- **Do not add `--name`.** A fixed container name makes a second concurrent client session (for example, two Claude Desktop windows) fail with a name conflict.
- **Mount the export directory**, and know that paths in tool results are container paths. The table maps `/home/node/Downloads/<file>` to `<host mount>/<file>`.
- **Bind-mount ownership.** The container runs as uid 1000. If the host directory is not writable by uid 1000 (common on Linux when the host user is not uid 1000), large exports fail with `EACCES`. Fix it with `chown 1000 <dir>` or add `--user "$(id -u):$(id -g)"`. On macOS with Docker Desktop, file sharing hides the uid, so this does not come up.
- **`--env-file` is not dotenv.** Docker does not strip quotes or inline comments. `QUALTRICS_API_TOKEN="abc"` arrives as `"abc"` with the quote characters included, and `QUALTRICS_DATA_CENTER=iad1 # comment` arrives as `iad1 # comment`. `pnpm start` uses Node's `--env-file`, which does strip both. A `.env` that works with `pnpm start` can therefore produce 401s or a bad hostname in Docker. Recommend unquoted values with no inline comments.
- **Optional hardening** (verified working): `--read-only --cap-drop ALL --security-opt no-new-privileges`, plus either the Downloads volume or `--tmpfs /home/node/Downloads:uid=1000,gid=1000`.

## 7. Pitfalls found during prototyping

All of these were reproduced against a prototype image built from this repo at `0b40e26`.

| # | Pitfall | Observed | Mitigation |
|---|---|---|---|
| 1 | Running without `-i` | Server starts, gets EOF on stdin, **exits 0 silently**. Looks like success. | Document that `-i` is required. Optionally have `index.ts` log `stdin closed, exiting` to stderr when stdin ends. |
| 2 | Running with `-t` | `docker run -it` from a client fails ("cannot attach stdin to a TTY-enabled container"). If it does attach in a terminal, the TTY merges stderr into stdout and turns `\n` into `\r\n`, which corrupts JSON-RPC. | Document: `-i` only, never `-t`. |
| 3 | PID 1 signal handling | `docker stop` took **10.2 s** (SIGKILL after the timeout); 0.17 s with `--init`. | §5.2 handler, plus `--init` in the examples. |
| 4 | Export path not writable or not persisted | Bind-mounted host dir not owned by uid 1000 → `EACCES`. Without a mount, files vanish with `--rm`. | Pre-create the dir owned by `node`, add `VOLUME`, `QUALTRICS_EXPORT_DIR`, and document the ownership fix. |
| 5 | `--env-file` quoting differs from Node's `--env-file` | `"abc"` arrives with quotes; `iad1 # comment` arrives with the comment. | Document; keep `.env.example` unquoted and free of inline comments on value lines. |
| 6 | Stdout pollution | Only JSON-RPC appeared on stdout; the startup banner goes to stderr. | Keep it that way: exec-form `ENTRYPOINT`, no shell wrapper, no `npm start`/`pnpm start` (package managers print banners to stdout). |
| 7 | Orphaned containers | When the client `SIGKILL`s the `docker` CLI, the attach stream closes, the server sees EOF, and the container exits. No orphan was left. | No action. This depends on the server exiting at stdin EOF, which it already does; keep that behaviour. |
| 8 | Secrets in image layers / build context | Not present in the prototype, which copies explicit paths. | `.dockerignore` + explicit `COPY` (§3, §4). |
| 9 | Lockfile drift (`package-lock.json` vs `pnpm-lock.yaml`, `"latest"` dev dep) | The two locks resolve different `tsgo` builds. | Build with pnpm `--frozen-lockfile` only. Consider deleting `package-lock.json` or pinning `@typescript/native-preview` in a separate PR. |
| 10 | Corporate TLS-intercepting proxies | `corepack` (fetching pnpm) and pnpm (fetching packages) both failed with `SELF_SIGNED_CERT_IN_CHAIN` behind an intercepting proxy. | Document a build-secret escape hatch rather than baking CAs into the image: `RUN --mount=type=secret,id=ca,target=/ca.crt NODE_EXTRA_CA_CERTS=/ca.crt npm_config_cafile=/ca.crt pnpm install …`, with `docker build --secret id=ca,src=corp-ca.pem`. Proxies on `127.0.0.1` also need `--network=host` at build time. |
| 11 | Apple Silicon / arm64 | Native builds work: the lockfile includes `linux-arm64` `tsgo` binaries. | For a published image, build `linux/amd64,linux/arm64` with buildx. |
| 12 | Config errors | Missing env → exit 1 with a stderr message that tells the user to run `pnpm start`. | §5.3. |

Measured image size (prototype, `bookworm-slim`): **355 MB on disk / 83 MB compressed**, most of it the Node base image.

## 8. Verification and acceptance criteria

The PR is ready when:

1. `docker build -t qualtrics-mcp-server .` succeeds from a clean clone on linux/amd64 and linux/arm64 (or macOS arm64 via Docker Desktop).
2. The §6 smoke test returns `tools/list` with **112** tools, and stdout contains only JSON-RPC lines.
3. `docker run --rm -i qualtrics-mcp-server </dev/null` with no env exits **1**, and the missing-config message appears on stderr.
4. `docker stop` on a running container returns in under 1 s **without** `--init`, which shows that §5.2 works.
5. With `-v $PWD/out:/home/node/Downloads` (directory owned by uid 1000), a forced export (`saveExportToFile` path, or a real `export_responses` with `saveToFile`) creates the file on the host. If live Qualtrics credentials are not available, the unit test in §5.1 covers the directory logic.
6. `docker history`/`docker run --entrypoint sh … -c 'ls -a /app'` shows no `.env`, `.mcp.json`, `src/`, `tests/`, or dev dependencies (`tsx`, `esbuild`, `@typescript/*`).
7. `pnpm typecheck` and `pnpm test` still pass, including the new export-dir test.
8. The container runs with `--read-only --cap-drop ALL --security-opt no-new-privileges` plus a Downloads volume or tmpfs.
9. An MCP client (Claude Desktop or Claude Code) configured as in §6 lists the tools, and a read-only call such as `list_surveys` works with real credentials.

**Optional CI** (`.github/workflows/docker.yml`): on PRs touching `Dockerfile`, `.dockerignore`, `package.json`, the lockfile, or `src/**`, run `docker/build-push-action` with `push: false` and then the smoke test in criterion 2. Use the GitHub Actions cache (`cache-from/to: type=gha`) to keep it fast. The repo has no CI today, so offer this as a separable commit.

## 9. Open questions for the upstream maintainer

1. **Publish an image?** If yes: GHCR under `ghcr.io/yrvelez/qualtrics-mcp-server`, multi-arch, tagged on release. Users could then skip the build step, and the README could use the published image name.
2. **Distroless or slim runtime?** Distroless is smaller and has no shell, which makes debugging harder. The proposed default is slim.
3. **Host-path reporting for exports.** Should the server accept something like `QUALTRICS_EXPORT_HOST_DIR`, so that tool results report the host-side path instead of `/home/node/Downloads/...`? It is small to build but adds a configuration knob. The proposal is to document the mapping in this PR and revisit if users find it confusing.
4. **Lockfile cleanup** (pitfall 9): fine to handle in a follow-up PR?

## 10. Implementation plan

1. Add `.dockerignore` and `Dockerfile` (§3, §4).
2. Add `QUALTRICS_EXPORT_DIR` with a test (§5.1), the SIGTERM handler (§5.2), and optionally the config hint (§5.3).
3. Update README and `.env.example` (§6).
4. Run `pnpm typecheck`, `pnpm test`, and acceptance checks 1–8.
5. Optionally add the CI workflow (§8).
6. Open the PR against `yrvelez/qualtrics-mcp-server:main` from this fork, linking to this spec's decisions. Before opening, decide whether this spec file goes in the upstream PR or stays in the fork; the README section may be enough on its own.
