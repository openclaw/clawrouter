export interface QuotaWindow {
  models?: string[] | null;
  limit: number | null;
  remaining: number | null;
  resetAt: string | null;
  observedAt?: string;
}
export interface QuotaState { observedAt: string; cooldownUntil?: string | null; windows: QuotaWindow[] }
const DEFAULT_STALE_AFTER_MS = 5 * 60_000;

export function grantQuotaRatio(state: QuotaState | null | undefined, nowMs = Date.now(), staleAfterMs = DEFAULT_STALE_AFTER_MS, model?: string | null): number | null {
  if (!grantRuntimeFresh(state, staleAfterMs, nowMs, model)) return null;
  const ratios = state?.windows.flatMap((window) => windowApplies(window, model) && window.limit && window.remaining !== null && (!window.resetAt || Date.parse(window.resetAt) > nowMs) ? [Math.min(1, window.remaining / window.limit)] : []) ?? [];
  return ratios.length ? Math.min(...ratios) : null;
}

export function windowApplies(window: QuotaWindow, model?: string | null): boolean {
  return !window.models?.length || !!model && window.models.some(token => model.toLowerCase().includes(token));
}

export function grantQuotaExhausted(state: QuotaState | null | undefined, model: string | null | undefined, reserve = 0, includeUnscoped = true, now = Date.now()): boolean {
  // The admission check cannot prevent one already in-flight request crossing the reserve.
  return exhaustingWindows(state, model, reserve, includeUnscoped, now).length > 0;
}

// When every exhausting window lifts. Null when one has no published reset.
export function grantQuotaResetAt(state: QuotaState | null | undefined, model: string | null | undefined, reserve = 0, includeUnscoped = true, now = Date.now()): number | null {
  const windows = exhaustingWindows(state, model, reserve, includeUnscoped, now);
  if (!windows.length || windows.some(window => !window.resetAt)) return null;
  return Math.max(...windows.map(window => Date.parse(window.resetAt!)));
}

function exhaustingWindows(state: QuotaState | null | undefined, model: string | null | undefined, reserve: number, includeUnscoped: boolean, now: number): QuotaWindow[] {
  return state?.windows.filter(window => (includeUnscoped || !!window.models?.length) && windowApplies(window, model)
    && (!window.resetAt || Date.parse(window.resetAt) > now)
    && (window.remaining === 0 || !!window.limit && window.remaining !== null && window.remaining / window.limit * 100 <= reserve)) ?? [];
}

export function grantRuntimeFresh(state: QuotaState | null | undefined, staleAfterMs: number, nowMs = Date.now(), model?: string | null): boolean {
  const fresh = (value: string | undefined) => !!value && Number.isFinite(Date.parse(value)) && Date.parse(value) + staleAfterMs > nowMs;
  if (!state || !fresh(state.observedAt)) return false;
  const applicable = state.windows.filter(window => windowApplies(window, model) && (!window.resetAt || Date.parse(window.resetAt) > nowMs));
  return applicable.length > 0 && applicable.every(window => fresh(window.observedAt ?? state.observedAt));
}

export function grantCoolingDown(state: QuotaState | null | undefined, nowMs = Date.now()): boolean {
  return !!state?.cooldownUntil && Date.parse(state.cooldownUntil) > nowMs;
}

