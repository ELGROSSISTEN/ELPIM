import { prisma } from '../src/index.js';
import { encryptSecret } from '@epim/crypto';
import { createHash } from 'node:crypto';

const hashPassword = (password: string): string =>
  createHash('sha256').update(password).digest('hex');

async function main(): Promise<void> {
  const masterKey = process.env.MASTER_ENCRYPTION_KEY ?? 'dev-master-key';
  const db = prisma as any;

  await db.platformSetting.upsert({
    where: { key: 'billing_trial_policy' },
    update: {
      valueJson: {
        enabled: true,
        trialDays: 14,
      },
    },
    create: {
      key: 'billing_trial_policy',
      valueJson: {
        enabled: true,
        trialDays: 14,
      },
    },
  });

  const now = new Date();
  const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
  const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0, 23, 59, 59, 999));

  const organization = await db.organization.upsert({
    where: { id: 'org_demo_elpim' },
    update: { name: 'Demo Organization', cvrNumber: '10000001', type: 'regular' },
    create: {
      id: 'org_demo_elpim',
      name: 'Demo Organization',
      cvrNumber: '10000001',
      type: 'regular',
    },
  });

  const shop = await db.shop.upsert({
    where: { shopUrl: 'https://demo-store.myshopify.com' },
    update: {
      organizationId: organization.id,
      status: 'disconnected',
    },
    create: {
      organizationId: organization.id,
      shopUrl: 'https://demo-store.myshopify.com',
      encryptedAdminToken: encryptSecret('shpat_demo_token', masterKey),
      status: 'disconnected',
    },
  });

  const user = await db.user.upsert({
    where: { email: 'owner@elpim.local' },
    update: {
      role: 'owner',
      platformRole: 'platform_admin',
      shopId: shop.id,
    },
    create: {
      email: 'owner@elpim.local',
      passwordHash: hashPassword('changeme123'),
      role: 'owner',
      platformRole: 'platform_admin',
      shopId: shop.id,
    },
  });

  await db.organizationMembership.upsert({
    where: {
      organizationId_userId: {
        organizationId: organization.id,
        userId: user.id,
      },
    },
    update: { role: 'owner' },
    create: {
      organizationId: organization.id,
      userId: user.id,
      role: 'owner',
    },
  });

  await db.shopMembership.upsert({
    where: {
      shopId_userId: {
        shopId: shop.id,
        userId: user.id,
      },
    },
    update: { role: 'member' },
    create: {
      shopId: shop.id,
      userId: user.id,
      role: 'member',
    },
  });

  await db.shopSubscription.upsert({
    where: { shopId: shop.id },
    update: {
      status: 'active',
      basePriceMinor: 99900,
      includedUnitsPerMonth: 100,
      overageUnitMinor: 50,
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
    },
    create: {
      shopId: shop.id,
      status: 'active',
      basePriceMinor: 99900,
      includedUnitsPerMonth: 100,
      overageUnitMinor: 50,
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
    },
  });

  let product = await db.product.findFirst({
    where: { shopId: shop.id },
    include: { variants: true },
  });

  if (!product) {
    product = await db.product.create({
      data: {
        shopId: shop.id,
        title: 'Demo Product',
        handle: 'demo-product',
        vendor: 'EL-PIM',
        productType: 'Demo',
        status: 'ACTIVE',
        tagsJson: ['demo'],
        seoJson: { title: 'Demo Product', description: 'Demo description' },
        descriptionHtml: '<p>Demo mode product</p>',
        variants: {
          create: {
            sku: 'DEMO-SKU',
            barcode: '123456789',
            price: '9.99',
            compareAtPrice: '12.99',
            optionValuesJson: ['Default'],
          },
        },
      },
      include: { variants: true },
    });
  }

  await db.snapshot.create({
    data: {
      shopId: shop.id,
      entityType: 'product',
      entityId: product.id,
      reason: 'seed',
      blobJson: product,
    },
  });

  await db.changeLog.create({
    data: {
      shopId: shop.id,
      entityType: 'product',
      entityId: product.id,
      source: 'import',
      userId: user.id,
      afterJson: product,
    },
  });

  // ── Demo bureau + klient-relation ─────────────────────────────────────────
  const agencyOrg = await db.organization.upsert({
    where: { id: 'org_demo_agency' },
    update: { name: 'Demo Bureau ApS', type: 'agency', cvrNumber: '10000099' },
    create: {
      id: 'org_demo_agency',
      name: 'Demo Bureau ApS',
      type: 'agency',
      cvrNumber: '10000099',
    },
  });

  const agencyUser = await db.user.upsert({
    where: { email: 'agency@elpim.local' },
    update: { role: 'owner' },
    create: {
      email: 'agency@elpim.local',
      passwordHash: hashPassword('changeme123'),
      role: 'owner',
      platformRole: 'none',
    },
  });

  await db.organizationMembership.upsert({
    where: { organizationId_userId: { organizationId: agencyOrg.id, userId: agencyUser.id } },
    update: { role: 'owner' },
    create: { organizationId: agencyOrg.id, userId: agencyUser.id, role: 'owner' },
  });

  await db.agencyClientRelation.upsert({
    where: { agencyOrgId_clientOrgId: { agencyOrgId: agencyOrg.id, clientOrgId: organization.id } },
    update: { status: 'active', commissionRateBps: 2000 },
    create: {
      agencyOrgId: agencyOrg.id,
      clientOrgId: organization.id,
      referralCode: 'DEMO0001',
      commissionRateBps: 2000,
      status: 'active',
    },
  });
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
