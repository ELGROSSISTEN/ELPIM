-- CreateTable
CREATE TABLE "SourceDataRow" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "productId" TEXT,
    "matchKey" TEXT NOT NULL,
    "matchType" TEXT NOT NULL,
    "dataJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SourceDataRow_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SourceDataRow_shopId_productId_idx" ON "SourceDataRow"("shopId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "SourceDataRow_sourceId_matchKey_key" ON "SourceDataRow"("sourceId", "matchKey");

-- AddForeignKey
ALTER TABLE "SourceDataRow" ADD CONSTRAINT "SourceDataRow_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "Source"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SourceDataRow" ADD CONSTRAINT "SourceDataRow_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;
