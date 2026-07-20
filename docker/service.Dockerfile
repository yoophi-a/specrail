# syntax=docker/dockerfile:1.7

ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=${PNPM_HOME}:${PATH}
WORKDIR /workspace
RUN corepack enable

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/github/package.json apps/github/package.json
COPY apps/telegram/package.json apps/telegram/package.json
COPY apps/acp-server/package.json apps/acp-server/package.json
COPY apps/terminal/package.json apps/terminal/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/adapters/package.json packages/adapters/package.json
RUN pnpm install --frozen-lockfile

FROM deps AS build
ARG SERVICE_PACKAGE
COPY . .
RUN pnpm build
RUN pnpm check:built-entrypoints
RUN pnpm check:built-health
RUN test -n "${SERVICE_PACKAGE}"
RUN pnpm --filter "${SERVICE_PACKAGE}" deploy --prod --legacy /runtime
RUN node -e "const fs = require('node:fs'); const pkg = JSON.parse(fs.readFileSync('/runtime/package.json', 'utf8')); const command = pkg.scripts && pkg.scripts['start:built']; if (!command) throw new Error('missing start:built script'); fs.writeFileSync('/runtime/start-built.sh', '#!/bin/sh\\nexec ' + command + ' \"$@\"\\n');"
RUN chmod 0755 /runtime/start-built.sh

FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ARG SERVICE_PORT
ENV NODE_ENV=production
WORKDIR /app
RUN groupadd --system --gid 1001 specrail \
  && useradd --system --uid 1001 --gid specrail --home-dir /app --shell /usr/sbin/nologin specrail
COPY --from=build --chown=specrail:specrail /runtime ./
RUN rm -rf /app/src \
  /app/node_modules/@specrail/*/src \
  /app/node_modules/.pnpm/@specrail+*/node_modules/@specrail/*/src \
  /app/node_modules/.pnpm/node_modules/@specrail/*/src \
  && find /app -path "/app/node_modules/@specrail/*/__tests__" -prune -exec rm -rf {} + \
  && find /app -path "/app/node_modules/.pnpm/@specrail+*/node_modules/@specrail/*/__tests__" -prune -exec rm -rf {} + \
  && find /app -path "/app/node_modules/.pnpm/node_modules/@specrail/*/__tests__" -prune -exec rm -rf {} + \
  && rm -f /app/tsconfig.json \
  /app/node_modules/@specrail/*/tsconfig.json \
  /app/node_modules/.pnpm/@specrail+*/node_modules/@specrail/*/tsconfig.json \
  /app/node_modules/.pnpm/node_modules/@specrail/*/tsconfig.json
USER specrail
EXPOSE ${SERVICE_PORT}
CMD ["./start-built.sh"]
