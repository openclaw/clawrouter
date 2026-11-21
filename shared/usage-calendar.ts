/** Pure calendar mechanics; callers own timezone and date validation. */
export function usageDateLabel(formatter: Intl.DateTimeFormat, at: number): string {
  const parts = formatter.formatToParts(at);
  const part = (name: string) => parts.find(p => p.type === name)!.value;
  return part("year") + "-" + part("month") + "-" + part("day");
}

/** First instant whose local date reaches date, including skipped dates.
 * utcDateStart is the caller-validated UTC midnight for date. */
export function usageDateStart(formatter: Intl.DateTimeFormat, date: string, utcDateStart: number): number {
  let low = utcDateStart - 36 * 3_600_000, high = utcDateStart + 36 * 3_600_000;
  // 29 steps suffice for the 72-hour millisecond search interval.
  for (let i = 0; low < high && i < 29; i++) {
    const mid = low + Math.floor((high - low) / 2);
    if (usageDateLabel(formatter, mid) < date) low = mid + 1; else high = mid;
  }
  return low;
}
