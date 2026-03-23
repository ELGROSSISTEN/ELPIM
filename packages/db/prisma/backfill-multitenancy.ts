import { prisma } from '../src/index.js';

const cleanShopNameFromUrl = (shopUrl: string): string => {
  try {
    const hostname = new URL(shopUrl).hostname;
    const base = hostname.split('.')[0] ?? hostname;
    return base.replace(/[-_]+/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase()).trim() || 'Organization';
  } catch {
    return 'Organization';
  }
};

const monthWindowForNowUtc = (): { periodStart: Date; periodEnd: Date } => {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();

  const periodStart = new Date(Date.UTC(year, month, 1, 0, 0, 0, 0));
  const periodEnd = new Date(Date.UTC(year, month + 1, 0, 23, 59, 59, 999));

  return { periodStart, periodEnd };
};

async function main(): Promise<void> {
  const db = prisma as any;

  await db.platformSetting.upsert({
    where: { key: 'billing_trial_policy' },
    update: {},
    create: {
      key: 'billing_trial_policy',
      valueJson: {
        enabled: true,
        trialDays: 14,
      },
    },
  });

  const [shops, users] = await Promise.all([
    db.shop.findMany({ include: { users: true, organization: true, subscription: true } }),
    db.user.findMany(),
  ]);

  let orgsCreated = 0;
  let orgMembershipsCreated = 0;
  let shopMembershipsCreated = 0;
  let subsCreated = 0;

  const { periodStart, periodEnd } = monthWindowForNowUtc();

  for (const shop of shops) {
    let organizationId = shop.organizationId;

    if (!organizationId) {
      const org = await db.organization.create({
        data: {
          name: `${cleanShopNameFromUrl(shop.shopUrl)} Organization`,
          stripeCustomerId: `bootstrap_cus_org_${shop.id}`,
        },
      });
      organizationId = org.id;
      orgsCreated += 1;

      await db.shop.update({
        where: { id: shop.id },
        data: { organizationId },
      });
    } else {
      await db.organization.updateMany({
        where: { id: organizationId, stripeCustomerId: null },
        data: { stripeCustomerId: `bootstrap_cus_org_${shop.id}` },
      });
    }

    for (const user of shop.users) {
      const role = 'member' as const;

      const existingOrgMembership = await db.organizationMembership.findUnique({
        where: {
          organizationId_userId: {
            organizationId,
            userId: user.id,
          },
        },
      });

      await db.organizationMembership.upsert({
        where: {
          organizationId_userId: {
            organizationId,
            userId: user.id,
          },
        },
        update: {
          role,
        },
        create: {
          organizationId,
          userId: user.id,
          role,
        },
      });

      if (!existingOrgMembership) {
        orgMembershipsCreated += 1;
      }

      const existingShopMembership = await db.shopMembership.findUnique({
        where: {
          shopId_userId: {
            shopId: shop.id,
            userId: user.id,
          },
        },
      });

      await db.shopMembership.upsert({
        where: {
          shopId_userId: {
            shopId: shop.id,
            userId: user.id,
          },
        },
        update: {
          role,
        },
        create: {
          shopId: shop.id,
          userId: user.id,
          role,
        },
      });

      if (!existingShopMembership) {
        shopMembershipsCreated += 1;
      }
    }

    if (!shop.subscription) {
      await db.shopSubscription.create({
        data: {
          shopId: shop.id,
          stripeCustomerId: `bootstrap_cus_${shop.id}`,
          stripeSubscriptionId: `bootstrap_sub_${shop.id}`,
          status: 'active',
          basePriceMinor: 99900,
          includedUnitsPerMonth: 100,
          overageUnitMinor: 50,
          currentPeriodStart: periodStart,
          currentPeriodEnd: periodEnd,
        },
      });
      subsCreated += 1;
    }
  }

  // Users without any memberships become platform support by default only if explicitly desired later.
  // Keep existing behavior safe: do not auto-promote roles in backfill.
  const usersWithoutAnyMembership = users.filter((user: any) =>
    !shops.some((shop: any) => shop.users.some((shopUser: any) => shopUser.id === user.id)),
  );

  console.log('Multi-tenancy backfill completed');
  console.log(
    JSON.stringify(
      {
        shopsScanned: shops.length,
        usersScanned: users.length,
        organizationsCreated: orgsCreated,
        organizationMembershipsCreated: orgMembershipsCreated,
        shopMembershipsCreated,
        subscriptionsCreated: subsCreated,
        usersWithoutMembership: usersWithoutAnyMembership.length,
      },
      null,
      2,
    ),
  );
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
