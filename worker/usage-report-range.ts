import type { UsageReportRange } from "../shared/usage-report.ts";
import { HttpError } from "./utils.ts";

export const reportDayMs = 86_400_000;
export const reportRetentionMs = 30 * reportDayMs;
function invalid(message: string): never { throw new HttpError(400, "invalid_usage_range", message); }

/** Date-only Intl conversion: bounded binary search, no whole-hour offset assumptions.
 * Finds the first instant of a local date, including midnight gaps/folds and skipped dates. */
export function usageDateTools(timezone: string) {
  let formatter: Intl.DateTimeFormat;
  try { formatter = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }); }
  catch { return invalid("timezone must be a supported IANA timezone"); }
  const label = (at: number) => {
    const parts = formatter.formatToParts(at);
    const part = (name: string) => parts.find(p => p.type === name)!.value;
    return part("year") + "-" + part("month") + "-" + part("day");
  };
  const midnight = (date: string) => {
    const utc = Date.parse(date + "T00:00:00Z");
    if (!Number.isFinite(utc) || new Date(utc).toISOString().slice(0, 10) !== date) invalid("invalid calendar date");
    let low = utc - 36 * 3_600_000, high = utc + 36 * 3_600_000;
    // 29 steps suffice for the 72-hour millisecond search interval.
    for (let i = 0; low < high && i < 29; i++) {
      const mid = low + Math.floor((high - low) / 2);
      if (label(mid) < date) low = mid + 1; else high = mid;
    }
    return low;
  };
  return { label, midnight };
}
export function nextUsageDate(date: string): string { return new Date(Date.parse(date + "T00:00:00Z") + reportDayMs).toISOString().slice(0, 10); }

export function parseUsageReportRange(params: URLSearchParams, now = Date.now()): UsageReportRange {
  const timezone = params.get("timezone") ?? "UTC";
  if (timezone.length > 100 || /^[+-]/.test(timezone)) invalid("timezone must be an IANA timezone");
  const tools = usageDateTools(timezone);
  const instant = (value: string | null, fallback: number) => {
    if (value === null) return fallback;
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return tools.midnight(value);
    if (!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) invalid("from/to must be dates or RFC3339 instants");
    const at = Date.parse(value);
    if (!Number.isFinite(at) || new Date(Date.parse(value.slice(0, 10) + "T00:00:00Z")).toISOString().slice(0, 10) !== value.slice(0, 10)) invalid("invalid instant");
    return at;
  };
  const to = instant(params.get("to"), now);
  const requestedFrom = instant(params.get("from"), to - 7 * reportDayMs);
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/;
  const calendarRange = dateOnly.test(params.get("from") ?? "") && dateOnly.test(params.get("to") ?? "");
  const calendarDays = calendarRange ? (Date.parse(params.get("to")!) - Date.parse(params.get("from")!)) / reportDayMs : 0;
  // Calendar-date ranges count local days, not 24-hour periods across DST.
  if (requestedFrom >= to || (calendarRange ? calendarDays > 30 || to - requestedFrom > 31 * reportDayMs : to - requestedFrom > 30 * reportDayMs)) invalid("range must be positive and at most 30 days");
  if (to > now) invalid("to must not be in the future");
  const retentionStart = now - reportRetentionMs;
  const from = Math.min(to, Math.max(requestedFrom, retentionStart));
  const buckets: UsageReportRange["buckets"] = [];
  let date = tools.label(from), start = from;
  for (let days = 0; start < to && buckets.length < 32 && days < 33; days++) {
    const nextDate = nextUsageDate(date), boundary = tools.midnight(nextDate);
    const end = Math.min(to, boundary);
    if (end > start) { buckets.push({ start, end, label: date }); start = end; }
    date = nextDate;
  }
  if (start < to) invalid("range exceeds 32 daily buckets");
  return { from, to, timezone, retentionStart, clampedStart: from !== requestedFrom, buckets };
}
