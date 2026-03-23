-- AlterTable (idempotent)
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "publishedAt" TIMESTAMP(3);
