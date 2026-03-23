-- Add createdVia to Product: tracks where the product originated
-- Default 'shopify' for all existing products (most came from Shopify)
ALTER TABLE "Product" ADD COLUMN "createdVia" TEXT NOT NULL DEFAULT 'shopify';
