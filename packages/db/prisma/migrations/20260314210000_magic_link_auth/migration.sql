-- Make passwordHash optional (idempotent — DROP NOT NULL is safe to re-run)
ALTER TABLE "User" ALTER COLUMN "passwordHash" DROP NOT NULL;
-- Track email verification (idempotent)
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "emailVerifiedAt" TIMESTAMP(3);
-- Magic link tokens (idempotent)
CREATE TABLE IF NOT EXISTS "MagicLinkToken" (
  "id"         TEXT NOT NULL,
  "userId"     TEXT NOT NULL,
  "token"      TEXT NOT NULL,
  "expiresAt"  TIMESTAMP(3) NOT NULL,
  "usedAt"     TIMESTAMP(3),
  "redirectTo" TEXT,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MagicLinkToken_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "MagicLinkToken_token_key" ON "MagicLinkToken"("token");
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'MagicLinkToken_userId_fkey') THEN
    ALTER TABLE "MagicLinkToken" ADD CONSTRAINT "MagicLinkToken_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
