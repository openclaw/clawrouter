import type { UsageDailySummary, UsageSnapshot, UsageSummary } from "./ui-types";

export const usageDayMs = 86_400_000;

export function usageTimeline(snapshot: UsageSnapshot, days = 30, now = Date.now()): UsageDailySummary[] {
  const today = Math.floor(now / usageDayMs) * usageDayMs;
  const firstDay = today - (days - 1) * usageDayMs;
  const buckets = new Map<number, UsageDailySummary>();
  const source = snapshot.daily ?? [];

  for (const point of source) {
    const dayStartMs = Math.floor(point.dayStartMs / usageDayMs) * usageDayMs;
    if (dayStartMs < firstDay || dayStartMs > today) continue;
    const current = buckets.get(dayStartMs) ?? emptyUsageDay(dayStartMs);
    buckets.set(dayStartMs, {
      dayStartMs,
      requestCount: current.requestCount + point.requestCount,
      successCount: current.successCount + point.successCount,
      errorCount: current.errorCount + point.errorCount,
      totalTokens: current.totalTokens + point.totalTokens,
      actualCostMicros: current.actualCostMicros + point.actualCostMicros,
    });
  }

  return Array.from({ length: days }, (_, index) => {
    const dayStartMs = firstDay + index * usageDayMs;
    return buckets.get(dayStartMs) ?? emptyUsageDay(dayStartMs);
  });
}

export function niceChartMaximum(value: number, ticks = 4): number {
  if (value <= 0) return ticks;
  const roughStep = value / ticks;
  const magnitude = 10 ** Math.floor(Math.log10(roughStep));
  const normalized = roughStep / magnitude;
  const normalizedStep = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 4 ? 4 : normalized <= 5 ? 5 : 10;
  const niceStep = Math.max(1, normalizedStep * magnitude);
  return niceStep * ticks;
}

export function syntheticUsageTimeline(now: number, summary: UsageSummary): UsageDailySummary[] {
  const today = Math.floor(now / usageDayMs) * usageDayMs;
  const weights = [31, 34, 29, 36, 39, 33, 27, 41, 44, 38, 46, 49, 43, 35, 52, 55, 48, 58, 62, 54, 47, 64, 69, 61, 73, 67, 76, 81, 72, 88];
  const requestSeries = distributeTotal(summary.requestCount, weights);
  const errorSeries = distributeTotal(summary.errorCount, weights.map((weight, index) => weight * (index % 7 === 2 ? 2 : 1)));
  const tokenSeries = distributeTotal(summary.totalTokens, weights.map((weight, index) => weight * (index % 5 === 0 ? 1.18 : 1)));
  const costSeries = distributeTotal(summary.actualCostMicros, weights.map((weight, index) => weight * (index % 6 === 4 ? 1.25 : 1)));
  return weights.map((_, index) => ({
    dayStartMs: today - (weights.length - index - 1) * usageDayMs,
    requestCount: requestSeries[index],
    successCount: requestSeries[index] - errorSeries[index],
    errorCount: errorSeries[index],
    totalTokens: tokenSeries[index],
    actualCostMicros: costSeries[index],
  }));
}

function distributeTotal(total: number, weights: number[]) {
  const sum = weights.reduce((value, weight) => value + weight, 0);
  const values = weights.map((weight) => Math.floor((total * weight) / sum));
  let remainder = total - values.reduce((value, amount) => value + amount, 0);
  for (let index = values.length - 1; remainder > 0; index = (index - 1 + values.length) % values.length) {
    values[index] += 1;
    remainder -= 1;
  }
  return values;
}

function emptyUsageDay(dayStartMs: number): UsageDailySummary {
  return { dayStartMs, requestCount: 0, successCount: 0, errorCount: 0, totalTokens: 0, actualCostMicros: 0 };
}
