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
