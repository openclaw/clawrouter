export function nextDailyReset(at = Date.now()): string {
  return new Date(Date.parse(new Date(at).toISOString().slice(0, 10)) + 86_400_000).toISOString();
}
export function dailyBudgetMessage(limit: number, at = Date.now()): string {
  return `Daily budget of $${(limit / 1_000_000).toFixed(6)} exhausted; resets at ${nextDailyReset(at)} (00:00 UTC).`;
}
