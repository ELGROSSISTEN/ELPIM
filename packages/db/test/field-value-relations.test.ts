import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/index.js';

describe('FieldValue polymorphic relations', () => {
  const suffix = `fv_rel_${Date.now()}`;
  let shopId = '';
  let productId = '';
  let variantId = '';
  let productFieldDefinitionId = '';
  let variantFieldDefinitionId = '';

  beforeAll(async () => {
    const shop = await prisma.shop.create({
      data: {
        shopUrl: `https://${suffix}.myshopify.com`,
        encryptedAdminToken: 'test-token',
        status: 'connected',
      },
    });
    shopId = shop.id;

    const product = await prisma.product.create({
      data: {
        shopId,
        title: 'Relation Test Product',
        handle: `relation-test-${suffix}`,
        tagsJson: [],
        seoJson: {},
      },
    });
    productId = product.id;

    const variant = await prisma.variant.create({
      data: {
        productId,
        optionValuesJson: ['Default'],
      },
    });
    variantId = variant.id;

    const productField = await prisma.fieldDefinition.create({
      data: {
        shopId,
        key: `product_field_${suffix}`,
        label: 'Product Field',
        scope: 'product',
        type: 'text',
        constraintsJson: {},
        uiConfigJson: {},
      },
    });
    productFieldDefinitionId = productField.id;

    const variantField = await prisma.fieldDefinition.create({
      data: {
        shopId,
        key: `variant_field_${suffix}`,
        label: 'Variant Field',
        scope: 'variant',
        type: 'text',
        constraintsJson: {},
        uiConfigJson: {},
      },
    });
    variantFieldDefinitionId = variantField.id;
  });

  afterAll(async () => {
    await prisma.fieldValue.deleteMany({
      where: {
        OR: [{ ownerId: productId }, { ownerId: variantId }],
      },
    });
    await prisma.fieldDefinition.deleteMany({ where: { id: { in: [productFieldDefinitionId, variantFieldDefinitionId] } } });
    await prisma.variant.deleteMany({ where: { id: variantId } });
    await prisma.product.deleteMany({ where: { id: productId } });
    await prisma.shop.deleteMany({ where: { id: shopId } });
    await prisma.$disconnect();
  });

  it('upserts product field value with product FK only', async () => {
    const record = await prisma.fieldValue.upsert({
      where: {
        ownerType_ownerId_fieldDefinitionId: {
          ownerType: 'product',
          ownerId: productId,
          fieldDefinitionId: productFieldDefinitionId,
        },
      },
      update: {
        valueJson: 'updated product value',
        source: 'ai',
      },
      create: {
        ownerType: 'product',
        ownerId: productId,
        productId,
        variantId: null,
        fieldDefinitionId: productFieldDefinitionId,
        valueJson: 'initial product value',
        source: 'ai',
      },
    });

    expect(record.productId).toBe(productId);
    expect(record.variantId).toBeNull();
  });

  it('upserts variant field value with variant FK only', async () => {
    const record = await prisma.fieldValue.upsert({
      where: {
        ownerType_ownerId_fieldDefinitionId: {
          ownerType: 'variant',
          ownerId: variantId,
          fieldDefinitionId: variantFieldDefinitionId,
        },
      },
      update: {
        valueJson: 'updated variant value',
        source: 'ai',
      },
      create: {
        ownerType: 'variant',
        ownerId: variantId,
        productId: null,
        variantId,
        fieldDefinitionId: variantFieldDefinitionId,
        valueJson: 'initial variant value',
        source: 'ai',
      },
    });

    expect(record.variantId).toBe(variantId);
    expect(record.productId).toBeNull();
  });
});
