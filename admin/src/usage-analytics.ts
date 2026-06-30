import type { UsageDailySummary, UsageSnapshot } from "./ui-types";

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

function emptyUsageDay(dayStartMs: number): UsageDailySummary {
  return { dayStartMs, requestCount: 0, successCount: 0, errorCount: 0, totalTokens: 0, actualCostMicros: 0 };
}
