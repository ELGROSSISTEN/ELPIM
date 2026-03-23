import { describe, expect, it } from 'vitest';
import { resolveConflict } from '../src/conflict.js';

describe('resolveConflict', () => {
  it('blocks on manual policy inside conflict window', () => {
    const now = new Date();
    const result = resolveConflict(
      { direction: 'TWO_WAY', conflictPolicy: 'manual', conflictWindowMinutes: 10 },
      { pimChangedAt: now, shopifyChangedAt: new Date(now.getTime() - 5 * 60 * 1000) },
    );
    expect(result.blocked).toBe(true);
    expect(result.winner).toBeNull();
  });

  it('prefers newest with newest_wins policy', () => {
    const now = new Date();
    const result = resolveConflict(
      { direction: 'TWO_WAY', conflictPolicy: 'newest_wins', conflictWindowMinutes: 10 },
      { pimChangedAt: new Date(now.getTime() - 1_000), shopifyChangedAt: now },
    );
    expect(result.blocked).toBe(false);
    expect(result.winner).toBe('shopify');
  });
});
