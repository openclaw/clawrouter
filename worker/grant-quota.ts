import type {
  CompiledQuotaConfig, CompiledQuotaProbe, CompiledQuotaProbeWindow, CompiledQuotaWindow,
  GrantQuotaWindow, GrantRuntimeState,
} from "./types";

const AUTH_COOLDOWN_MS = 5 * 60_000;
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 60_000;
const DEFAULT_STALE_AFTER_MS = 5 * 60_000;
const MAX_COOLDOWN_MS = 24 * 60 * 60_000;

const DEFAULT_QUOTA: CompiledQuotaConfig = {
  responseHeaders: [
    headerWindow("requests", "requests", ["ratelimit-limit-requests", "x-ratelimit-limit-requests", "anthropic-ratelimit-requests-limit"], ["ratelimit-remaining-requests", "x-ratelimit-remaining-requests", "anthropic-ratelimit-requests-remaining"], ["ratelimit-reset-requests", "x-ratelimit-reset-requests", "anthropic-ratelimit-requests-reset"]),
    headerWindow("tokens", "tokens", ["ratelimit-limit-tokens", "x-ratelimit-limit-tokens", "anthropic-ratelimit-tokens-limit"], ["ratelimit-remaining-tokens", "x-ratelimit-remaining-tokens", "anthropic-ratelimit-tokens-remaining"], ["ratelimit-reset-tokens", "x-ratelimit-reset-tokens", "anthropic-ratelimit-tokens-reset"]),
    headerWindow("generic", "generic", ["ratelimit-limit", "x-ratelimit-limit"], ["ratelimit-remaining", "x-ratelimit-remaining"], ["ratelimit-reset", "x-ratelimit-reset"]),
  ],
  probes: [],
};

export function observeGrantQuota(
  response: Pick<Response, "status" | "headers">,
  configOrNow: CompiledQuotaConfig | number = DEFAULT_QUOTA,
  requestedNowMs = Date.now(),
): GrantRuntimeState | null {
  const config = typeof configOrNow === "number" ? DEFAULT_QUOTA : configOrNow;
  const nowMs = typeof configOrNow === "number" ? configOrNow : requestedNowMs;
  const windows = quotaWindowsFromHeaders(response.headers, config.responseHeaders, nowMs);
  const observedAt = new Date(nowMs).toISOString();
  if (response.status === 401 || response.status === 403) {
    return { status: "cooldown", observedAt, source: "provider_response", cooldownUntil: isoAfter(nowMs, AUTH_COOLDOWN_MS), lastSignal: "authentication", grantRevision: null, windows };
  }
  const retryAt = retryAfter(response.headers.get("retry-after"), nowMs);
  const resetAt = earliestFutureReset(windows, nowMs);
  const exhaustedResetAt = latestFutureReset(windows.filter((window) => window.remaining === 0), nowMs);
  if (response.status === 429) {
    return { status: "cooldown", observedAt, source: "provider_response", cooldownUntil: boundedCooldown(retryAt ?? exhaustedResetAt ?? resetAt ?? nowMs + DEFAULT_RATE_LIMIT_COOLDOWN_MS, nowMs), lastSignal: "rate_limited", grantRevision: null, windows };
  }
  return windows.length ? quotaRuntime(windows, "provider_response", nowMs) : null;
}

export function observeGrantQuotaProbe(payload: unknown, probe: CompiledQuotaProbe, nowMs = Date.now()): GrantRuntimeState | null {
  const windows = probe.windows.flatMap((definition) => quotaWindowFromPayload(payload, definition, nowMs));
  return windows.length ? quotaRuntime(windows, "provider_probe", nowMs) : null;
}

export function shouldFailoverGrant(status: number, method: string, capability: string, grantKey: string | null, enabled = true): boolean {
  return enabled && !!grantKey && [401, 403, 429].includes(status) && (["GET", "HEAD"].includes(method.toUpperCase()) || capability.startsWith("llm."));
}

export function grantQuotaRatio(state: GrantRuntimeState | null | undefined, nowMs = Date.now(), staleAfterMs = DEFAULT_STALE_AFTER_MS): number | null {
  if (!grantRuntimeFresh(state, staleAfterMs, nowMs)) return null;
  const ratios = state?.windows.flatMap((window) => window.limit && window.remaining !== null && (!window.resetAt || Date.parse(window.resetAt) > nowMs) ? [Math.min(1, window.remaining / window.limit)] : []) ?? [];
  return ratios.length ? Math.min(...ratios) : null;
}

export function grantRuntimeFresh(state: GrantRuntimeState | null | undefined, staleAfterMs: number, nowMs = Date.now()): boolean {
  const observedAt = state?.observedAt ? Date.parse(state.observedAt) : NaN;
  return Number.isFinite(observedAt) && observedAt + staleAfterMs > nowMs;
}

export function grantCoolingDown(state: GrantRuntimeState | null | undefined, nowMs = Date.now()): boolean {
  return !!state?.cooldownUntil && Date.parse(state.cooldownUntil) > nowMs;
}

function quotaWindowsFromHeaders(headers: Headers, definitions: CompiledQuotaWindow[], nowMs: number): GrantQuotaWindow[] {
  return definitions.flatMap((definition) => {
    const reportedLimit = headerNumber(headers, definition.limitHeaders);
    let remaining = headerNumber(headers, definition.remainingHeaders);
    const used = headerNumber(headers, definition.usedHeaders);
    const resetAt = headerReset(headers, definition.resetHeaders, nowMs);
    if (reportedLimit === null && remaining === null && used === null && resetAt === null) return [];
    const limit = definition.fixedLimit ?? reportedLimit;
    if (remaining === null && limit !== null && used !== null) remaining = Math.max(0, limit - used);
    return [{ id: definition.id, kind: definition.kind, unit: definition.unit, window: definition.window, limit, remaining, resetAt }];
  });
}

function quotaWindowFromPayload(payload: unknown, definition: CompiledQuotaProbeWindow, nowMs: number): GrantQuotaWindow[] {
  const reportedLimit = pointerNumber(payload, definition.limitPointer);
  let remaining = pointerNumber(payload, definition.remainingPointer);
  const used = pointerNumber(payload, definition.usedPointer);
  const resetAt = pointerReset(payload, definition.resetPointer, nowMs);
  if (reportedLimit === null && remaining === null && used === null && resetAt === null) return [];
  const limit = definition.fixedLimit ?? reportedLimit;
  if (remaining === null && limit !== null && used !== null) remaining = Math.max(0, limit - used);
  return [{ id: definition.id, kind: definition.kind, unit: definition.unit, window: definition.window, limit, remaining, resetAt }];
}

function quotaRuntime(windows: GrantQuotaWindow[], source: GrantRuntimeState["source"], nowMs: number): GrantRuntimeState {
  const observedAt = new Date(nowMs).toISOString();
  const exhausted = windows.filter((window) => window.remaining === 0 && (!window.resetAt || Date.parse(window.resetAt) > nowMs));
  const ratios = windows.flatMap((window) => window.limit && window.remaining !== null ? [window.remaining / window.limit] : []);
  return {
    status: exhausted.length ? "cooldown" : ratios.length && Math.min(...ratios) <= 0.1 ? "limited" : "available",
    observedAt,
    source,
    cooldownUntil: exhausted.length ? boundedCooldown(latestFutureReset(exhausted, nowMs) ?? nowMs + DEFAULT_RATE_LIMIT_COOLDOWN_MS, nowMs) : null,
    lastSignal: "quota",
    grantRevision: null,
    windows,
  };
}

function headerWindow(id: string, kind: CompiledQuotaWindow["kind"], limitHeaders: string[], remainingHeaders: string[], resetHeaders: string[]): CompiledQuotaWindow {
  return { id, kind, unit: null, window: null, fixedLimit: null, limitHeaders, remainingHeaders, usedHeaders: [], resetHeaders };
}

function headerNumber(headers: Headers, names: readonly string[]): number | null {
  for (const name of names) {
    const parsed = metric(headers.get(name));
    if (parsed !== null) return parsed;
  }
  return null;
}

function metric(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : null;
  if (typeof value !== "string" || !/^\d+(?:\.\d+)?$/.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= Number.MAX_SAFE_INTEGER ? parsed : null;
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

function pointerNumber(payload: unknown, pointer: string | null): number | null { return metric(jsonPointer(payload, pointer)); }
function pointerReset(payload: unknown, pointer: string | null, nowMs: number): string | null {
  const parsed = parseReset(jsonPointer(payload, pointer), nowMs);
  if (parsed === null) return null;
  const date = new Date(parsed);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function jsonPointer(value: unknown, pointer: string | null): unknown {
  if (!pointer || !pointer.startsWith("/")) return null;
  let current = value;
  for (const part of pointer.slice(1).split("/").map((item) => item.replaceAll("~1", "/").replaceAll("~0", "~"))) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return null;
    current = (current as Record<string, unknown>)[part];
  }
  return current ?? null;
}

function parseReset(value: unknown, nowMs: number): number | null {
  if (typeof value === "number") return finiteReset(value, nowMs);
  if (typeof value !== "string" || !value.trim()) return null;
  const trimmed = value.trim().toLowerCase();
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) return finiteReset(Number(trimmed), nowMs);
  if (/^(?:\d+(?:\.\d+)?(?:ms|s|m|h))+$/i.test(trimmed)) {
    let duration = 0;
    for (const match of trimmed.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/g)) duration += Number(match[1]) * ({ ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[match[2]] ?? 0);
    return nowMs + duration;
  }
  const date = Date.parse(trimmed);
  return Number.isFinite(date) ? date : null;
}

function finiteReset(number: number, nowMs: number): number | null {
  if (!Number.isFinite(number) || number < 0 || number > Number.MAX_SAFE_INTEGER) return null;
  return number >= 1_000_000_000_000 ? number : number >= 1_000_000_000 ? number * 1_000 : nowMs + number * 1_000;
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
