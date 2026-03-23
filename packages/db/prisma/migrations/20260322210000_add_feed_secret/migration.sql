CREATE EXTENSION IF NOT EXISTS pgcrypto;
ALTER TABLE "Feed" ADD COLUMN "urlSecret" TEXT NOT NULL DEFAULT '';
UPDATE "Feed" SET "urlSecret" = encode(gen_random_bytes(16), 'hex') WHERE "urlSecret" = '';
ALTER TABLE "Feed" ALTER COLUMN "urlSecret" DROP DEFAULT;
