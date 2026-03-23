ALTER TABLE "SyncRun" ADD COLUMN "rolledBackAt" TIMESTAMP(3);
ALTER TABLE "SyncRun" ADD COLUMN "rolledBackByUserId" TEXT;

CREATE TABLE "SyncRunProductSnapshot" (
    "id" TEXT NOT NULL,
    "syncRunId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "snapshotJson" JSONB NOT NULL,
    CONSTRAINT "SyncRunProductSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SyncRunProductSnapshot_syncRunId_idx" ON "SyncRunProductSnapshot"("syncRunId");
CREATE UNIQUE INDEX "SyncRunProductSnapshot_syncRunId_productId_key" ON "SyncRunProductSnapshot"("syncRunId", "productId");

ALTER TABLE "SyncRunProductSnapshot" ADD CONSTRAINT "SyncRunProductSnapshot_syncRunId_fkey"
  FOREIGN KEY ("syncRunId") REFERENCES "SyncRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
