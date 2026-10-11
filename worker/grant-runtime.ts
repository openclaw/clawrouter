import type { GrantRuntimeState } from "./types";
import { quotaRuntime, sanitizeGrantFacts } from "./grant-quota.ts";
import { HttpError } from "./utils.ts";

export function normalizeGrantRuntimeState(value: unknown): GrantRuntimeState {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalidRuntime("grant runtime state is invalid");
  const state = value as Partial<GrantRuntimeState>;
  if (!state.observedAt || !Number.isFinite(Date.parse(state.observedAt)) || !["provider_response", "provider_probe"].includes(state.source ?? "")) invalidRuntime("grant runtime observation is invalid");
  if (!state.status || !["available", "limited", "cooldown"].includes(state.status)) invalidRuntime("grant runtime status is invalid");
  if (!state.lastSignal || !["quota", "rate_limited", "authentication"].includes(state.lastSignal)) invalidRuntime("grant runtime signal is invalid");
  const grantRevision = state.grantRevision == null ? null : typeof state.grantRevision === "string" && state.grantRevision.length <= 64 && Number.isFinite(Date.parse(state.grantRevision)) ? state.grantRevision : null;
  const cooldownUntil = state.cooldownUntil == null ? null : Number.isFinite(Date.parse(state.cooldownUntil)) ? state.cooldownUntil : null;
  if (!Array.isArray(state.windows) || state.windows.length > 128) invalidRuntime("grant runtime windows are invalid");
  const windows = state.windows.map((window) => {
    if (!window || !["requests", "tokens", "input_tokens", "output_tokens", "credits", "subscription", "generic"].includes(window.kind)) invalidRuntime("grant runtime window is invalid");
    const id = typeof window.id === "string" && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(window.id) ? window.id : window.kind;
    const unit = window.unit == null ? null : typeof window.unit === "string" && window.unit.length <= 32 ? window.unit : null;
    const quotaWindow = window.window == null ? null : typeof window.window === "string" && window.window.length <= 64 ? window.window : null;
    const metric = (input: unknown) => input == null ? null : typeof input === "number" && Number.isFinite(input) && input >= 0 && input <= Number.MAX_SAFE_INTEGER ? input : NaN;
    const remaining = metric(window.remaining), limit = metric(window.limit);
    if (Number.isNaN(remaining) || Number.isNaN(limit)) invalidRuntime("grant runtime window metric is invalid");
    const resetAt = window.resetAt == null ? null : Number.isFinite(Date.parse(window.resetAt)) ? window.resetAt : null;
    const models = window.models == null ? null : Array.isArray(window.models) && window.models.length > 0 && window.models.length <= 16 && window.models.every(model => typeof model === "string" && /^[a-z0-9][a-z0-9_-]{0,31}$/.test(model)) ? window.models : invalidRuntime("grant window models are invalid");
    const observedAt = window.observedAt && Number.isFinite(Date.parse(window.observedAt)) ? window.observedAt : undefined;
    return { ...(observedAt ? { observedAt } : {}), id, kind: window.kind, unit, window: quotaWindow, remaining, limit, resetAt, ...(models ? { models } : {}) };
  });
  return { status: state.status, observedAt: state.observedAt, source: state.source!, cooldownUntil, lastSignal: state.lastSignal, grantRevision, windows, ...sanitizeGrantFacts(state) };
}

function invalidRuntime(message: string): never { throw new HttpError(400, "invalid_authority_request", message); }

// Independent inference and credential-owner observations can complete out of order.
export function mergeGrantRuntimeState(previous: GrantRuntimeState | null, incoming: GrantRuntimeState, nowMs = Date.now()): GrantRuntimeState {
  if (!previous) return incoming;
  if (previous.grantRevision !== incoming.grantRevision) {
    if (previous.grantRevision && (!incoming.grantRevision || Date.parse(previous.grantRevision) > Date.parse(incoming.grantRevision))) return previous;
    return incoming;
  }
  const latest = Date.parse(incoming.observedAt) >= Date.parse(previous.observedAt) ? incoming : previous;
  const windows = new Map<string, GrantRuntimeState["windows"][number]>();
  for (const state of [previous, incoming]) for (const window of state.windows) {
    const observedAt = window.observedAt ?? state.observedAt;
    const retained = windows.get(window.id);
    if (!retained || Date.parse(observedAt) >= Date.parse(retained.observedAt!)) windows.set(window.id, { ...window, observedAt });
  }
  if (windows.size > 128) invalidRuntime("too many merged quota windows");
  const merged = [...windows.values()];
  const quota = quotaRuntime(merged, latest.source, Date.parse(latest.observedAt));
  const signal = [previous, incoming].filter(state => state.lastSignal !== "quota" && state.cooldownUntil && Date.parse(state.cooldownUntil) > nowMs)
    .sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt))[0];
  return { ...latest, windows: merged, status: signal ? "cooldown" : quota.status,
    cooldownUntil: signal?.cooldownUntil ?? quota.cooldownUntil, lastSignal: signal?.lastSignal ?? "quota",
    account: incoming.account ?? previous.account, extraUsage: incoming.extraUsage ?? previous.extraUsage };
}
