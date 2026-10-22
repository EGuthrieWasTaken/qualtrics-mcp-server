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
      org.opencontainers.image.description="MCP server for Qualtrics survey programming (stdio by default, optional Streamable HTTP)" \
      org.opencontainers.image.licenses="MIT"
# MCP_HTTP_* only apply to build/http.js. That entrypoint refuses to listen on
# 0.0.0.0 unless MCP_AUTH_TOKEN is set (or MCP_ALLOW_UNAUTHENTICATED=true).
ENV NODE_ENV=production \
    HOME=/home/node \
    QUALTRICS_EXPORT_DIR=/home/node/Downloads \
    MCP_HTTP_HOST=0.0.0.0 \
    MCP_HTTP_PORT=3000
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/build ./build
RUN mkdir -p /home/node/Downloads && chown node:node /home/node/Downloads
USER node
VOLUME ["/home/node/Downloads"]
# Exec form with no shell wrapper, so signals reach Node and nothing but the
# MCP stream reaches stdout. The default command is the stdio server; run
# `build/http.js` instead for Streamable HTTP. No EXPOSE or HEALTHCHECK: the
# default mode has no port, and a check cannot talk to a stdio process. The
# compose example adds both for HTTP mode.
ENTRYPOINT ["node"]
CMD ["build/index.js"]
