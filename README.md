# ePIM

Shopify-first Cloud PIM monorepo (Next.js + Fastify + BullMQ + Prisma/Postgres + Redis), built with pnpm + Turborepo.

## Architecture overview

- `apps/web`: Next.js App Router UI
- `apps/api`: Fastify REST API + auth + webhooks + billing ops
- `apps/worker`: BullMQ workers for sync/import/AI apply
- `packages/db`: Prisma schema/client + seed/backfill scripts
- `packages/shared`: shared types, schemas, billing/conflict logic
- `packages/shopify`: Shopify Admin GraphQL client + webhook verify
- `packages/crypto`: encryption helpers
- `infra/docker-compose.yml`: local Postgres + Redis

## Test-ready runbook

Use this sequence to get to a clean, testable environment.

1. Start infra:
```bash
docker compose -f infra/docker-compose.yml up -d
```

2. Install dependencies:
```bash
pnpm i
```

3. Generate Prisma client and align DB schema:
```bash
pnpm db:generate
pnpm db:migrate
```

4. Seed and backfill local data:
```bash
pnpm db:seed
pnpm db:backfill:multitenancy
```

5. Run readiness checks:
```bash
pnpm qa:ready
```

6. Start full stack:
```bash
pnpm dev
```

7. Run e2e smoke tests in a separate terminal:
```bash
pnpm qa:e2e
```

If all commands above pass, the system is ready for manual and automated test cycles.

## App URLs

- Web: `http://localhost:3000`
- API: `http://localhost:4000` (`/health`, `/metrics`)
- Worker health: `http://localhost:4100/health`
- Billing Ops UI: `http://localhost:3000/settings/billing`
- Onboarding wizard: `http://localhost:3000/onboarding`
- Platform settings (admin): `http://localhost:3000/settings/platform`

## Billing operations

API endpoints for billing/admin:

- `POST /billing/close-month` (preview/finalize monthly ledger)
- `GET /billing/ledger?month=YYYY-MM`
- `GET /billing/webhook-events?provider=stripe&limit=100`
- `POST /billing/notices/resend`
- `POST /billing/webhook-events/:id/retry`
- `GET /billing/audit-log?limit=100`
- `POST /admin/shops` (platform admin/support can create shops directly)
- `GET /admin/shops` (list shops with server-side `q`, `plan`, `status`, `sortBy`, `sortDir`, `page`, `pageSize`)
- `PUT /admin/shops/:id/plan` (`standard` or `unlimited`)
- `POST /admin/shops/:id/archive` (archive/disconnect a shop)

## Onboarding flow (new)

1. User goes to `/register` and creates account.
2. User is redirected to `/onboarding`.
3. User can connect and create one or many webshops.
4. Access to protected webshop features requires:
	- active subscription, or
	- active trial (`trialing` and not expired).
5. If no active subscription/trial exists, protected routes return `402` and web app routes user back to Shopify integration for activation.

Platform admin controls:

- In `/settings/integrations/shopify`, platform admin/support can set global trial policy.
- Platform admin can create shops directly from `/settings/platform`.
- Shop creation can use:
	- `standard` (trial/subscription flow), or
	- `unlimited` (gratis UNLIMITED-abonnement).
- Shops management on `/settings/platform` includes search + filters (plan/status/owner/shop).
- Trial policy supports enable/disable + configurable trial length (default 14 days).

Stripe webhook:

- `POST /webhooks/stripe`
- Signature checked from `stripe-signature`
- Replay protection through `StripeWebhookEvent`

## Required environment variables

Set in root `.env` and app-specific `.env` files as needed.

Core:

- `DATABASE_URL`
- `REDIS_URL`
- `JWT_SECRET`
- `MASTER_ENCRYPTION_KEY`
- `SHOPIFY_WEBHOOK_SECRET`
- `SHOPIFY_WEBHOOK_CALLBACK_BASE_URL`
- `NEXT_PUBLIC_API_URL`

API billing/stripe:

- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `STRIPE_BASE_PRICE_ID`
- `APP_BASE_URL`
- `RESEND_API_KEY` (if using API-side resend notices)
- `EMAIL_FROM` (if using API-side resend notices)

Worker notices:

- `RESEND_API_KEY` (optional)
- `EMAIL_FROM` (optional)
- `APP_BASE_URL` (optional)

## Scripts

- `pnpm dev` - start all packages in watch mode
- `pnpm qa:ready` - API tests + typechecks + shared tests
- `pnpm qa:e2e` - Playwright smoke suite
- `pnpm db:generate` - Prisma client generation
- `pnpm db:migrate` - apply Prisma migrations
- `pnpm db:seed` - seed demo data
- `pnpm db:backfill:multitenancy` - backfill org/membership/subscription data

## Troubleshooting

### `pnpm dev` fails on API/worker env loading

Use the provided scripts in `apps/api/package.json` and `apps/worker/package.json`.
They now use `tsx --watch --env-file=.env ...` and should work on Node 20.

### Prisma schema mismatch/runtime column missing

Run:
```bash
pnpm db:migrate
pnpm db:generate
```

If your local DB is heavily drifted during development, reset locally:
```bash
pnpm --filter @epim/db exec prisma migrate reset --force --skip-generate
pnpm db:migrate
pnpm db:seed
pnpm db:backfill:multitenancy
```

### E2E cannot login / missing seed data

Smoke tests now create their own users via API, so seed is no longer required for login itself.
You still need a migrated database and running API/web services.
