#!/usr/bin/env bash
# Smoke-test a built image, in both stdio and HTTP mode.
#
#   scripts/docker-smoke-test.sh [image]        (default image: qualtrics-mcp-server)
#
# Uses dummy credentials; nothing here calls Qualtrics. Needs docker, curl and node.
# EXPECTED_TOOLS (default 112) and SMOKE_PORT (default 3999) can be overridden.
set -euo pipefail

IMAGE="${1:-qualtrics-mcp-server}"
EXPECTED_TOOLS="${EXPECTED_TOOLS:-112}"
PORT="${SMOKE_PORT:-3999}"
NAME="qualtrics-mcp-smoke-$$"
WORK="$(mktemp -d)"
CREDS=(-e QUALTRICS_API_TOKEN=x -e QUALTRICS_DATA_CENTER=iad1)

trap 'docker rm -f "$NAME" >/dev/null 2>&1 || true; rm -rf "$WORK"' EXIT

pass() { echo "ok   $*"; }
fail() { echo "FAIL $*" >&2; exit 1; }

INITIALIZE='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}'
INITIALIZED='{"jsonrpc":"2.0","method":"notifications/initialized"}'
TOOLS_LIST='{"jsonrpc":"2.0","id":2,"method":"tools/list"}'

# Print the number of tools in a tools/list response. The file holds either
# newline-delimited JSON-RPC (stdio) or JSON / server-sent events (HTTP).
# With a second argument of 1, also fail unless every line is a JSON-RPC 2.0 message.
tool_count() {
  STRICT="${2:-0}" node -e '
    const lines = require("fs").readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean);
    const payloads = lines.map((l) => (l.startsWith("data:") ? l.slice(5) : l));
    let found;
    for (const [i, raw] of payloads.entries()) {
      let message;
      try { message = JSON.parse(raw); } catch {
        if (process.env.STRICT === "1") { console.error("not JSON: " + lines[i].slice(0, 80)); process.exit(1); }
        continue;
      }
      if (process.env.STRICT === "1" && message.jsonrpc !== "2.0") { console.error("not JSON-RPC: " + raw.slice(0, 80)); process.exit(1); }
      if (message.id === 2 && message.result) found = message.result.tools.length;
    }
    if (found === undefined) { console.error("no tools/list result"); process.exit(1); }
    console.log(found);
  ' "$1"
}

# Run a command that is expected to exit with the given status.
expect_exit() {
  local want="$1" got=0
  shift
  "$@" >"$WORK/out" 2>"$WORK/err" </dev/null || got=$?
  [ "$got" -eq "$want" ] || fail "expected exit $want, got $got from: $*"
}

# Start a server that must refuse to run: it has to exit with status 1 on its
# own, and its stdout and stderr are left in $WORK/out and $WORK/err.
expect_refusal() {
  local got
  docker run -d --name "$NAME" "$@" >/dev/null
  got=$(timeout 30 docker wait "$NAME") || fail "the container kept running; expected it to refuse to start: $*"
  docker logs "$NAME" >"$WORK/out" 2>"$WORK/err"
  docker rm -f "$NAME" >/dev/null
  [ "$got" -eq 1 ] || fail "expected exit 1, got $got from: $*"
}

stop_seconds() {
  local start end
  start=$(date +%s)
  docker stop "$NAME" >/dev/null
  end=$(date +%s)
  echo $((end - start))
}

echo "Smoke-testing $IMAGE"

# --- Image hygiene ---------------------------------------------------------
[ "$(docker inspect -f '{{.Config.User}}' "$IMAGE")" = "node" ] || fail "image does not run as the node user"
docker run --rm --entrypoint sh "$IMAGE" -c '
  test -f /app/build/index.js && test -f /app/build/http.js &&
  ! test -e /app/src && ! test -e /app/tests && ! test -e /app/.env && ! test -e /app/.mcp.json &&
  ! ls /app/node_modules/.pnpm | grep -qE "^(tsx|esbuild|@typescript)"
' || fail "image contents: expected build/ only, with no sources, secrets or dev dependencies"
pass "runs as node; contains build/ and production dependencies only"

# --- stdio (the default) ---------------------------------------------------
printf '%s\n' "$INITIALIZE" "$INITIALIZED" "$TOOLS_LIST" |
  docker run --rm -i "${CREDS[@]}" "$IMAGE" >"$WORK/stdio.out" 2>"$WORK/stdio.err" ||
  fail "stdio server exited non-zero: $(cat "$WORK/stdio.err")"
count=$(tool_count "$WORK/stdio.out" 1) || fail "stdio output is not clean JSON-RPC"
[ "$count" -eq "$EXPECTED_TOOLS" ] || fail "stdio lists $count tools, expected $EXPECTED_TOOLS"
pass "stdio: $count tools and only JSON-RPC on stdout"

expect_exit 1 docker run --rm -i "$IMAGE"
grep -q "missing configuration" "$WORK/err" || fail "missing config gave no message on stderr"
[ ! -s "$WORK/out" ] || fail "missing config wrote to stdout"
pass "stdio: exits 1 with a message on stderr when configuration is missing"

docker run -d -i --name "$NAME" "${CREDS[@]}" "$IMAGE" >/dev/null
sleep 2
elapsed=$(stop_seconds)
[ "$elapsed" -lt 5 ] || fail "stdio: docker stop took ${elapsed}s (SIGTERM is not handled)"
[ "$(docker inspect -f '{{.State.ExitCode}}' "$NAME")" = "0" ] || fail "stdio: did not exit 0 on SIGTERM"
docker rm "$NAME" >/dev/null
pass "stdio: stops cleanly in ${elapsed}s without --init"

# --- HTTP ------------------------------------------------------------------
expect_refusal "${CREDS[@]}" "$IMAGE" build/http.js
grep -q "without authentication" "$WORK/err" || fail "http: starting with no credentials was not refused"
pass "http: refuses to listen without a credential"

expect_refusal -e MCP_AUTH_TOKEN=smoke-key "$IMAGE" build/http.js
grep -q "missing configuration" "$WORK/err" || fail "http: missing Qualtrics config was not reported"
pass "http: exits 1 when the Qualtrics configuration is missing"

docker run -d --name "$NAME" -p "127.0.0.1:$PORT:3000" "${CREDS[@]}" -e MCP_AUTH_TOKEN=smoke-key "$IMAGE" build/http.js >/dev/null
for _ in $(seq 1 40); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/healthz" || true)" = "200" ] && break
  sleep 0.5
done
status() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
[ "$(status "http://127.0.0.1:$PORT/healthz")" = "200" ] || fail "http: /healthz did not return 200: $(docker logs "$NAME" 2>&1 | tail -3)"

URL="http://127.0.0.1:$PORT/mcp"
MCP_HEADERS=(-H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream')
[ "$(status -X POST "$URL" "${MCP_HEADERS[@]}" -d "$INITIALIZE")" = "401" ] || fail "http: a request with no key was not rejected"
[ "$(status -X POST "$URL" "${MCP_HEADERS[@]}" -H 'X-API-Key: wrong' -d "$INITIALIZE")" = "401" ] || fail "http: a wrong key was not rejected"

curl -s -D "$WORK/headers" -o /dev/null -X POST "$URL" "${MCP_HEADERS[@]}" -H 'X-API-Key: smoke-key' -d "$INITIALIZE"
session=$(tr -d '\r' <"$WORK/headers" | awk -F': ' 'tolower($1)=="mcp-session-id" {print $2}')
[ -n "$session" ] || fail "http: initialize with the right key returned no session"
authed=(-H 'Authorization: Bearer smoke-key' -H "Mcp-Session-Id: $session")
curl -s -o /dev/null -X POST "$URL" "${MCP_HEADERS[@]}" "${authed[@]}" -d "$INITIALIZED"
curl -s -X POST "$URL" "${MCP_HEADERS[@]}" "${authed[@]}" -d "$TOOLS_LIST" >"$WORK/http.out"
count=$(tool_count "$WORK/http.out") || fail "http: no tools/list result"
[ "$count" -eq "$EXPECTED_TOOLS" ] || fail "http lists $count tools, expected $EXPECTED_TOOLS"
pass "http: rejects a missing or wrong key, accepts X-API-Key and Bearer, lists $count tools"

elapsed=$(stop_seconds)
[ "$elapsed" -lt 5 ] || fail "http: docker stop took ${elapsed}s (SIGTERM is not handled)"
[ "$(docker inspect -f '{{.State.ExitCode}}' "$NAME")" = "0" ] || fail "http: did not exit 0 on SIGTERM"
pass "http: stops cleanly in ${elapsed}s without --init"

echo "All smoke tests passed."
