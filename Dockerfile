FROM node:22.23.4-bookworm AS build

WORKDIR /app
RUN python3 --version && make --version && g++ --version

COPY package.json package-lock.json ./
COPY packages/ai/package.json ./packages/ai/
COPY packages/agent/package.json ./packages/agent/
COPY packages/coding-agent/package.json ./packages/coding-agent/
COPY packages/tui/package.json ./packages/tui/
COPY packages/db/package.json ./packages/db/
COPY packages/security/package.json ./packages/security/
COPY packages/runtime/package.json ./packages/runtime/
COPY packages/server/package.json ./packages/server/
COPY packages/dashboard/package.json ./packages/dashboard/
RUN npm ci --include=dev

COPY packages ./packages
COPY evals ./evals
COPY scripts ./scripts
COPY tsconfig.json tsconfig.base.json ./
COPY types ./types

RUN npm run check
RUN npm run build
RUN npm run check:package-boundaries
RUN npm run dashboard:build
RUN npm prune --omit=dev

FROM node:22.23.4-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production AGENT_SERVER_HOST=0.0.0.0 AGENT_SERVER_PORT=4175 AGENT_DB_PATH=/app/data/agent-ops.sqlite
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/packages ./packages
RUN mkdir -p /app/data && chown node:node /app/data
USER node

EXPOSE 4175

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4175/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "packages/server/dist/entry.js"]
