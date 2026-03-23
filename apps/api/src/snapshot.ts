import { prisma } from '@epim/db';

export const createSnapshotAndLog = async (params: {
  shopId: string;
  entityType: string;
  entityId: string;
  reason: string;
  beforeJson?: unknown;
  afterJson?: unknown;
  source: string;
  userId?: string;
  jobId?: string;
  fieldKey?: string;
}): Promise<void> => {
  await prisma.snapshot.create({
    data: {
      shopId: params.shopId,
      entityType: params.entityType,
      entityId: params.entityId,
      blobJson: params.beforeJson ?? params.afterJson ?? {},
      reason: params.reason,
    },
  });

  await prisma.changeLog.create({
    data: {
      shopId: params.shopId,
      entityType: params.entityType,
      entityId: params.entityId,
      source: params.source,
      userId: params.userId,
      jobId: params.jobId,
      fieldKey: params.fieldKey,
      beforeJson: (params.beforeJson as object) ?? undefined,
      afterJson: (params.afterJson as object) ?? undefined,
    },
  });
};
