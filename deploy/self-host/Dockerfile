# syntax=docker/dockerfile:1

FROM node:24-slim AS build

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@11.5.1 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY admin/package.json admin/package.json
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm provider:compile -- --output worker/generated/provider-snapshot.json \
  && pnpm --dir admin build

FROM node:24-slim AS runtime

ENV NODE_ENV=production \
  WRANGLER_SEND_METRICS=false

WORKDIR /app

RUN mkdir -p /data \
  && chown node:node /app /data

COPY --from=build --chown=node:node /app /app

USER node

EXPOSE 8787
VOLUME ["/data"]

ENTRYPOINT ["node", "deploy/self-host/entrypoint.mjs"]
