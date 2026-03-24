-- RunCampaign: per-field prompt template selection
ALTER TABLE "RunCampaign" ADD COLUMN "promptsJson" JSONB NOT NULL DEFAULT '{}';
