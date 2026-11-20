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
  let windowSnapshots: GrantRuntimeState["windowSnapshots"];
  if (state.windowSnapshots !== undefined) {
    if (!state.windowSnapshots || typeof state.windowSnapshots !== "object" || Array.isArray(state.windowSnapshots) || Object.keys(state.windowSnapshots).length > 128) invalidRuntime("grant window snapshots are invalid");
    windowSnapshots = Object.fromEntries(Object.entries(state.windowSnapshots).map(([scope, snapshot]) => {
      if (!/^[a-z0-9][a-z0-9_-]{0,63}(?:-\*)?$/.test(scope) || !snapshot || typeof snapshot !== "object"
        || typeof snapshot.observedAt !== "string" || !Number.isFinite(Date.parse(snapshot.observedAt)) || !Array.isArray(snapshot.ids) || snapshot.ids.length > 128
        || !snapshot.ids.every(id => typeof id === "string" && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(id) && snapshotApplies(scope, id))) invalidRuntime("grant window snapshot is invalid");
      return [scope, { observedAt: snapshot.observedAt, ids: [...new Set(snapshot.ids)] }];
    }));
  }
  return { status: state.status, observedAt: state.observedAt, source: state.source!, cooldownUntil, lastSignal: state.lastSignal, grantRevision, windows, ...(windowSnapshots ? { windowSnapshots } : {}), ...sanitizeGrantFacts(state) };
}

function snapshotApplies(scope: string, id: string): boolean { return scope.endsWith("*") ? id.startsWith(scope.slice(0, -1)) : id === scope; }

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
  const windowSnapshots: NonNullable<GrantRuntimeState["windowSnapshots"]> = Object.create(null);
  for (const state of [previous, incoming]) for (const [scope, snapshot] of Object.entries(state.windowSnapshots ?? {})) {
    if (!windowSnapshots[scope] || Date.parse(snapshot.observedAt) >= Date.parse(windowSnapshots[scope].observedAt)) windowSnapshots[scope] = snapshot;
  }
  if (Object.keys(windowSnapshots).length > 128) invalidRuntime("too many merged quota snapshots");
  // Persist the scope watermark, not just the deletion: late header/probe feedback
  // must not resurrect a window absent from a newer successful usage snapshot.
  const merged = [...windows.values()].filter(window => !Object.entries(windowSnapshots).some(([scope, snapshot]) =>
    snapshotApplies(scope, window.id) && Date.parse(window.observedAt!) <= Date.parse(snapshot.observedAt) && !snapshot.ids.includes(window.id)));
  const quota = quotaRuntime(merged, latest.source, Date.parse(latest.observedAt));
  const signal = [previous, incoming].filter(state => state.lastSignal !== "quota" && state.cooldownUntil && Date.parse(state.cooldownUntil) > nowMs)
    .sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt))[0];
  return { ...latest, windows: merged, ...(Object.keys(windowSnapshots).length ? { windowSnapshots } : {}), status: signal ? "cooldown" : quota.status,
    cooldownUntil: signal?.cooldownUntil ?? quota.cooldownUntil, lastSignal: signal?.lastSignal ?? "quota",
    account: incoming.account ?? previous.account, extraUsage: incoming.extraUsage ?? previous.extraUsage };
}


// PRIVATE full-admission bridge only. Validate with scalar/own-property walks,
// then admit the complete generated layout before constructing output arrays.
// Ordinary normalization and runtime merge/feedback above remain unchanged.
export function normalizePrivateGrantRuntimeState(value: unknown,
  admit: (state: GrantRuntimeState) => void): GrantRuntimeState {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalidRuntime("grant runtime state is invalid");
  const state = value as Partial<GrantRuntimeState>;
  if (!state.observedAt || !Number.isFinite(Date.parse(state.observedAt)) || !["provider_response", "provider_probe"].includes(state.source ?? "")) invalidRuntime("grant runtime observation is invalid");
  if (!state.status || !["available", "limited", "cooldown"].includes(state.status)) invalidRuntime("grant runtime status is invalid");
  if (!state.lastSignal || !["quota", "rate_limited", "authentication"].includes(state.lastSignal)) invalidRuntime("grant runtime signal is invalid");
  const grantRevision = state.grantRevision == null ? null : typeof state.grantRevision === "string" && state.grantRevision.length <= 64 && Number.isFinite(Date.parse(state.grantRevision)) ? state.grantRevision : null;
  const cooldownUntil = state.cooldownUntil == null ? null : Number.isFinite(Date.parse(state.cooldownUntil)) ? state.cooldownUntil : null;
  if (!Array.isArray(state.windows) || state.windows.length > 128) invalidRuntime("grant runtime windows are invalid");
  for (const window of state.windows) {
    if (!window || !["requests", "tokens", "input_tokens", "output_tokens", "credits", "subscription", "generic"].includes(window.kind)) invalidRuntime("grant runtime window is invalid");
    for (const input of [window.remaining, window.limit]) if (input != null && (typeof input !== "number" || !Number.isFinite(input) || input < 0 || input > Number.MAX_SAFE_INTEGER)) invalidRuntime("grant runtime window metric is invalid");
    // Preserve ordinary scalar coercion/error ordering before models validation.
    if (window.resetAt != null) Number.isFinite(Date.parse(window.resetAt));
    if (window.models != null && (!Array.isArray(window.models) || !window.models.length || window.models.length > 16
      || !window.models.every(model => typeof model === "string" && /^[a-z0-9][a-z0-9_-]{0,31}$/.test(model)))) invalidRuntime("grant window models are invalid");
    if (window.observedAt) Number.isFinite(Date.parse(window.observedAt));
  }
  if (state.windowSnapshots !== undefined) {
    if (!state.windowSnapshots || typeof state.windowSnapshots !== "object" || Array.isArray(state.windowSnapshots)) invalidRuntime("grant window snapshots are invalid");
    let count = 0;
    for (const scope in state.windowSnapshots) if (Object.hasOwn(state.windowSnapshots, scope) && ++count > 128) invalidRuntime("grant window snapshots are invalid");
    for (const scope in state.windowSnapshots) if (Object.hasOwn(state.windowSnapshots, scope)) {
      const snapshot = state.windowSnapshots[scope];
      if (!/^[a-z0-9][a-z0-9_-]{0,63}(?:-\*)?$/.test(scope) || !snapshot || typeof snapshot !== "object"
        || typeof snapshot.observedAt !== "string" || !Number.isFinite(Date.parse(snapshot.observedAt)) || !Array.isArray(snapshot.ids) || snapshot.ids.length > 128
        || !snapshot.ids.every(id => typeof id === "string" && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(id) && snapshotApplies(scope, id))) invalidRuntime("grant window snapshot is invalid");
    }
  }
  // The bridge supplies a prospective WHOLE result, not a per-row allowance.
  // No unrelated await/callback or borrowed-source mutation separates the plan
  // and construction. The trusted callback is internal to the private owner.
  admit(state as GrantRuntimeState);
  const windows: GrantRuntimeState["windows"] = [];
  for (const window of state.windows) {
    const observedAt = window.observedAt && Number.isFinite(Date.parse(window.observedAt)) ? window.observedAt : undefined;
    windows.push({ ...(observedAt ? { observedAt } : {}),
      id: typeof window.id === "string" && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(window.id) ? window.id : window.kind,
      kind: window.kind,
      unit: window.unit == null ? null : typeof window.unit === "string" && window.unit.length <= 32 ? window.unit : null,
      window: window.window == null ? null : typeof window.window === "string" && window.window.length <= 64 ? window.window : null,
      remaining: window.remaining ?? null, limit: window.limit ?? null,
      resetAt: window.resetAt == null ? null : Number.isFinite(Date.parse(window.resetAt)) ? window.resetAt : null,
      ...(window.models ? { models: window.models } : {}) });
  }
  let windowSnapshots: GrantRuntimeState["windowSnapshots"];
  if (state.windowSnapshots !== undefined) {
    windowSnapshots = {};
    for (const scope in state.windowSnapshots) if (Object.hasOwn(state.windowSnapshots, scope)) {
      const snapshot = state.windowSnapshots[scope], ids: string[] = [];
      for (let index = 0; index < snapshot.ids.length; index++) if (snapshot.ids.indexOf(snapshot.ids[index]) === index) ids.push(snapshot.ids[index]);
      windowSnapshots[scope] = { observedAt: snapshot.observedAt, ids };
    }
  }
  return { status: state.status, observedAt: state.observedAt, source: state.source!, cooldownUntil, lastSignal: state.lastSignal, grantRevision, windows,
    ...(windowSnapshots ? { windowSnapshots } : {}), ...sanitizeGrantFacts(state) };
}
