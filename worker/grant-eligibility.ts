import { vertexSigningCredentialPresent } from "./vertex-anthropic-binding.ts";
import { validGrantSegment } from "./grant-routing.ts";
export { DEFAULT_GRANT_ROUTING, grantRoutingPolicy, validGrantSegment } from "./grant-routing.ts";
import { HttpError } from "./utils.ts";
import { assertOperationConfiguration, grantSupports, type GrantRequirement } from "./provider-auth.ts";
import { grantCoolingDown, grantQuotaExhausted, grantQuotaResetAt, grantRuntimeFresh } from "./grant-quota.ts";
import type { Env, GrantRoutingPolicy, GrantRuntimeState, UpstreamGrant } from "./types";

export const REFRESH_MARGIN_MS = 5 * 60_000;
const DEFAULT_GRANT_PRIORITY = 100;
const DEFAULT_GRANT_WEIGHT = 1;
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

export function grantUsable(grant: UpstreamGrant, nowMs = Date.now()): boolean {
  return grantCredentialPresent(grant) && !grantRefreshBlocked(grant, nowMs);
}

function grantRefreshBlocked(grant: UpstreamGrant, nowMs: number): boolean {
  const until = grant.credentialRefreshBlockedUntil;
  return grant.credentialStore === "durable_object" && (until === null
    || !!grant.hasRefreshToken && !!grant.expiresAt && Date.parse(grant.expiresAt) <= nowMs + REFRESH_MARGIN_MS
    && typeof until === "string" && Date.parse(until) > nowMs);
}

export function grantCredentialPresent(grant: UpstreamGrant): boolean {
  if (grant.credentialStore === "durable_object") {
    return grant.credentialStatus !== "reauth_required" && !!(grant.hasCredential || grant.hasAccessToken || vertexSigningCredentialPresent(grant));
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

// Candidate metadata only. The private owner must still prove its original
// device/account binding; this does not make generic materialization usable.
export function copilotPrivateCandidate(grant: UpstreamGrant): boolean {
  return grant.provider === "github-copilot" && grant.enabled === true && grant.kind === "oauth"
    && grant.credentialStore === "durable_object" && grant.credentialStatus === "reauth_required"
    && Number.isSafeInteger(grant.credentialGeneration) && grant.credentialGeneration! > 0
    && typeof grant.credentialLineage === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(grant.credentialLineage)
    && !grant.credential && !grant.credentials && !grant.accessToken && !grant.refreshToken
    && !grant.hasCredential && !grant.hasAccessToken && !grant.hasRefreshToken;
}

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

export function filterGrantCandidates(providerId: string, candidates: Array<{ key: string; grant: UpstreamGrant | null; runtimeState: GrantRuntimeState | null }>, excludedKeys: ReadonlySet<string>, routing: GrantRoutingPolicy, pinnedKey: string | null | undefined, requirement: GrantRequirement | undefined, nowMs: number, privateCopilot = false): GrantCandidates {
  const configured = candidates.filter((entry): entry is SelectedGrant => !!entry.grant && entry.grant.enabled !== false && (!entry.grant.provider || entry.grant.provider === providerId)
    && (privateCopilot ? providerId === "github-copilot" && copilotPrivateCandidate(entry.grant) : grantCredentialPresent(entry.grant)));
  const eligibilityRestricted = Object.prototype.hasOwnProperty.call(routing.eligibleGrants, providerId);
  const eligibleRefs = routing.eligibleGrants[providerId] ?? [];
  const recovering: Array<{ entry: SelectedGrant; atMs: number }> = [];
  const available = configured.filter((entry) => {
    // Keep configured-pool presence (and pinned owner error semantics) even
    // when refresh cannot currently produce a dispatchable access token.
    if (!privateCopilot && pinnedKey === undefined && grantRefreshBlocked(entry.grant, nowMs)) return false;
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
  return { available, recovering, hasConfiguredGrant: configured.length > 0 || !!routing.sharedGrants?.[providerId]?.length || eligibilityRestricted || routing.staleState === "deny" || typeof pinnedKey === "string" };
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

function parseGrantScope(key: string): { scope: "policies" | "tenants"; scopeId: string; tokenRef: string } | null {
  const parts = key.split("/");
  if (parts[0] !== "oauth") return null;
  if (parts[1] === "tenants" && parts.length === 4 && validGrantSegment(parts[2]) && validGrantSegment(parts[3])) return { scope: "tenants", scopeId: parts[2], tokenRef: parts[3] };
  if (parts.length === 3 && validGrantSegment(parts[1]) && validGrantSegment(parts[2])) return { scope: "policies", scopeId: parts[1], tokenRef: parts[2] };
  return null;
}
