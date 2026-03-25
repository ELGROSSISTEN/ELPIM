-- Drop concurrency column from RunCampaign (unused — worker is hardcoded to 1)
ALTER TABLE "RunCampaign" DROP COLUMN IF EXISTS "concurrency";

-- Change batchSize default to 1 (individual product calls = better AI quality)
ALTER TABLE "RunCampaign" ALTER COLUMN "batchSize" SET DEFAULT 1;
