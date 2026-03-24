-- Add source selection fields to RunCampaign
ALTER TABLE "RunCampaign" ADD COLUMN "sourceIdsJson" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "RunCampaign" ADD COLUMN "sourcesOnly" BOOLEAN NOT NULL DEFAULT false;
