-- RunCampaign: auto-sync flag
ALTER TABLE "RunCampaign" ADD COLUMN "autoSync" BOOLEAN NOT NULL DEFAULT false;
