-- RunCampaignItem: generated text values, EAN, sync timestamp
ALTER TABLE "RunCampaignItem" ADD COLUMN "ean" TEXT;
ALTER TABLE "RunCampaignItem" ADD COLUMN "fieldValuesJson" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "RunCampaignItem" ADD COLUMN "syncedAt" TIMESTAMP(3);

-- RunCampaign: token + cost tracking
ALTER TABLE "RunCampaign" ADD COLUMN "tokensUsed" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "RunCampaign" ADD COLUMN "costUsd" DECIMAL(65,30) NOT NULL DEFAULT 0;
