import type { ConflictResolution, FieldChangeCandidate, MappingConfig } from './types.js';

export const withinWindow = (
  left?: Date,
  right?: Date,
  windowMinutes = 10,
): boolean => {
  if (!left || !right) {
    return false;
  }
  return Math.abs(left.getTime() - right.getTime()) <= windowMinutes * 60 * 1000;
};

export const resolveConflict = (
  mapping: MappingConfig,
  changes: FieldChangeCandidate,
): ConflictResolution => {
  if (mapping.direction === 'NONE') {
    return { blocked: true, winner: null, warning: 'Mapping direction is NONE' };
  }

  if (mapping.direction === 'PIM_TO_SHOPIFY') {
    return { blocked: false, winner: 'pim' };
  }

  if (mapping.direction === 'SHOPIFY_TO_PIM') {
    return { blocked: false, winner: 'shopify' };
  }

  const conflict = withinWindow(
    changes.pimChangedAt,
    changes.shopifyChangedAt,
    mapping.conflictWindowMinutes,
  );

  if (!conflict) {
    if (changes.pimChangedAt && changes.shopifyChangedAt) {
      return {
        blocked: false,
        winner:
          changes.pimChangedAt.getTime() >= changes.shopifyChangedAt.getTime() ? 'pim' : 'shopify',
      };
    }
    return { blocked: false, winner: changes.pimChangedAt ? 'pim' : 'shopify' };
  }

  switch (mapping.conflictPolicy) {
    case 'prefer_pim':
      return { blocked: false, winner: 'pim' };
    case 'prefer_shopify':
      return { blocked: false, winner: 'shopify' };
    case 'newest_wins':
      return {
        blocked: false,
        winner:
          (changes.pimChangedAt?.getTime() ?? 0) >= (changes.shopifyChangedAt?.getTime() ?? 0)
            ? 'pim'
            : 'shopify',
      };
    case 'manual':
    default:
      return {
        blocked: true,
        winner: null,
        warning: 'Two-way conflict within configured conflict window requires manual resolution',
      };
  }
};
