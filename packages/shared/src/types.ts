export const SyncDirection = {
  PIM_TO_SHOPIFY: 'PIM_TO_SHOPIFY',
  SHOPIFY_TO_PIM: 'SHOPIFY_TO_PIM',
  TWO_WAY: 'TWO_WAY',
  NONE: 'NONE',
} as const;

export type SyncDirection = (typeof SyncDirection)[keyof typeof SyncDirection];

export const ConflictPolicy = {
  prefer_pim: 'prefer_pim',
  prefer_shopify: 'prefer_shopify',
  newest_wins: 'newest_wins',
  manual: 'manual',
} as const;

export type ConflictPolicy = (typeof ConflictPolicy)[keyof typeof ConflictPolicy];

export type SourceType = 'user' | 'shopify_webhook' | 'sync' | 'import' | 'ai';

export interface MappingConfig {
  direction: SyncDirection;
  conflictPolicy: ConflictPolicy;
  conflictWindowMinutes: number;
}

export interface FieldChangeCandidate {
  pimChangedAt?: Date;
  shopifyChangedAt?: Date;
}

export interface ConflictResolution {
  blocked: boolean;
  winner: 'pim' | 'shopify' | null;
  warning?: string;
}

export interface ShopifyConnectionInput {
  shopUrl: string;
  token: string;
}
