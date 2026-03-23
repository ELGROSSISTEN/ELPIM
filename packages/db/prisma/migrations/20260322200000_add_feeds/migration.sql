CREATE TABLE "Feed" (
  "id" TEXT NOT NULL,
  "shopId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "format" TEXT NOT NULL DEFAULT 'xml',
  "feedType" TEXT NOT NULL DEFAULT 'custom',
  "urlKey" TEXT NOT NULL,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "mappingsJson" JSONB NOT NULL DEFAULT '[]',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "Feed_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Feed_urlKey_key" ON "Feed"("urlKey");
CREATE INDEX "Feed_shopId_idx" ON "Feed"("shopId");

ALTER TABLE "Feed" ADD CONSTRAINT "Feed_shopId_fkey"
  FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
