-- AlterTable: add shopifyDeletedAt to Product for soft-delete on Shopify products/delete webhook
ALTER TABLE "Product" ADD COLUMN "shopifyDeletedAt" TIMESTAMP(3);

-- Index for efficiently querying non-deleted products
CREATE INDEX "Product_shopId_shopifyDeletedAt_idx" ON "Product"("shopId", "shopifyDeletedAt");
