export type MonthlyChargeInput = {
  monthKey: string;
  consumedUnits: number;
  basePriceMinor: number;
  includedUnitsPerMonth: number;
  overageUnitMinor: number;
  vatRateBps?: number;
  isFirstBillingMonth: boolean;
  activatedAt?: Date;
};

export type MonthlyChargeBreakdown = {
  monthKey: string;
  daysInMonth: number;
  activeDaysInMonth: number;
  prorationRatio: number;
  baseAmountMinor: number;
  includedUnits: number;
  consumedUnits: number;
  overageUnits: number;
  overageAmountMinor: number;
  subtotalMinor: number;
  vatRateBps: number;
  vatAmountMinor: number;
  totalAmountMinor: number;
};

const MONTH_KEY_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;

const clampNonNegativeInt = (value: number): number => (Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0);

export const parseMonthKey = (monthKey: string): { year: number; month: number } => {
  const match = monthKey.match(MONTH_KEY_PATTERN);
  if (!match) {
    throw new Error(`Invalid monthKey format: ${monthKey}. Expected YYYY-MM`);
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  return { year, month };
};

export const monthKeyFromDateUtc = (date: Date): string => {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  return `${year}-${String(month).padStart(2, '0')}`;
};

export const daysInMonth = (year: number, month: number): number => {
  if (month < 1 || month > 12) {
    throw new Error(`Invalid month: ${month}`);
  }
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
};

const monthStartUtc = (year: number, month: number): Date => new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0));

const monthEndUtc = (year: number, month: number): Date =>
  new Date(Date.UTC(year, month - 1, daysInMonth(year, month), 23, 59, 59, 999));

export const activeDaysInMonthFromActivation = (monthKey: string, activatedAt: Date): number => {
  const { year, month } = parseMonthKey(monthKey);
  const start = monthStartUtc(year, month);
  const end = monthEndUtc(year, month);

  if (activatedAt > end) {
    return 0;
  }

  if (activatedAt <= start) {
    return daysInMonth(year, month);
  }

  // Count activation day as billable day.
  const activationDay = activatedAt.getUTCDate();
  return daysInMonth(year, month) - activationDay + 1;
};

export const proratedBaseMinor = (args: {
  monthKey: string;
  basePriceMinor: number;
  activatedAt: Date;
}): { baseAmountMinor: number; prorationRatio: number; activeDaysInMonth: number; daysInMonth: number } => {
  const { year, month } = parseMonthKey(args.monthKey);
  const dim = daysInMonth(year, month);
  const activeDays = activeDaysInMonthFromActivation(args.monthKey, args.activatedAt);
  const ratio = dim === 0 ? 0 : activeDays / dim;
  const baseAmount = Math.round(clampNonNegativeInt(args.basePriceMinor) * ratio);

  return {
    baseAmountMinor: baseAmount,
    prorationRatio: ratio,
    activeDaysInMonth: activeDays,
    daysInMonth: dim,
  };
};

export const calculateMonthlyCharge = (input: MonthlyChargeInput): MonthlyChargeBreakdown => {
  const { year, month } = parseMonthKey(input.monthKey);
  const dim = daysInMonth(year, month);

  const consumedUnits = clampNonNegativeInt(input.consumedUnits);
  const includedUnits = clampNonNegativeInt(input.includedUnitsPerMonth);
  const overageUnits = Math.max(consumedUnits - includedUnits, 0);

  const vatRateBps = input.vatRateBps ?? 2500;

  let baseAmountMinor = clampNonNegativeInt(input.basePriceMinor);
  let activeDays = dim;
  let prorationRatio = 1;

  if (input.isFirstBillingMonth && input.activatedAt) {
    const prorated = proratedBaseMinor({
      monthKey: input.monthKey,
      basePriceMinor: input.basePriceMinor,
      activatedAt: input.activatedAt,
    });

    baseAmountMinor = prorated.baseAmountMinor;
    activeDays = prorated.activeDaysInMonth;
    prorationRatio = prorated.prorationRatio;
  }

  const overageAmountMinor = overageUnits * clampNonNegativeInt(input.overageUnitMinor);
  const subtotalMinor = baseAmountMinor + overageAmountMinor;
  const vatAmountMinor = Math.round(subtotalMinor * (vatRateBps / 10000));
  const totalAmountMinor = subtotalMinor + vatAmountMinor;

  return {
    monthKey: input.monthKey,
    daysInMonth: dim,
    activeDaysInMonth: activeDays,
    prorationRatio,
    baseAmountMinor,
    includedUnits,
    consumedUnits,
    overageUnits,
    overageAmountMinor,
    subtotalMinor,
    vatRateBps,
    vatAmountMinor,
    totalAmountMinor,
  };
};

export const shouldEmitIncludedReachedNotice = (args: {
  previousConsumedUnits: number;
  nextConsumedUnits: number;
  includedUnitsPerMonth: number;
}): boolean => {
  const previous = clampNonNegativeInt(args.previousConsumedUnits);
  const next = clampNonNegativeInt(args.nextConsumedUnits);
  const included = clampNonNegativeInt(args.includedUnitsPerMonth);

  return previous < included && next >= included;
};

export const shouldEmitOverageStartedNotice = (args: {
  previousConsumedUnits: number;
  nextConsumedUnits: number;
  includedUnitsPerMonth: number;
}): boolean => {
  const previous = clampNonNegativeInt(args.previousConsumedUnits);
  const next = clampNonNegativeInt(args.nextConsumedUnits);
  const included = clampNonNegativeInt(args.includedUnitsPerMonth);

  return previous <= included && next > included;
};
