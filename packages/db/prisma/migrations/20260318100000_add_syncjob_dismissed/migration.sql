-- Add dismissed flag to SyncJob for admin error acknowledgement
ALTER TABLE "SyncJob" ADD COLUMN "dismissed" BOOLEAN NOT NULL DEFAULT false;
