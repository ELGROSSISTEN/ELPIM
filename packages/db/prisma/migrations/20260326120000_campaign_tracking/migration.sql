-- Campaign tracking: prompt visibility, processing dates, and max-items limit

-- Product: stamp when a campaign last processed this product
ALTER TABLE "Product" ADD COLUMN "aiProcessedAt" TIMESTAMP(3);

-- RunCampaign: optional limit — stop (pause) after N products
ALTER TABLE "RunCampaign" ADD COLUMN "maxItems" INTEGER;

-- RunCampaign: exclude products processed on specific dates
ALTER TABLE "RunCampaign" ADD COLUMN "excludeProcessedDatesJson" JSONB NOT NULL DEFAULT '[]';

-- RunCampaignItem: store the exact prompt sent to the AI for each field
ALTER TABLE "RunCampaignItem" ADD COLUMN "promptsUsedJson" JSONB NOT NULL DEFAULT '{}';
