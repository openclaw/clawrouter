import type { GrantQuotaWindow, GrantRuntimeState } from "./types";

const AUTH_COOLDOWN_MS = 5 * 60_000;
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 60_000;
const MAX_COOLDOWN_MS = 24 * 60 * 60_000;

const WINDOW_HEADERS = [
  { kind: "requests", limit: ["ratelimit-limit-requests", "x-ratelimit-limit-requests", "anthropic-ratelimit-requests-limit"], remaining: ["ratelimit-remaining-requests", "x-ratelimit-remaining-requests", "anthropic-ratelimit-requests-remaining"], reset: ["ratelimit-reset-requests", "x-ratelimit-reset-requests", "anthropic-ratelimit-requests-reset"] },
  { kind: "tokens", limit: ["ratelimit-limit-tokens", "x-ratelimit-limit-tokens", "anthropic-ratelimit-tokens-limit"], remaining: ["ratelimit-remaining-tokens", "x-ratelimit-remaining-tokens", "anthropic-ratelimit-tokens-remaining"], reset: ["ratelimit-reset-tokens", "x-ratelimit-reset-tokens", "anthropic-ratelimit-tokens-reset"] },
  { kind: "generic", limit: ["ratelimit-limit", "x-ratelimit-limit"], remaining: ["ratelimit-remaining", "x-ratelimit-remaining"], reset: ["ratelimit-reset", "x-ratelimit-reset"] },
] as const;

export function observeGrantQuota(response: Pick<Response, "status" | "headers">, nowMs = Date.now()): GrantRuntimeState | null {
  const windows = WINDOW_HEADERS.flatMap((definition) => {
    const limit = headerNumber(response.headers, definition.limit);
    const remaining = headerNumber(response.headers, definition.remaining);
    const resetAt = headerReset(response.headers, definition.reset, nowMs);
    return limit === null && remaining === null && resetAt === null ? [] : [{ kind: definition.kind, limit, remaining, resetAt } satisfies GrantQuotaWindow];
  });
  const observedAt = new Date(nowMs).toISOString();
  if (response.status === 401 || response.status === 403) {
    return { status: "cooldown", observedAt, source: "provider_response", cooldownUntil: isoAfter(nowMs, AUTH_COOLDOWN_MS), lastSignal: "authentication", grantRevision: null, windows };
  }
  const retryAt = retryAfter(response.headers.get("retry-after"), nowMs);
  const resetAt = earliestFutureReset(windows, nowMs);
  const exhaustedWindows = windows.filter((window) => window.remaining === 0);
  const exhaustedResetAt = latestFutureReset(exhaustedWindows, nowMs);
  if (response.status === 429) {
    return { status: "cooldown", observedAt, source: "provider_response", cooldownUntil: boundedCooldown(retryAt ?? exhaustedResetAt ?? resetAt ?? nowMs + DEFAULT_RATE_LIMIT_COOLDOWN_MS, nowMs), lastSignal: "rate_limited", grantRevision: null, windows };
  }
  if (!windows.length) return null;
  const exhausted = windows.some((window) => window.remaining === 0 && !!window.resetAt && Date.parse(window.resetAt) > nowMs);
  const ratios = windows.flatMap((window) => window.limit && window.remaining !== null ? [window.remaining / window.limit] : []);
  return {
    status: exhausted ? "cooldown" : ratios.length && Math.min(...ratios) <= 0.1 ? "limited" : "available",
    observedAt,
    source: "provider_response",
    cooldownUntil: exhausted ? boundedCooldown(exhaustedResetAt ?? nowMs + DEFAULT_RATE_LIMIT_COOLDOWN_MS, nowMs) : null,
    lastSignal: "quota",
    grantRevision: null,
    windows,
  };
}

export function shouldFailoverGrant(status: number, method: string, capability: string, grantKey: string | null): boolean {
  return !!grantKey && [401, 403, 429].includes(status) && (["GET", "HEAD"].includes(method.toUpperCase()) || capability.startsWith("llm."));
}

export function grantQuotaRatio(state: GrantRuntimeState | null | undefined, nowMs = Date.now()): number | null {
  const observedAt = state?.observedAt ? Date.parse(state.observedAt) : NaN;
  const ratios = state?.windows.flatMap((window) => window.limit && window.remaining !== null && (window.resetAt ? Date.parse(window.resetAt) > nowMs : Number.isFinite(observedAt) && observedAt + 5 * 60_000 > nowMs) ? [Math.min(1, window.remaining / window.limit)] : []) ?? [];
  return ratios.length ? Math.min(...ratios) : null;
}

export function grantCoolingDown(state: GrantRuntimeState | null | undefined, nowMs = Date.now()): boolean {
  return !!state?.cooldownUntil && Date.parse(state.cooldownUntil) > nowMs;
}

function headerNumber(headers: Headers, names: readonly string[]): number | null {
  for (const name of names) {
    const value = headers.get(name);
    if (value == null || !/^\d+(?:\.\d+)?$/.test(value.trim())) continue;
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0 && parsed <= Number.MAX_SAFE_INTEGER) return parsed;
  }
  return null;
}

function headerReset(headers: Headers, names: readonly string[], nowMs: number): string | null {
  for (const name of names) {
    const parsed = parseReset(headers.get(name), nowMs);
    if (parsed !== null) {
      const date = new Date(parsed);
      if (Number.isFinite(date.getTime())) return date.toISOString();
    }
  }
  return null;
}

function parseReset(value: string | null, nowMs: number): number | null {
  if (!value) return null;
  const trimmed = value.trim().toLowerCase();
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const number = Number(trimmed);
    if (!Number.isFinite(number) || number < 0) return null;
    return number >= 1_000_000_000_000 ? number : number >= 1_000_000_000 ? number * 1_000 : nowMs + number * 1_000;
  }
  if (/^(?:\d+(?:\.\d+)?(?:ms|s|m|h))+$/i.test(trimmed)) {
    let duration = 0;
    for (const match of trimmed.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/g)) duration += Number(match[1]) * ({ ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[match[2]] ?? 0);
    return nowMs + duration;
  }
  const date = Date.parse(trimmed);
  return Number.isFinite(date) ? date : null;
}

function retryAfter(value: string | null, nowMs: number): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) return nowMs + Number(trimmed) * 1_000;
  const date = Date.parse(trimmed);
  return Number.isFinite(date) ? date : null;
}

function earliestFutureReset(windows: GrantQuotaWindow[], nowMs: number): number | null {
  const resets = windows.map((window) => window.resetAt ? Date.parse(window.resetAt) : NaN).filter((value) => Number.isFinite(value) && value > nowMs);
  return resets.length ? Math.min(...resets) : null;
}

function latestFutureReset(windows: GrantQuotaWindow[], nowMs: number): number | null {
  const resets = windows.map((window) => window.resetAt ? Date.parse(window.resetAt) : NaN).filter((value) => Number.isFinite(value) && value > nowMs);
  return resets.length ? Math.max(...resets) : null;
}

function boundedCooldown(value: number, nowMs: number): string {
  return new Date(Math.max(nowMs, Math.min(value, nowMs + MAX_COOLDOWN_MS))).toISOString();
}

function isoAfter(nowMs: number, durationMs: number): string { return new Date(nowMs + durationMs).toISOString(); }
