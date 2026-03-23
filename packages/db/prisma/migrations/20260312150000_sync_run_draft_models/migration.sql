-- AlterTable: add shopifyUpdatedAt to Collection
ALTER TABLE "Collection" ADD COLUMN "shopifyUpdatedAt" TIMESTAMP(3);

-- CreateTable: SyncRun
CREATE TABLE "SyncRun" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "status" "SyncJobStatus" NOT NULL DEFAULT 'running',
    "productCount" INTEGER NOT NULL DEFAULT 0,
    "initiatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    CONSTRAINT "SyncRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable: SyncRunChange
CREATE TABLE "SyncRunChange" (
    "id" TEXT NOT NULL,
    "syncRunId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "fieldKey" TEXT NOT NULL,
    "beforeValue" TEXT,
    "afterValue" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SyncRunChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable: Draft
CREATE TABLE "Draft" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "patchJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "userId" TEXT NOT NULL,
    CONSTRAINT "Draft_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SyncRun_shopId_createdAt_idx" ON "SyncRun"("shopId", "createdAt");
CREATE INDEX "SyncRunChange_syncRunId_idx" ON "SyncRunChange"("syncRunId");
CREATE INDEX "SyncRunChange_entityId_fieldKey_idx" ON "SyncRunChange"("entityId", "fieldKey");
CREATE UNIQUE INDEX "Draft_entityType_entityId_userId_key" ON "Draft"("entityType", "entityId", "userId");
CREATE INDEX "Draft_shopId_entityType_idx" ON "Draft"("shopId", "entityType");

-- AddForeignKey
ALTER TABLE "SyncRun" ADD CONSTRAINT "SyncRun_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SyncRun" ADD CONSTRAINT "SyncRun_initiatedBy_fkey" FOREIGN KEY ("initiatedBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SyncRunChange" ADD CONSTRAINT "SyncRunChange_syncRunId_fkey" FOREIGN KEY ("syncRunId") REFERENCES "SyncRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Draft" ADD CONSTRAINT "Draft_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Draft" ADD CONSTRAINT "Draft_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
