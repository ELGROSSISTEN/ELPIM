-- Replace locked boolean with lockLevel string ('none' | 'users' | 'all')
ALTER TABLE "FieldDefinition" ADD COLUMN "lockLevel" TEXT NOT NULL DEFAULT 'none';
UPDATE "FieldDefinition" SET "lockLevel" = 'users' WHERE "locked" = true;
ALTER TABLE "FieldDefinition" DROP COLUMN "locked";
