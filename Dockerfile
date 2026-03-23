# ─────────────────────────────────────────────────────────────
# Multi-stage Dockerfile for Railway (ePIM monorepo)
# Targets: api, worker, web
# ─────────────────────────────────────────────────────────────

# ── Base: install all deps ──────────────────────────────────
FROM node:20-slim AS base
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
RUN apt-get update -qq && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/crypto/package.json packages/crypto/
COPY packages/db/package.json packages/db/
COPY packages/shopify/package.json packages/shopify/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/

RUN pnpm install --frozen-lockfile

# ── Build: compile everything ───────────────────────────────
FROM base AS build
COPY . .
RUN pnpm --filter @epim/db exec prisma generate
RUN pnpm run build

# ── Prune: create deploy-ready node_modules per service ─────
FROM base AS prune-api
COPY --from=build /app .
RUN pnpm deploy --filter @epim/api --prod /deploy/api

FROM base AS prune-worker
COPY --from=build /app .
RUN pnpm deploy --filter @epim/worker --prod /deploy/worker

# ── API service ─────────────────────────────────────────────
FROM node:20-slim AS api
RUN apt-get update -qq && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app

COPY --from=prune-api /deploy/api .
COPY --from=build /app/packages/db/prisma ./prisma

ENV NODE_ENV=production
EXPOSE 4000

# Run migrations then start
CMD ["sh", "-c", "npx prisma migrate deploy --schema ./prisma/schema.prisma && node dist/server.js"]

# ── Worker service ──────────────────────────────────────────
FROM node:20-slim AS worker
RUN apt-get update -qq && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app

COPY --from=prune-worker /deploy/worker .

ENV NODE_ENV=production

CMD ["node", "dist/worker.js"]

# ── Web (Next.js standalone) ────────────────────────────────
FROM node:20-slim AS web
RUN apt-get update -qq && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app

COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static

ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
EXPOSE 3000

CMD ["node", "apps/web/server.js"]
