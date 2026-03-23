# EL-PIM SaaS Multi-Tenancy Implementation Plan

Status: Approved product decisions integrated (2026-03-08)
Owner: Platform/backend

## 1. Scope and fixed product decisions

This document codifies the agreed SaaS model:

- Multiple users with different roles can collaborate on the same webshop.
- Platform admins have access to all customer shops by default.
- Subscription is strict 1:1 per webshop.
- Usage is tracked per webshop.
- Billable usage in v1 is only `ai/apply`.
- Billing period is calendar month (`YYYY-MM`, first to last day).
- Payment provider is Stripe.
- Prices are ex VAT, DK VAT fixed at 25%.
- OpenAI key is platform-owned (not customer-provided).
- Users can belong to multiple customers/organizations (agency users).
- No hard usage limits.
- Notifications are both in-app and email:
  - at 100/100 included units reached
  - at first overage unit in month
- First month base price must be prorated.

## 2. Current state (from codebase)

- Tenant isolation currently relies on `shopId` across domain tables.
- Access model is currently single-shop-per-user (`User.shopId`).
- JWT includes `shopId`, and most endpoints require connected shop.
- `AiUsage` exists and tracks model/token/cost, but is not suitable as the billing source of truth.
- Snapshot/ChangeLog/SyncJob invariants are in place and must be preserved.

## 3. Target tenancy model

### 3.1 Domain model

- `Organization`: customer account boundary.
- `Shop`: remains data boundary for products/fields/sync, now owned by one organization.
- `OrganizationMembership`: user -> organization role.
- `ShopMembership` (optional explicit override): user -> shop role within organization.
- `User.platformRole`: platform-level access (`none`, `platform_admin`, `platform_support`).

### 3.2 Access rules

- `platform_admin`: read/write access to all orgs and shops.
- `platform_support`: default read-all, scoped write by policy.
- `org_owner|org_admin|org_member`: access only via memberships.
- Agency user: user can hold memberships in multiple organizations/shops.

## 4. Billing and metering model

### 4.1 Subscription entity (per shop)

One active subscription per webshop:

- `shopId` unique.
- Stripe identifiers (`stripeCustomerId`, `stripeSubscriptionId`).
- Price params:
  - `basePriceMinor = 99900` (DKK cents)
  - `includedUnitsPerMonth = 100`
  - `overageUnitMinor = 50` (0.50 DKK)
- Current period fields aligned to calendar month.

### 4.2 Billing usage source of truth

Create immutable `UsageEvent` rows (not mutable counters) for billing:

- `type = ai_datapoint_generated`
- `quantity = 1`
- `billingMonth = YYYY-MM`
- `idempotencyKey` unique
- `shopId`
- `occurredAt`

v1 event emission point:

- Worker `ai-jobs` processing of `/ai/apply`.
- Emit one `UsageEvent` for each successful field value write (`fieldValue.upsert`).

Idempotency key template:

- `${syncJobId}:${ownerType}:${ownerId}:${fieldDefinitionId}`

### 4.3 Monthly pricing math

Definitions for a given `shopId + monthKey`:

- `consumed = SUM(quantity)`
- `included = 100`
- `overage = max(consumed - included, 0)`
- `base = 99900` (minor)
- `overageAmount = overage * 50`
- `subtotalExVat = base + overageAmount`
- `vat = round(subtotalExVat * 0.25)`
- `totalIncVat = subtotalExVat + vat`

### 4.4 First month proration

Rule: first month base price is prorated by active calendar days.

- Let:
  - `daysInMonth`
  - `activeDaysInFirstMonth = (monthEndDate - activationDate + 1)`
- `prorationRatio = activeDaysInFirstMonth / daysInMonth`
- `proratedBaseMinor = round(99900 * prorationRatio)`

Notes:

- Overage stays non-prorated per unit.
- Included units remain 100 for the month unless product decides otherwise.
- Recommendation: keep included units at full 100 in first month unless explicitly changed.

## 5. Notifications (in-app + email)

### 5.1 Trigger events

For each `shopId + monthKey`:

- Trigger A: when consumed reaches exactly 100 (first time in month)
- Trigger B: when consumed becomes 101 (first overage unit in month)

### 5.2 Deduplication

Use `UsageNotice` table with unique `(shopId, monthKey, kind)` to avoid duplicate sends.

Kinds:

- `included_reached_100`
- `overage_started`

### 5.3 Delivery channels

- In-app:
  - surfaced in dashboard + activity center.
- Email:
  - to organization billing/admin recipients.
  - include month usage summary, current estimate, and pricing reminder.

## 6. API contract changes

### 6.1 New context model

Replace implicit single-shop by explicit active context.

- request header: `X-EPIM-Shop-Id`
- JWT claims:
  - `sub`
  - `platformRole`
  - optional defaults: `defaultOrganizationId`, `defaultShopId`

### 6.2 New/updated endpoints

- `GET /tenancy/context`
  - returns available organizations/shops and selected context.
- `POST /tenancy/context/select-shop`
  - validates access and persists selection.
- `GET /shops/:id/subscription`
- `POST /shops/:id/subscription`
- `GET /shops/:id/usage?month=YYYY-MM`
- `GET /shops/:id/billing-preview?month=YYYY-MM`
- `GET /shops/:id/notifications`
- `GET /billing/ledger?month=YYYY-MM&shopId=<optional>`
- `GET /billing/webhook-events?provider=stripe&status=<optional>&limit=<optional>`
- `POST /webhooks/stripe` with replay protection using persisted event log

Web UI operations page:

- `apps/web/app/settings/billing/page.tsx`
  - Run `close-month` preview/finalize
  - View monthly ledger rows and totals
  - View Stripe webhook processing history
  - Resend billing notices (`/billing/notices/resend`)
  - Retry failed webhook events (`/billing/webhook-events/:id/retry`)

### 6.3 Existing endpoint migration

All current routes that depend on `user.shopId` must be migrated to context middleware:

- `requireActiveShop`
- `requireShopAccess`
- `requirePlatformOrShopRole`

## 7. Stripe integration design

### 7.1 Object mapping

- Stripe Customer: one per Organization.
- Stripe Subscription: one per Shop.
- Metadata include internal IDs (`organizationId`, `shopId`, `monthKey` where relevant).

### 7.2 Invoice strategy

v1 recommended strategy:

- Internal monthly ledger (`BillingLedgerMonth`) as source of truth.
- Push invoice items/final invoice to Stripe after monthly close.

Why:

- Keeps event auditability internal.
- Easier to reconcile and correct in early rollout.

## 8. Prisma migration plan (safe rollout)

### PR-A: Additive schema only

- Add enums/models:
  - `PlatformRole`, `OrganizationRole`, `SubscriptionStatus`, `UsageEventType`
  - `Organization`, `OrganizationMembership`, `ShopMembership`
  - `ShopSubscription`, `UsageEvent`, `BillingLedgerMonth`, `UsageNotice`
- Add `Shop.organizationId` nullable.
- Add `User.platformRole` with default `none`.
- Keep `User.shopId` (legacy compatibility).

### PR-B: Backfill and seeds

- Backfill script:
  - create one organization per existing shop
  - attach shop to organization
  - create org memberships for existing users
- seed update for local environments with one org + one shop + one owner.

### PR-C: Auth/context middleware

- Add active shop resolution from header.
- Add authorization helpers for platform/admin/member semantics.
- Keep existing behavior behind compatibility fallback while migrating.

### PR-D: API migration

- Incrementally replace `user.shopId` checks with middleware context.
- Update `/shops/current` semantics to selected shop.

### PR-E: Usage event emission

- Add usage event writes in worker `ai/apply`.
- Add idempotency on event writes.
- Add month-key helper utility.

### PR-F: Monthly ledger + notifications

- Create monthly aggregation job.
- Trigger usage notices (100 reached, overage started).
- Add in-app notification retrieval endpoint.
- Email sender integration.

### PR-G: Stripe wiring

- Provision customer/subscription on shop activation.
- Sync billing ledger output into Stripe invoice cycle.

### PR-H: UI

- Add org/shop selector in app shell.
- Add subscription + usage panel.
- Add billing warning banners and activity events.

### PR-I: Cleanup

- Remove dependency on `User.shopId` from runtime code.
- Optional DB migration to drop `User.shopId` after stabilization window.

## 9. Testing strategy

Mandatory tests:

- Tenant isolation:
  - user from org A cannot access shop in org B.
- Platform admin global access.
- Agency user cross-org access correctness.
- Usage idempotency under worker retries.
- Monthly ledger correctness:
  - exactly 100 units
  - first overage at 101
  - high-overage scenarios
- First-month proration correctness across month lengths.
- VAT calculation and rounding behavior.
- Notification dedupe behavior per month.

## 10. Operational concerns

- Preserve existing invariants:
  - every write => Snapshot + ChangeLog
  - outbound writes => SyncJob
  - webhook idempotency
- Add structured logs for billing events and notice sends.
- Add metrics:
  - usage events per shop/day
  - overage shops per month
  - failed notice sends
  - billing close durations/failures

## 11. Implementation checklist (execution order)

1. Deliver PR-A and run migrations in dev.
2. Deliver PR-B and backfill existing data.
3. Deliver PR-C and ship middleware behind feature flag.
4. Deliver PR-D route migration in small batches.
5. Deliver PR-E usage events from `ai/apply` only.
6. Deliver PR-F notices + monthly ledger.
7. Deliver PR-G Stripe invoice pipeline.
8. Deliver PR-H UI context switch + billing UX.
9. Deliver PR-I removal of legacy `User.shopId` runtime dependency.

## 12. Open product decision (single, optional)

- First-month included units policy:
  - Option A: keep `100 included` even in prorated month.
  - Option B: prorate included units by same ratio as base.

If not explicitly chosen, default to Option A to stay customer-friendly and reduce support friction.
