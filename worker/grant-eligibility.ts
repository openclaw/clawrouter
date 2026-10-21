import { HttpError } from "./utils.ts";
import { assertOperationConfiguration, grantSupports, type GrantRequirement } from "./provider-auth.ts";
import { grantCoolingDown, grantQuotaExhausted, grantQuotaResetAt, grantRuntimeFresh } from "./grant-quota.ts";
import type { Env, GrantRoutingPolicy, GrantRuntimeState, UpstreamGrant } from "./types";

const DEFAULT_GRANT_PRIORITY = 100;
const DEFAULT_GRANT_WEIGHT = 1;
export const DEFAULT_GRANT_ROUTING: GrantRoutingPolicy = {
  strategy: "most_remaining",
  stickiness: "none",
  failover: true,
  environmentFallback: false,
  includedQuotaReservePercent: 0,
  staleState: "allow",
  staleAfterSeconds: 300,
  switchAtUsedPercent: 90,
  hysteresisPercent: 10,
  eligibleGrants: {},
};

export function grantRoutingPolicy(value: GrantRoutingPolicy | null | undefined): GrantRoutingPolicy {
  if (!value) return { ...DEFAULT_GRANT_ROUTING, eligibleGrants: {} };
  const eligibleGrants: Record<string, string[]> = {};
  if (value.eligibleGrants && typeof value.eligibleGrants === "object" && !Array.isArray(value.eligibleGrants)) {
    for (const [providerId, refs] of Object.entries(value.eligibleGrants)) {
      if (!validGrantSegment(providerId) || !Array.isArray(refs)) continue;
      eligibleGrants[providerId] = [...new Set(refs.filter((ref): ref is string => typeof ref === "string" && validGrantSegment(ref)))].slice(0, 32).sort();
    }
  }
  const strategy = ["priority", "round_robin", "least_used", "most_remaining", "threshold", "weighted_random"].includes(value.strategy) ? value.strategy : DEFAULT_GRANT_ROUTING.strategy;
  return {
    strategy,
    stickiness: strategy === "threshold" ? "none" : ["none", "identity", "session"].includes(value.stickiness) ? value.stickiness : DEFAULT_GRANT_ROUTING.stickiness,
    failover: value.failover !== false,
    environmentFallback: value.environmentFallback === true,
    includedQuotaReservePercent: Number.isInteger(value.includedQuotaReservePercent) && value.includedQuotaReservePercent! >= 0 && value.includedQuotaReservePercent! <= 50 ? value.includedQuotaReservePercent : 0,
    staleState: value.staleState === "deny" ? "deny" : "allow",
    staleAfterSeconds: Number.isSafeInteger(value.staleAfterSeconds) && value.staleAfterSeconds >= 30 && value.staleAfterSeconds <= 86_400 ? value.staleAfterSeconds : DEFAULT_GRANT_ROUTING.staleAfterSeconds,
    switchAtUsedPercent: finitePercent(value.switchAtUsedPercent, DEFAULT_GRANT_ROUTING.switchAtUsedPercent),
    hysteresisPercent: finitePercent(value.hysteresisPercent, DEFAULT_GRANT_ROUTING.hysteresisPercent),
    eligibleGrants,
  };
}

export interface SelectedGrant {
  authorityRevision?: number;
  key: string;
  grant: UpstreamGrant;
  runtimeState: GrantRuntimeState | null;
}

export interface GrantSelectionResult {
  selected: SelectedGrant | null;
  hasConfiguredGrant: boolean;
  // Earliest time a cooling or quota-exhausted pooled grant can serve again.
  retryAt?: string;
}
export type PinnedGrant = { key: string | null; revision: string | null } | { key: string; lineage: string };

export function grantUsable(grant: UpstreamGrant): boolean {
  if (grant.credentialStore === "durable_object") {
    return grant.credentialStatus !== "reauth_required" && !!(grant.hasCredential || grant.hasAccessToken);
  }
  const scalarCredentials = [grant.credential, grant.accessToken, grant.refreshToken];
  if (scalarCredentials.some((value) => value != null && (typeof value !== "string" || value.trim().length === 0)) || !validCredentialBundle(grant.credentials)) return false;
  const bundled = grant.credentials ? Object.values(grant.credentials) : [];
  return [grant.credential, grant.accessToken, ...bundled].some((value) => typeof value === "string" && value.trim().length > 0);
}

export function validCredentialBundle(value: UpstreamGrant["credentials"]): boolean {
  return value == null || (!Array.isArray(value) && typeof value === "object" && Object.entries(value).every(([name, secret]) => /^[A-Za-z0-9_.-]{1,128}$/.test(name) && typeof secret === "string" && secret.trim().length > 0));
}

export interface GrantCandidates { available: SelectedGrant[]; hasConfiguredGrant: boolean; recovering?: Array<{ entry: SelectedGrant; atMs: number }> }

export function activeOperationCandidates(available: SelectedGrant[], env: Env, requirement?: GrantRequirement): SelectedGrant[] {
  // Qualification follows policy choice. Preserve the original pool-presence
  // fact so an unusable configured pool cannot fall back to environment auth.
  const configured = available.filter(({ grant }) => operationConfigured(grant, env, requirement));
  const priority = configured.length ? Math.min(...configured.map(({ grant }) => grantPriority(grant))) : null;
  return configured.filter(({ grant }) => grantPriority(grant) === priority);
}

// Only grants that this operation could use bound the retry time. Selection
// re-runs on retry, so this is a hint, never a reservation of that grant.
export function poolRetryAt(candidates: GrantCandidates, env: Env, requirement?: GrantRequirement): string | undefined {
  const times = (candidates.recovering ?? []).filter(({ entry }) => operationConfigured(entry.grant, env, requirement)).map(({ atMs }) => atMs);
  return times.length ? new Date(Math.min(...times)).toISOString() : undefined;
}

function operationConfigured(grant: UpstreamGrant, env: Env, requirement?: GrantRequirement): boolean {
  if (!requirement) return true;
  try { assertOperationConfiguration(requirement, grant, env); return true; }
  catch (error) { if (error instanceof HttpError) return false; throw error; }
}

export function filterGrantCandidates(providerId: string, candidates: Array<{ key: string; grant: UpstreamGrant | null; runtimeState: GrantRuntimeState | null }>, excludedKeys: ReadonlySet<string>, routing: GrantRoutingPolicy, pinnedKey: string | null | undefined, requirement: GrantRequirement | undefined, nowMs: number): GrantCandidates {
  const configured = candidates.filter((entry): entry is SelectedGrant => !!entry.grant && entry.grant.enabled !== false && (!entry.grant.provider || entry.grant.provider === providerId) && grantUsable(entry.grant));
  const eligibilityRestricted = Object.prototype.hasOwnProperty.call(routing.eligibleGrants, providerId);
  const eligibleRefs = routing.eligibleGrants[providerId] ?? [];
  const recovering: Array<{ entry: SelectedGrant; atMs: number }> = [];
  const available = configured.filter((entry) => {
    if (requirement && !grantSupports(requirement, entry.grant)) return false;
    if (pinnedKey !== undefined && entry.key !== pinnedKey) return false;
    if (excludedKeys.has(entry.key)) return false;
    const scope = parseGrantScope(entry.key);
    if (eligibilityRestricted && (!scope || !eligibleRefs.includes(scope.tokenRef))) return false;
    // Stale-deny needs a fresh observation, not elapsed time, to readmit a grant.
    if (routing.staleState === "deny" && !grantRuntimeFresh(entry.runtimeState, routing.staleAfterSeconds * 1_000, nowMs, requirement?.model)) return false;
    const subscription = entry.grant.kind === "subscription", reserve = subscription ? routing.includedQuotaReservePercent : 0;
    const cooling = grantCoolingDown(entry.runtimeState, nowMs);
    const exhausted = grantQuotaExhausted(entry.runtimeState, requirement?.model, reserve, subscription, nowMs);
    if (!cooling && !exhausted) return true;
    // Only time-limited exclusions remain. Record when the last one lifts;
    // an exhausted window without a published reset has no known recovery.
    // A failed credential (401/403) is not repaired by waiting out its cooldown.
    if (cooling && entry.runtimeState!.lastSignal === "authentication") return false;
    const resetAt = exhausted ? grantQuotaResetAt(entry.runtimeState, requirement?.model, reserve, subscription, nowMs) : 0;
    const atMs = resetAt == null ? null : Math.max(resetAt, cooling ? Date.parse(entry.runtimeState!.cooldownUntil!) : 0);
    if (atMs != null && (routing.staleState !== "deny" || grantRuntimeFresh(entry.runtimeState, routing.staleAfterSeconds * 1_000, atMs, requirement?.model))) recovering.push({ entry, atMs });
    return false;
  });
  // Transport filtering must not reopen environment auth for a configured pool.
  return { available, recovering, hasConfiguredGrant: configured.length > 0 || eligibilityRestricted || routing.staleState === "deny" || typeof pinnedKey === "string" };
}

function finitePercent(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100 ? value : fallback;
}

export function currentGrantRuntime(grant: UpstreamGrant, state: GrantRuntimeState | null | undefined): GrantRuntimeState | null {
  if (!state) return null;
  return state.grantRevision === grantRevision(grant) ? state : null;
}

export function grantRevision(grant: UpstreamGrant): string | null { return grant.updatedAt ?? grant.createdAt ?? null; }

export function grantPriority(grant: UpstreamGrant): number {
  return Number.isInteger(grant.priority) && grant.priority! >= 0 && grant.priority! <= 1_000_000 ? grant.priority! : DEFAULT_GRANT_PRIORITY;
}

export function grantWeight(grant: UpstreamGrant): number {
  return typeof grant.weight === "number" && Number.isFinite(grant.weight) && grant.weight > 0 && grant.weight <= 1_000_000 ? grant.weight : DEFAULT_GRANT_WEIGHT;
}

export function validGrantSegment(value: string): boolean {
  return value.length > 0 && value.length <= 256 && !value.includes("/") && !/[\u0000-\u001f\u007f]/.test(value);
}

function parseGrantScope(key: string): { scope: "policies" | "tenants"; scopeId: string; tokenRef: string } | null {
  const parts = key.split("/");
  if (parts[0] !== "oauth") return null;
  if (parts[1] === "tenants" && parts.length === 4 && validGrantSegment(parts[2]) && validGrantSegment(parts[3])) return { scope: "tenants", scopeId: parts[2], tokenRef: parts[3] };
  if (parts.length === 3 && validGrantSegment(parts[1]) && validGrantSegment(parts[2])) return { scope: "policies", scopeId: parts[1], tokenRef: parts[2] };
  return null;
}
