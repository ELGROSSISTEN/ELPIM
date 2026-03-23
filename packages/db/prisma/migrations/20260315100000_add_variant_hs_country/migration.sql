-- AlterTable (idempotent)
ALTER TABLE "Variant" ADD COLUMN IF NOT EXISTS "hsCode" TEXT;
ALTER TABLE "Variant" ADD COLUMN IF NOT EXISTS "countryOfOrigin" TEXT;
