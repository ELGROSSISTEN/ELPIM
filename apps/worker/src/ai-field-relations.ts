export type FieldValueOwner = {
  ownerType: 'product' | 'variant' | 'collection';
  ownerId: string;
};

export const getFieldValueRelationIds = (
  owner: FieldValueOwner,
): { productId: string | null; variantId: string | null } => {
  if (owner.ownerType === 'product') {
    return { productId: owner.ownerId, variantId: null };
  }
  if (owner.ownerType === 'variant') {
    return { productId: null, variantId: owner.ownerId };
  }
  // collection
  return { productId: null, variantId: null };
};
