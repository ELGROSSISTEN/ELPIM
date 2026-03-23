-- CreateTable
CREATE TABLE "ProductCollection" (
  "productId" TEXT NOT NULL,
  "collectionId" TEXT NOT NULL,
  "shopId" TEXT NOT NULL,

  CONSTRAINT "ProductCollection_pkey" PRIMARY KEY ("productId","collectionId")
);

-- CreateIndex
CREATE INDEX "ProductCollection_collectionId_idx" ON "ProductCollection"("collectionId");

-- CreateIndex
CREATE INDEX "ProductCollection_shopId_idx" ON "ProductCollection"("shopId");

-- AddForeignKey
ALTER TABLE "ProductCollection"
ADD CONSTRAINT "ProductCollection_productId_fkey"
FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductCollection"
ADD CONSTRAINT "ProductCollection_collectionId_fkey"
FOREIGN KEY ("collectionId") REFERENCES "Collection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
