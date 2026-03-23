-- Add initialSyncAt to Shop: tracks when the first full product pull completed.
-- After this is set, the periodic auto-sync is disabled — webhooks take over.
ALTER TABLE "Shop" ADD COLUMN IF NOT EXISTS "initialSyncAt" TIMESTAMP(3);
