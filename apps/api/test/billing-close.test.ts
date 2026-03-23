import { describe, expect, it } from 'vitest';
import { buildBillingCloseBreakdown } from '../src/billing-close.js';

describe('billing close breakdown', () => {
  it('calculates close-month overage and totals for non-first month', () => {
    const result = buildBillingCloseBreakdown({
      monthKey: '2026-03',
      consumedUnits: 130,
      basePriceMinor: 99900,
      includedUnitsPerMonth: 100,
      overageUnitMinor: 50,
      subscriptionCreatedAt: new Date('2025-12-15T00:00:00.000Z'),
    });

    expect(result.overageUnits).toBe(30);
    expect(result.overageAmountMinor).toBe(1500);
    expect(result.subtotalMinor).toBe(101400);
    expect(result.totalAmountMinor).toBe(126750);
  });

  it('prorates first billing month base amount', () => {
    const result = buildBillingCloseBreakdown({
      monthKey: '2026-03',
      consumedUnits: 20,
      basePriceMinor: 99900,
      includedUnitsPerMonth: 100,
      overageUnitMinor: 50,
      subscriptionCreatedAt: new Date('2026-03-20T00:00:00.000Z'),
    });

    expect(result.baseAmountMinor).toBe(38671);
    expect(result.totalAmountMinor).toBe(48339);
  });
});
