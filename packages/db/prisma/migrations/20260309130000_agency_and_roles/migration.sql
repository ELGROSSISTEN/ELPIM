-- CreateEnum
CREATE TYPE "ShopRole" AS ENUM ('member');

-- CreateEnum
CREATE TYPE "OrganizationType" AS ENUM ('regular', 'agency');

-- CreateEnum
CREATE TYPE "AgencyRelationStatus" AS ENUM ('active', 'paused', 'terminated');

-- CreateEnum
CREATE TYPE "CommissionStatus" AS ENUM ('pending', 'requested', 'paid', 'rejected');

-- CreateEnum
CREATE TYPE "PayoutRequestStatus" AS ENUM ('pending', 'approved', 'rejected', 'paid');

-- AlterTable: Organization — add cvrNumber, address, type
ALTER TABLE "Organization"
  ADD COLUMN IF NOT EXISTS "cvrNumber" TEXT,
  ADD COLUMN IF NOT EXISTS "address" TEXT,
  ADD COLUMN IF NOT EXISTS "type" "OrganizationType" NOT NULL DEFAULT 'regular';

-- AlterTable: ShopMembership — replace role column (OrganizationRole → ShopRole)
ALTER TABLE "ShopMembership"
  DROP COLUMN IF EXISTS "role";

ALTER TABLE "ShopMembership"
  ADD COLUMN "role" "ShopRole" NOT NULL DEFAULT 'member';

-- CreateTable: AgencyClientRelation
CREATE TABLE "AgencyClientRelation" (
    "id" TEXT NOT NULL,
    "agencyOrgId" TEXT NOT NULL,
    "clientOrgId" TEXT NOT NULL,
    "referralCode" TEXT NOT NULL,
    "commissionRateBps" INTEGER NOT NULL DEFAULT 2000,
    "status" "AgencyRelationStatus" NOT NULL DEFAULT 'active',
    "startsAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endsAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgencyClientRelation_pkey" PRIMARY KEY ("id")
);

-- CreateTable: ReferralCommission
CREATE TABLE "ReferralCommission" (
    "id" TEXT NOT NULL,
    "agencyRelationId" TEXT NOT NULL,
    "agencyOrgId" TEXT NOT NULL,
    "clientOrgId" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "billingMonth" TEXT NOT NULL,
    "grossAmountMinor" INTEGER NOT NULL,
    "commissionMinor" INTEGER NOT NULL,
    "commissionRateBps" INTEGER NOT NULL,
    "status" "CommissionStatus" NOT NULL DEFAULT 'pending',
    "payoutRequestId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReferralCommission_pkey" PRIMARY KEY ("id")
);

-- CreateTable: ReferralPayoutRequest
CREATE TABLE "ReferralPayoutRequest" (
    "id" TEXT NOT NULL,
    "agencyOrgId" TEXT NOT NULL,
    "requestedAmountMinor" INTEGER NOT NULL,
    "periodFrom" TIMESTAMP(3) NOT NULL,
    "periodTo" TIMESTAMP(3) NOT NULL,
    "status" "PayoutRequestStatus" NOT NULL DEFAULT 'pending',
    "adminNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReferralPayoutRequest_pkey" PRIMARY KEY ("id")
);

-- CreateUniqueIndex on Organization.cvrNumber
CREATE UNIQUE INDEX "Organization_cvrNumber_key" ON "Organization"("cvrNumber") WHERE "cvrNumber" IS NOT NULL;

-- CreateUniqueIndex on AgencyClientRelation.referralCode
CREATE UNIQUE INDEX "AgencyClientRelation_referralCode_key" ON "AgencyClientRelation"("referralCode");

-- CreateUniqueIndex on AgencyClientRelation(agencyOrgId, clientOrgId)
CREATE UNIQUE INDEX "AgencyClientRelation_agencyOrgId_clientOrgId_key" ON "AgencyClientRelation"("agencyOrgId", "clientOrgId");

-- CreateIndex on AgencyClientRelation
CREATE INDEX "AgencyClientRelation_agencyOrgId_idx" ON "AgencyClientRelation"("agencyOrgId");
CREATE INDEX "AgencyClientRelation_clientOrgId_idx" ON "AgencyClientRelation"("clientOrgId");

-- CreateUniqueIndex on ReferralCommission(agencyRelationId, shopId, billingMonth)
CREATE UNIQUE INDEX "ReferralCommission_agencyRelationId_shopId_billingMonth_key" ON "ReferralCommission"("agencyRelationId", "shopId", "billingMonth");

-- CreateIndex on ReferralCommission
CREATE INDEX "ReferralCommission_agencyOrgId_billingMonth_idx" ON "ReferralCommission"("agencyOrgId", "billingMonth");
CREATE INDEX "ReferralCommission_shopId_billingMonth_idx" ON "ReferralCommission"("shopId", "billingMonth");

-- CreateIndex on ReferralPayoutRequest
CREATE INDEX "ReferralPayoutRequest_agencyOrgId_status_idx" ON "ReferralPayoutRequest"("agencyOrgId", "status");

-- AddForeignKey: AgencyClientRelation.agencyOrgId → Organization.id
ALTER TABLE "AgencyClientRelation" ADD CONSTRAINT "AgencyClientRelation_agencyOrgId_fkey" FOREIGN KEY ("agencyOrgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey: AgencyClientRelation.clientOrgId → Organization.id
ALTER TABLE "AgencyClientRelation" ADD CONSTRAINT "AgencyClientRelation_clientOrgId_fkey" FOREIGN KEY ("clientOrgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey: ReferralCommission.agencyRelationId → AgencyClientRelation.id
ALTER TABLE "ReferralCommission" ADD CONSTRAINT "ReferralCommission_agencyRelationId_fkey" FOREIGN KEY ("agencyRelationId") REFERENCES "AgencyClientRelation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey: ReferralCommission.agencyOrgId → Organization.id
ALTER TABLE "ReferralCommission" ADD CONSTRAINT "ReferralCommission_agencyOrgId_fkey" FOREIGN KEY ("agencyOrgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey: ReferralCommission.shopId → Shop.id
ALTER TABLE "ReferralCommission" ADD CONSTRAINT "ReferralCommission_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey: ReferralCommission.payoutRequestId → ReferralPayoutRequest.id
ALTER TABLE "ReferralCommission" ADD CONSTRAINT "ReferralCommission_payoutRequestId_fkey" FOREIGN KEY ("payoutRequestId") REFERENCES "ReferralPayoutRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey: ReferralPayoutRequest.agencyOrgId → Organization.id
ALTER TABLE "ReferralPayoutRequest" ADD CONSTRAINT "ReferralPayoutRequest_agencyOrgId_fkey" FOREIGN KEY ("agencyOrgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
