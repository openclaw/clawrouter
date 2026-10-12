export { grantQuotaRatio, windowApplies, grantQuotaExhausted, grantRuntimeFresh, grantCoolingDown } from "../shared/grant-quota.ts";
import type {
  CompiledQuotaConfig, CompiledQuotaProbe, CompiledQuotaProbeWindow, CompiledQuotaWindow,
  GrantQuotaWindow, GrantRuntimeState, GrantAccount, GrantExtraUsage,
} from "./types";

const AUTH_COOLDOWN_MS = 5 * 60_000;
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 60_000;
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
  const windows = [...new Map(probe.windows.flatMap((definition) => quotaWindowFromPayload(payload, definition, nowMs)).map(window => [window.id, window])).values()];
  const facts = sanitizeGrantFacts(Object.fromEntries(Object.entries(probe.facts ?? {}).map(([group, fields]) => [group,
    Object.fromEntries(Object.entries(fields).map(([name, pointer]) => [name, jsonPointer(payload, pointer)])),
  ])));
  return windows.length || facts.account || facts.extraUsage ? { ...quotaRuntime(windows, "provider_probe", nowMs), ...facts } : null;
}

export function shouldFailoverGrant(status: number, method: string, capability: string, grantKey: string | null, enabled = true): boolean {
  return enabled && !!grantKey && [401, 403, 429].includes(status) && (["GET", "HEAD"].includes(method.toUpperCase()) || capability.startsWith("llm."));
}

// Only declared scalar account facts cross the credential-owner boundary.
export function sanitizeGrantFacts(value: unknown): { account?: GrantAccount; extraUsage?: GrantExtraUsage } {
  const result: Record<string, Record<string, string | number | boolean>> = {};
  if (!value || typeof value !== "object") return result;
  for (const [group, fields] of Object.entries({ account: { email: "string", displayName: "string", rateLimitTier: "string", subscriptionStatus: "string", extraUsageEnabled: "boolean" }, extraUsage: { enabled: "boolean", usedCredits: "number", monthlyLimit: "number", utilization: "number", currency: "string", spendLimitReached: "boolean" } })) {
    const source = (value as Record<string, unknown>)[group];
    if (!source || typeof source !== "object") continue;
    const clean: Record<string, string | number | boolean> = {};
    for (const [key, type] of Object.entries(fields)) {
      const field = (source as Record<string, unknown>)[key];
      if (type === "string" && typeof field === "string" && field.length <= 320 && !/[\u0000-\u001f\u007f]/.test(field)) clean[key] = field;
      if (type === "number" && typeof field === "number" && Number.isFinite(field) && field >= 0 && field <= Number.MAX_SAFE_INTEGER) clean[key] = field;
      if (type === "boolean" && typeof field === "boolean") clean[key] = field;
    }
    if (Object.keys(clean).length) result[group] = clean;
  }
  return result;
}

function quotaWindowsFromHeaders(headers: Headers, definitions: CompiledQuotaWindow[], nowMs: number): GrantQuotaWindow[] {
  return definitions.flatMap((definition) => {
    const reportedLimit = scaledMetric(headerNumber(headers, definition.limitHeaders), definition.metricScale);
    let remaining = scaledMetric(headerNumber(headers, definition.remainingHeaders), definition.metricScale);
    const used = scaledMetric(headerNumber(headers, definition.usedHeaders), definition.metricScale);
    const resetAt = headerReset(headers, definition.resetHeaders, nowMs);
    if (reportedLimit === null && remaining === null && used === null && resetAt === null) return [];
    const limit = definition.fixedLimit ?? reportedLimit;
    if (remaining === null && limit !== null && used !== null) remaining = Math.max(0, limit - used);
    return [{ id: definition.id, kind: definition.kind, unit: definition.unit, window: definition.window, observedAt: new Date(nowMs).toISOString(), limit, remaining, resetAt }];
  });
}

function quotaWindowFromPayload(payload: unknown, definition: CompiledQuotaProbeWindow, nowMs: number): GrantQuotaWindow[] {
  if (definition.collection) {
    const collection = definition.collection;
    const entries = jsonPointer(payload, collection.pointer);
    if (!Array.isArray(entries)) return [];
    return entries.slice(0, 64).flatMap(entry => {
      if (jsonPointer(entry, collection.filter.pointer) !== collection.filter.equals) return [];
      const name = jsonPointer(entry, collection.modelPointer);
      const family = typeof name === "string" ? name.toLowerCase() : "";
      if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(family) || `${definition.id}-${family}`.length > 64) return [];
      return quotaWindowFromPayload(entry, { ...definition, collection: null, id: `${definition.id}-${family}`, models: [family] }, nowMs);
    });
  }
  const reportedLimit = scaledMetric(pointerNumber(payload, definition.limitPointer), definition.metricScale);
  let remaining = scaledMetric(pointerNumber(payload, definition.remainingPointer), definition.metricScale);
  const used = scaledMetric(pointerNumber(payload, definition.usedPointer), definition.metricScale);
  const resetAt = pointerReset(payload, definition.resetPointer, nowMs);
  if (reportedLimit === null && remaining === null && used === null && resetAt === null) return [];
  const limit = definition.fixedLimit ?? reportedLimit;
  if (remaining === null && limit !== null && used !== null) remaining = Math.max(0, limit - used);
  return [{ id: definition.id, kind: definition.kind, unit: definition.unit, window: definition.window, observedAt: new Date(nowMs).toISOString(), limit, remaining, resetAt, ...(definition.models ? { models: definition.models } : {}) }];
}

export function quotaRuntime(windows: GrantQuotaWindow[], source: GrantRuntimeState["source"], nowMs: number): GrantRuntimeState {
  const observedAt = new Date(nowMs).toISOString();
  const exhausted = windows.filter((window) => !window.models?.length && window.remaining === 0 && (!window.resetAt || Date.parse(window.resetAt) > nowMs));
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
  return { id, kind, unit: null, window: null, fixedLimit: null, metricScale: 1, limitHeaders, remainingHeaders, usedHeaders: [], resetHeaders };
}

function scaledMetric(value: number | null, scale = 1): number | null {
  return value === null ? null : metric(value * scale);
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
