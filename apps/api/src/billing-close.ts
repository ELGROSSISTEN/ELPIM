export type BillingCloseInput = {
  monthKey: string;
  consumedUnits: number;
  basePriceMinor: number;
  includedUnitsPerMonth: number;
  overageUnitMinor: number;
  subscriptionCreatedAt: Date;
};

const MONTH_KEY_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;

const monthKeyFromDateUtc = (date: Date): string => {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  return `${year}-${String(month).padStart(2, '0')}`;
};

const parseMonthKey = (monthKey: string): { year: number; month: number } => {
  const match = monthKey.match(MONTH_KEY_PATTERN);
  if (!match) {
    throw new Error(`Invalid monthKey format: ${monthKey}`);
  }

  return { year: Number(match[1]), month: Number(match[2]) };
};

const daysInMonth = (year: number, month: number): number => new Date(Date.UTC(year, month, 0)).getUTCDate();

const activeDaysInMonthFromActivation = (monthKey: string, activatedAt: Date): number => {
  const { year, month } = parseMonthKey(monthKey);
  const dim = daysInMonth(year, month);
  const monthStart = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0));
  const monthEnd = new Date(Date.UTC(year, month - 1, dim, 23, 59, 59, 999));

  if (activatedAt > monthEnd) {
    return 0;
  }

  if (activatedAt <= monthStart) {
    return dim;
  }

  return dim - activatedAt.getUTCDate() + 1;
};

const calculateMonthlyCharge = (input: {
  monthKey: string;
  consumedUnits: number;
  basePriceMinor: number;
  includedUnitsPerMonth: number;
  overageUnitMinor: number;
  isFirstBillingMonth: boolean;
  activatedAt?: Date;
}) => {
  const { year, month } = parseMonthKey(input.monthKey);
  const dim = daysInMonth(year, month);
  const includedUnits = Math.max(0, Math.trunc(input.includedUnitsPerMonth));
  const consumedUnits = Math.max(0, Math.trunc(input.consumedUnits));
  const overageUnits = Math.max(consumedUnits - includedUnits, 0);

  let baseAmountMinor = Math.max(0, Math.trunc(input.basePriceMinor));
  let activeDaysInMonth = dim;

  if (input.isFirstBillingMonth && input.activatedAt) {
    activeDaysInMonth = activeDaysInMonthFromActivation(input.monthKey, input.activatedAt);
    baseAmountMinor = Math.round(baseAmountMinor * (activeDaysInMonth / dim));
  }

  const overageAmountMinor = overageUnits * Math.max(0, Math.trunc(input.overageUnitMinor));
  const subtotalMinor = baseAmountMinor + overageAmountMinor;
  const vatRateBps = 2500;
  const vatAmountMinor = Math.round(subtotalMinor * (vatRateBps / 10000));
  const totalAmountMinor = subtotalMinor + vatAmountMinor;

  return {
    monthKey: input.monthKey,
    includedUnits,
    consumedUnits,
    overageUnits,
    baseAmountMinor,
    overageAmountMinor,
    subtotalMinor,
    vatRateBps,
    vatAmountMinor,
    totalAmountMinor,
    activeDaysInMonth,
    daysInMonth: dim,
  };
};

export const buildBillingCloseBreakdown = (input: BillingCloseInput) => {
  const firstMonthKey = monthKeyFromDateUtc(input.subscriptionCreatedAt);
  const isFirstBillingMonth = input.monthKey === firstMonthKey;

  return calculateMonthlyCharge({
    monthKey: input.monthKey,
    consumedUnits: input.consumedUnits,
    basePriceMinor: input.basePriceMinor,
    includedUnitsPerMonth: input.includedUnitsPerMonth,
    overageUnitMinor: input.overageUnitMinor,
    isFirstBillingMonth,
    activatedAt: isFirstBillingMonth ? input.subscriptionCreatedAt : undefined,
  });
};
