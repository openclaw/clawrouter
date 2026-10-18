import { HttpError } from "./utils.ts";

export function withLimitHint(message: string, policy: { limitHint?: string | null }): string {
  return policy.limitHint ? `${message} ${policy.limitHint}` : message;
}
export function normalizeLimitHint(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== "string" || value.trim().length > 300 || /[\u0000-\u001f\u007f-\u009f]/.test(value)) throw new HttpError(400, "invalid_policy", "limitHint must be plain text, at most 300 characters, without control characters");
  return value.trim() || null;
}
export function nextDailyReset(at = Date.now()): string {
  return new Date(Date.parse(new Date(at).toISOString().slice(0, 10)) + 86_400_000).toISOString();
}
export function dailyBudgetMessage(limit: number, at = Date.now()): string {
  return `Daily budget of $${(limit / 1_000_000).toFixed(6)} exhausted; resets at ${nextDailyReset(at)} (00:00 UTC).`;
}
export function nextWeeklyReset(at = Date.now()): string {
  const date = new Date(at);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + 8 - (date.getUTCDay() || 7));
  return date.toISOString();
}
export function weeklyBudgetMessage(limit: number, at = Date.now()): string {
  return `Weekly budget of $${(limit / 1_000_000).toFixed(6)} exhausted; resets at ${nextWeeklyReset(at)} (Monday 00:00 UTC).`;
}
