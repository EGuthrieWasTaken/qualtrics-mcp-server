# syntax=docker/dockerfile:1

# Container image for the Streamable HTTP entrypoint (src/http.ts).
# The default stdio entrypoint is meant to be spawned by a local MCP client and
# does not need a container.

ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build

FROM node:${NODE_VERSION}-slim AS prod-deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm install --frozen-lockfile --prod

FROM node:${NODE_VERSION}-slim
ENV NODE_ENV=production \
    MCP_HTTP_HOST=0.0.0.0 \
    MCP_HTTP_PORT=3000
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/build ./build
COPY package.json ./

# Response exports are written to $HOME/Downloads inside the container.
# Mount a volume here if you want to keep them.
RUN mkdir -p /home/node/Downloads && chown -R node:node /home/node
USER node
VOLUME ["/home/node/Downloads"]

EXPOSE 3000

# The server refuses to listen on 0.0.0.0 unless MCP_AUTH_TOKEN is set (or
# MCP_ALLOW_UNAUTHENTICATED=true because an authenticating proxy is in front).
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.MCP_HTTP_PORT || 3000) + '/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "build/http.js"]
