FROM node:22-bookworm-slim AS base

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY packages ./packages
COPY evals ./evals
COPY scripts ./scripts
COPY tsconfig.json ./
COPY types ./types

RUN npm ci
RUN npm run build
RUN npm run dashboard:build

EXPOSE 4175

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4175/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "run", "server"]
