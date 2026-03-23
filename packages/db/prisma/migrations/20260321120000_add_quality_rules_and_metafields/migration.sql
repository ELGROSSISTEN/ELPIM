-- CreateTable: QualityRule
CREATE TABLE "QualityRule" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "operator" TEXT NOT NULL,
    "value" TEXT,
    "severity" TEXT NOT NULL DEFAULT 'warning',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QualityRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "QualityRule_shopId_idx" ON "QualityRule"("shopId");

-- AddForeignKey
ALTER TABLE "QualityRule" ADD CONSTRAINT "QualityRule_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable: ProductMetafield
CREATE TABLE "ProductMetafield" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "productId" TEXT,
    "variantId" TEXT,
    "namespace" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'single_line_text_field',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductMetafield_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProductMetafield_productId_namespace_key_key" ON "ProductMetafield"("productId", "namespace", "key");

-- CreateIndex
CREATE UNIQUE INDEX "ProductMetafield_variantId_namespace_key_key" ON "ProductMetafield"("variantId", "namespace", "key");

-- CreateIndex
CREATE INDEX "ProductMetafield_shopId_productId_idx" ON "ProductMetafield"("shopId", "productId");

-- AddForeignKey
ALTER TABLE "ProductMetafield" ADD CONSTRAINT "ProductMetafield_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductMetafield" ADD CONSTRAINT "ProductMetafield_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductMetafield" ADD CONSTRAINT "ProductMetafield_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "Variant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
