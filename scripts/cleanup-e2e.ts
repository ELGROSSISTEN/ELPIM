import { prisma } from '../packages/db/src/index.js';

async function main(): Promise<void> {
  const db = prisma as any;

  const users = await db.user.findMany({
    where: { email: { contains: 'e2e.' } },
    select: { id: true, email: true },
  });
  console.log('e2e users found:', users.length);

  const orgs = await db.organization.findMany({
    where: { name: { contains: 'e2e.' } },
    select: { id: true, name: true },
  });
  console.log('e2e orgs found:', orgs.length);

  if (users.length === 0 && orgs.length === 0) {
    console.log('Nothing to clean up.');
    return;
  }

  const userIds = users.map((u: any) => u.id);
  const orgIds = orgs.map((o: any) => o.id);

  // Delete in FK-safe order
  const sm = await db.shopMembership.deleteMany({ where: { userId: { in: userIds } } });
  console.log('shopMemberships deleted:', sm.count);

  const om = await db.organizationMembership.deleteMany({ where: { userId: { in: userIds } } });
  console.log('orgMemberships deleted:', om.count);

  // Delete shops belonging to e2e orgs
  const e2eShops = await db.shop.findMany({
    where: { organizationId: { in: orgIds } },
    select: { id: true },
  });
  const shopIds = e2eShops.map((s: any) => s.id);
  if (shopIds.length > 0) {
    await db.shopSubscription.deleteMany({ where: { shopId: { in: shopIds } } });
    await db.shopMembership.deleteMany({ where: { shopId: { in: shopIds } } });
    await db.shop.deleteMany({ where: { id: { in: shopIds } } });
    console.log('e2e shops deleted:', shopIds.length);
  }

  const ud = await db.user.deleteMany({ where: { id: { in: userIds } } });
  console.log('users deleted:', ud.count);

  const od = await db.organization.deleteMany({ where: { id: { in: orgIds } } });
  console.log('orgs deleted:', od.count);

  console.log('Done ✓');
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
