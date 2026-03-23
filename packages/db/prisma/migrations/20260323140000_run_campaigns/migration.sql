-- RunCampaign, RunCampaignItem, RunCampaignLog

CREATE TABLE "RunCampaign" (
  "id"               TEXT NOT NULL,
  "shopId"           TEXT NOT NULL,
  "name"             TEXT NOT NULL,
  "status"           TEXT NOT NULL DEFAULT 'draft',
  "fieldsJson"       JSONB NOT NULL DEFAULT '[]',
  "batchSize"        INTEGER NOT NULL DEFAULT 50,
  "concurrency"      INTEGER NOT NULL DEFAULT 5,
  "collectionsFirst" BOOLEAN NOT NULL DEFAULT true,
  "excludeSkusJson"  JSONB NOT NULL DEFAULT '[]',
  "overwriteJson"    JSONB NOT NULL DEFAULT '[]',
  "totalItems"       INTEGER NOT NULL DEFAULT 0,
  "doneItems"        INTEGER NOT NULL DEFAULT 0,
  "failedItems"      INTEGER NOT NULL DEFAULT 0,
  "skippedItems"     INTEGER NOT NULL DEFAULT 0,
  "startedAt"        TIMESTAMP(3),
  "completedAt"      TIMESTAMP(3),
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RunCampaign_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RunCampaignItem" (
  "id"             TEXT NOT NULL,
  "campaignId"     TEXT NOT NULL,
  "productId"      TEXT NOT NULL,
  "title"          TEXT,
  "sku"            TEXT,
  "status"         TEXT NOT NULL DEFAULT 'pending',
  "fieldsDoneJson" JSONB NOT NULL DEFAULT '{}',
  "processedAt"    TIMESTAMP(3),
  "errorMsg"       TEXT,
  "sortOrder"      INTEGER NOT NULL DEFAULT 0,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RunCampaignItem_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RunCampaignLog" (
  "id"         TEXT NOT NULL,
  "campaignId" TEXT NOT NULL,
  "itemId"     TEXT,
  "level"      TEXT NOT NULL DEFAULT 'info',
  "message"    TEXT NOT NULL,
  "metaJson"   JSONB,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RunCampaignLog_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "RunCampaign"     ADD CONSTRAINT "RunCampaign_shopId_fkey"         FOREIGN KEY ("shopId")     REFERENCES "Shop"("id")            ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RunCampaignItem" ADD CONSTRAINT "RunCampaignItem_campaignId_fkey"  FOREIGN KEY ("campaignId") REFERENCES "RunCampaign"("id")     ON DELETE CASCADE  ON UPDATE CASCADE;
ALTER TABLE "RunCampaignItem" ADD CONSTRAINT "RunCampaignItem_productId_fkey"   FOREIGN KEY ("productId")  REFERENCES "Product"("id")         ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RunCampaignLog"  ADD CONSTRAINT "RunCampaignLog_campaignId_fkey"   FOREIGN KEY ("campaignId") REFERENCES "RunCampaign"("id")      ON DELETE CASCADE  ON UPDATE CASCADE;

CREATE UNIQUE INDEX "RunCampaignItem_campaignId_productId_key" ON "RunCampaignItem"("campaignId", "productId");
CREATE INDEX "RunCampaign_shopId_status_idx"                   ON "RunCampaign"("shopId", "status");
CREATE INDEX "RunCampaignItem_campaignId_status_sortOrder_idx" ON "RunCampaignItem"("campaignId", "status", "sortOrder");
CREATE INDEX "RunCampaignLog_campaignId_createdAt_idx"         ON "RunCampaignLog"("campaignId", "createdAt" DESC);
