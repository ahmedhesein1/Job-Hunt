import { exchangeRates as defaultRates } from '../../config/profiles';
import type { RawSalary } from '../sources/contract';

export interface NormalizedSalary {
  min?: number | undefined;
  max?: number | undefined;
  currency: string;
  /** Original period as published. */
  period: NonNullable<RawSalary['period']>;
  monthlyMin?: number | undefined;
  monthlyMax?: number | undefined;
  /** Only set when currency is USD or a dated rate exists (§6.3). */
  usdMonthlyMin?: number | undefined;
  usdMonthlyMax?: number | undefined;
  rateAsOf?: string | undefined;
  origin: string;
}

const TO_MONTHLY: Record<NonNullable<RawSalary['period']>, number> = {
  year: 1 / 12,
  month: 1,
  week: 52 / 12,
  day: 260 / 12,
  hour: 2080 / 12,
};

/** Plausible monthly range in any currency; values outside are source junk (e.g. Remote OK 114000000). */
const MIN_PLAUSIBLE_MONTHLY = 50;
const MAX_PLAUSIBLE_MONTHLY = 5_000_000;

function positive(n: number | undefined): number | undefined {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : undefined;
}

export function normalizeSalary(raw: RawSalary | undefined, rates = defaultRates): NormalizedSalary | undefined {
  if (!raw) return undefined;
  let min = positive(raw.min);
  let max = positive(raw.max);
  if (min === undefined && max === undefined) return undefined;
  if (min !== undefined && max !== undefined && min > max) [min, max] = [max, min];
  const currency = (raw.currency ?? '').trim().toUpperCase();
  if (!currency) return undefined;
  const period = raw.period ?? 'year';
  const factor = TO_MONTHLY[period];
  const monthlyMin = min !== undefined ? Math.round(min * factor) : undefined;
  const monthlyMax = max !== undefined ? Math.round(max * factor) : undefined;
  const probe = monthlyMax ?? monthlyMin ?? 0;
  if (probe < MIN_PLAUSIBLE_MONTHLY || probe > MAX_PLAUSIBLE_MONTHLY) return undefined;

  const result: NormalizedSalary = { min, max, currency, period, monthlyMin, monthlyMax, origin: raw.origin };
  const rate = currency === 'USD' ? 1 : rates.toUsd[currency];
  if (rate !== undefined && (currency === 'USD' || rates.asOf)) {
    result.usdMonthlyMin = monthlyMin !== undefined ? Math.round(monthlyMin * rate) : undefined;
    result.usdMonthlyMax = monthlyMax !== undefined ? Math.round(monthlyMax * rate) : undefined;
    result.rateAsOf = currency === 'USD' ? undefined : rates.asOf;
  }
  return result;
}

/** Infer a period from a free-text interval like "per-year-salary", "1 YEAR", "monthly". */
export function parsePeriod(value: string | undefined | null): RawSalary['period'] {
  if (!value) return undefined;
  const v = value.toLowerCase();
  if (/hour/.test(v)) return 'hour';
  if (/day|daily/.test(v)) return 'day';
  if (/week/.test(v)) return 'week';
  if (/month/.test(v)) return 'month';
  if (/year|annual|annum/.test(v)) return 'year';
  return undefined;
}

export function formatSalary(s: NormalizedSalary): string {
  const fmt = (n: number) => n.toLocaleString('en-US');
  const range =
    s.monthlyMin !== undefined && s.monthlyMax !== undefined && s.monthlyMin !== s.monthlyMax
      ? `${fmt(s.monthlyMin)}–${fmt(s.monthlyMax)}`
      : fmt((s.monthlyMin ?? s.monthlyMax) as number);
  return `${range} ${s.currency} / month`;
}
