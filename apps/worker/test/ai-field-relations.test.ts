import { describe, expect, it } from 'vitest';
import { getFieldValueRelationIds } from '../src/ai-field-relations.js';

describe('getFieldValueRelationIds', () => {
  it('maps product owner to productId only', () => {
    const ids = getFieldValueRelationIds({ ownerType: 'product', ownerId: 'prod_123' });
    expect(ids).toEqual({ productId: 'prod_123', variantId: null });
  });

  it('maps variant owner to variantId only', () => {
    const ids = getFieldValueRelationIds({ ownerType: 'variant', ownerId: 'var_456' });
    expect(ids).toEqual({ productId: null, variantId: 'var_456' });
  });
});
