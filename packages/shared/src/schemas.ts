import { z } from 'zod';

export const registerSchema = z.object({
  email: z.string().email(),
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
  phone: z.string().max(30).optional(),
  companyName: z.string().max(200).optional(),
  referralSource: z.string().max(100).optional(),
});

export const loginSchema = z.object({
  email: z.string().email(),
});

export const connectShopSchema = z.object({
  storeUrl: z.string().url(),
  token: z.string().min(10),
});

export const openAiKeySchema = z.object({
  apiKey: z.string().min(20),
});

export const fieldDefinitionSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  scope: z.enum(['product', 'variant', 'collection']),
  type: z.enum(['text', 'number', 'boolean', 'json', 'date', 'html']),
  constraintsJson: z.record(z.any()).default({}),
  uiConfigJson: z.record(z.any()).default({}),
});

export const mappingSchema = z.object({
  fieldDefinitionId: z.string().cuid(),
  targetType: z.string().min(1),
  targetJson: z.record(z.any()).default({}),
  direction: z.enum(['PIM_TO_SHOPIFY', 'SHOPIFY_TO_PIM', 'TWO_WAY', 'NONE']),
  conflictPolicy: z.enum(['prefer_pim', 'prefer_shopify', 'newest_wins', 'manual']),
  transformJson: z.record(z.any()).default({}),
});

export const productPatchSchema = z.object({
  syncNow: z.boolean().optional(),
  title: z.string().optional(),
  handle: z.string().optional(),
  vendor: z.string().optional(),
  productType: z.string().optional(),
  status: z.string().optional(),
  tagsJson: z.array(z.string()).optional(),
  seoJson: z.record(z.any()).optional(),
  descriptionHtml: z.string().optional(),
  imagesJson: z.array(z.object({ url: z.string(), altText: z.string().optional() })).optional(),
  fieldValues: z.array(
    z.object({
      fieldDefinitionId: z.string().cuid(),
      valueJson: z.any(),
    }),
  ).optional(),
});

export const collectionPatchSchema = z.object({
  syncNow: z.boolean().optional(),
  title: z.string().optional(),
  handle: z.string().optional(),
  descriptionHtml: z.string().optional(),
  fieldValues: z.record(z.string()).optional(), // fieldDefinitionId → value
});

export const variantPatchSchema = z.object({
  syncNow: z.boolean().optional(),
  sku: z.string().optional(),
  barcode: z.string().optional(),
  price: z.string().optional(),
  compareAtPrice: z.string().optional(),
  optionValuesJson: z.array(z.string()).optional(),
  weight: z.number().optional(),
  weightUnit: z.enum(['KILOGRAMS', 'GRAMS', 'POUNDS', 'OUNCES']).optional(),
  requiresShipping: z.boolean().optional(),
  taxable: z.boolean().optional(),
  inventoryPolicy: z.enum(['DENY', 'CONTINUE']).optional(),
  hsCode: z.string().max(20).optional(),
  countryOfOrigin: z.string().max(5).optional(),
  fieldValues: z.array(
    z.object({
      fieldDefinitionId: z.string().cuid(),
      valueJson: z.any(),
    }),
  ).optional(),
});

export const bulkPatchSchema = z.object({
  syncNow: z.boolean().default(false),
  products: z
    .array(
      z.object({
        id: z.string().cuid(),
        patch: productPatchSchema,
      }),
    )
    .default([]),
  variants: z
    .array(
      z.object({
        id: z.string().cuid(),
        patch: variantPatchSchema,
      }),
    )
    .default([]),
});

export const aiPreviewSchema = z.object({
  rows: z.array(z.object({ ownerType: z.enum(['product', 'variant', 'collection']), ownerId: z.string().cuid() })),
  fieldDefinitionId: z.string().cuid(),
  promptTemplate: z.string().min(1),
  webSearch: z.boolean().optional().default(false),
  competitorUrls: z.array(z.string().url()).optional().default([]),
  sourceIds: z.array(z.string()).optional().default([]),
  sourcesOnly: z.boolean().optional().default(false),
});

export const aiKeywordSuggestionSchema = z.object({
  productId: z.string().cuid(),
  competitorUrls: z.array(z.string().url()).optional().default([]),
  maxSuggestions: z.number().int().min(3).max(20).optional().default(10),
  locale: z.string().optional().default('da-DK'),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
