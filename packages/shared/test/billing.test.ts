import { describe, expect, it } from 'vitest';
import {
  activeDaysInMonthFromActivation,
  calculateMonthlyCharge,
  monthKeyFromDateUtc,
  shouldEmitIncludedReachedNotice,
  shouldEmitOverageStartedNotice,
} from '../src/billing.js';

describe('billing calculations', () => {
  it('calculates a full-month charge without overage', () => {
    const result = calculateMonthlyCharge({
      monthKey: '2026-03',
      consumedUnits: 42,
      basePriceMinor: 99900,
      includedUnitsPerMonth: 100,
      overageUnitMinor: 50,
      isFirstBillingMonth: false,
    });

    expect(result.baseAmountMinor).toBe(99900);
    expect(result.overageUnits).toBe(0);
    expect(result.subtotalMinor).toBe(99900);
    expect(result.vatAmountMinor).toBe(24975);
    expect(result.totalAmountMinor).toBe(124875);
  });

  it('prorates first-month base charge by active days', () => {
    const result = calculateMonthlyCharge({
      monthKey: '2026-03',
      consumedUnits: 0,
      basePriceMinor: 99900,
      includedUnitsPerMonth: 100,
      overageUnitMinor: 50,
      isFirstBillingMonth: true,
      activatedAt: new Date('2026-03-20T08:30:00.000Z'),
    });

    expect(activeDaysInMonthFromActivation('2026-03', new Date('2026-03-20T08:30:00.000Z'))).toBe(12);
    expect(result.daysInMonth).toBe(31);
    expect(result.activeDaysInMonth).toBe(12);
    expect(result.baseAmountMinor).toBe(38671);
    expect(result.vatAmountMinor).toBe(9668);
    expect(result.totalAmountMinor).toBe(48339);
  });

  it('adds overage units after 100 included usage units', () => {
    const result = calculateMonthlyCharge({
      monthKey: '2026-03',
      consumedUnits: 130,
      basePriceMinor: 99900,
      includedUnitsPerMonth: 100,
      overageUnitMinor: 50,
      isFirstBillingMonth: false,
    });

    expect(result.overageUnits).toBe(30);
    expect(result.overageAmountMinor).toBe(1500);
    expect(result.subtotalMinor).toBe(101400);
    expect(result.vatAmountMinor).toBe(25350);
    expect(result.totalAmountMinor).toBe(126750);
  });
});

describe('usage notifications', () => {
  it('emits included threshold notice when usage reaches 100', () => {
    const shouldEmit = shouldEmitIncludedReachedNotice({
      previousConsumedUnits: 99,
      nextConsumedUnits: 100,
      includedUnitsPerMonth: 100,
    });

    expect(shouldEmit).toBe(true);
  });

  it('emits overage notice when usage crosses from 100 to 101+', () => {
    const shouldEmit = shouldEmitOverageStartedNotice({
      previousConsumedUnits: 100,
      nextConsumedUnits: 101,
      includedUnitsPerMonth: 100,
    });

    expect(shouldEmit).toBe(true);
  });

  it('does not emit duplicate threshold notices when already above threshold', () => {
    const includedNotice = shouldEmitIncludedReachedNotice({
      previousConsumedUnits: 120,
      nextConsumedUnits: 121,
      includedUnitsPerMonth: 100,
    });

    const overageNotice = shouldEmitOverageStartedNotice({
      previousConsumedUnits: 150,
      nextConsumedUnits: 151,
      includedUnitsPerMonth: 100,
    });

    expect(includedNotice).toBe(false);
    expect(overageNotice).toBe(false);
  });

  it('builds month key in UTC', () => {
    expect(monthKeyFromDateUtc(new Date('2026-03-08T23:59:59.000Z'))).toBe('2026-03');
    expect(monthKeyFromDateUtc(new Date('2026-12-01T00:00:00.000Z'))).toBe('2026-12');
  });
});
