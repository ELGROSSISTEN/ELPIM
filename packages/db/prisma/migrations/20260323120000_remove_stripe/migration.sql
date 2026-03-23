-- Remove Stripe fields from Organization
ALTER TABLE "Organization" DROP COLUMN IF EXISTS "stripeCustomerId";

-- Remove Stripe fields from ShopSubscription
ALTER TABLE "ShopSubscription" DROP COLUMN IF EXISTS "stripeCustomerId";
ALTER TABLE "ShopSubscription" DROP COLUMN IF EXISTS "stripeSubscriptionId";

-- Remove stripeInvoiceId from BillingLedgerMonth
ALTER TABLE "BillingLedgerMonth" DROP COLUMN IF EXISTS "stripeInvoiceId";

-- Drop StripeWebhookEvent table
DROP TABLE IF EXISTS "StripeWebhookEvent";
