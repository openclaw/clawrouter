import { grantQuotaExclusionReason, grantCoolingDown, grantQuotaExhausted, grantQuotaRatio, grantQuotaResetAt, grantRuntimeFresh } from "../shared/grant-quota.ts";
import { vertexSigningCredentialPresent } from "./vertex-anthropic-binding.ts";
import { rankingStaleAfterMs, validGrantSegment } from "./grant-routing.ts";
import { HttpError } from "./http-error.ts";
import { assertOperationConfiguration, grantSupports, type GrantRequirement } from "./provider-auth.ts";
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
  // Earliest possible recovery; retry rechecks all eligibility and freshness.
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

// reserveDrain: no grant is above the policy reserve, so `available` holds the
// grants only that reserve excludes. Choose among them with grantChoices.
// reserveBand: those grants while some are above the reserve, in case none of
// those can serve the operation (servingCandidates).
export interface GrantCandidates { available: SelectedGrant[]; hasConfiguredGrant: boolean; recovering?: Array<{ entry: SelectedGrant; atMs: number }>; reserveDrain?: true; reserveBand?: SelectedGrant[] }

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

export function filterGrantCandidates(providerId: string, candidates: Array<{ key: string; grant: UpstreamGrant | null; runtimeState: GrantRuntimeState | null }>, excludedKeys: ReadonlySet<string>, routing: GrantRoutingPolicy, pinnedKey: string | null | undefined, requirement: GrantRequirement | undefined, nowMs: number, privateCopilot = false, onExcluded?: (reason: string) => void): GrantCandidates {
  const configured = candidates.filter((entry): entry is SelectedGrant => !!entry.grant && entry.grant.enabled !== false && (!entry.grant.provider || entry.grant.provider === providerId)
    && (privateCopilot ? providerId === "github-copilot" && copilotPrivateCandidate(entry.grant) : grantCredentialPresent(entry.grant)));
  const eligibilityRestricted = Object.prototype.hasOwnProperty.call(routing.eligibleGrants, providerId);
  const eligibleRefs = routing.eligibleGrants[providerId] ?? [];
  const recovering: Array<{ entry: SelectedGrant; atMs: number }> = [];
  // An environment fallback, unless pinned to a grant, serves before a drain.
  const softFloor = !routing.environmentFallback || typeof pinnedKey === "string";
  let reserveBand: SelectedGrant[] | undefined;
  const available = configured.filter((entry) => {
    // Keep configured-pool presence (and pinned owner error semantics) even
    // when refresh cannot currently produce a dispatchable access token.
    if (!privateCopilot && pinnedKey === undefined && grantRefreshBlocked(entry.grant, nowMs)) { onExcluded?.("credential_refresh_blocked"); return false; }
    if (requirement && !grantSupports(requirement, entry.grant)) return false;
    if (pinnedKey !== undefined && entry.key !== pinnedKey) return false;
    if (excludedKeys.has(entry.key)) { onExcluded?.("already_attempted"); return false; }
    const scope = parseGrantScope(entry.key);
    if (eligibilityRestricted && (!scope || !eligibleRefs.includes(scope.tokenRef))) return false;
    // Stale-deny needs a fresh observation, not elapsed time, to readmit a grant.
    if (routing.staleState === "deny" && !grantRuntimeFresh(entry.runtimeState, routing.staleAfterSeconds * 1_000, nowMs, requirement?.model)) { onExcluded?.("quota_not_fresh"); return false; }
    const subscription = entry.grant.kind === "subscription", reserve = subscription ? routing.includedQuotaReservePercent : 0;
    const cooling = grantCoolingDown(entry.runtimeState, nowMs);
    const exhausted = grantQuotaExhausted(entry.runtimeState, requirement?.model, reserve, subscription, nowMs);
    if (!cooling && !exhausted) return true;
    // The reserve is a soft floor: a grant it alone excludes still has capacity.
    const drainable = exhausted && !!reserve && !grantQuotaExhausted(entry.runtimeState, requirement?.model, 0, subscription, nowMs);
    if (!cooling && drainable) (reserveBand ??= []).push(entry);
    else onExcluded?.(cooling ? entry.runtimeState!.lastSignal === "authentication" ? "authentication" : "cooldown" : grantQuotaExclusionReason(entry.runtimeState, requirement?.model, reserve, subscription, nowMs)!);
    // Only time-limited exclusions remain. Record when the last one lifts;
    // an exhausted window without a published reset has no known recovery.
    // A failed credential (401/403) is not repaired by waiting out its cooldown.
    if (cooling && entry.runtimeState!.lastSignal === "authentication") return false;
    // A cooling grant the soft floor can drain recovers when its cooldown ends.
    const resetAt = exhausted && !(cooling && drainable && softFloor) ? grantQuotaResetAt(entry.runtimeState, requirement?.model, reserve, subscription, nowMs) : 0;
    const atMs = resetAt == null ? null : Math.max(resetAt, cooling ? Date.parse(entry.runtimeState!.cooldownUntil!) : 0);
    if (atMs != null && (routing.staleState !== "deny" || grantRuntimeFresh(entry.runtimeState, routing.staleAfterSeconds * 1_000, atMs, requirement?.model))) recovering.push({ entry, atMs });
    return false;
  });
  // Transport filtering must not reopen environment auth for a configured pool.
  const hasConfiguredGrant = configured.length > 0 || !!routing.sharedGrants?.[providerId]?.length || eligibilityRestricted || routing.staleState === "deny" || typeof pinnedKey === "string";
  // Drain only where the pool would otherwise be unavailable: any grant above
  // the reserve, or a policy environment fallback, still comes first.
  const drain = reserveBand && !available.length && softFloor ? reserveBand : undefined;
  if (!drain) for (const entry of reserveBand ?? []) onExcluded?.(grantQuotaExclusionReason(entry.runtimeState, requirement?.model, routing.includedQuotaReservePercent, true, nowMs)!);
  // Drained grants keep their recovery: it bounds retry only if none is chosen.
  return drain ? { available: drain, recovering, hasConfiguredGrant, reserveDrain: true }
    : { available, recovering, hasConfiguredGrant, ...(reserveBand && softFloor ? { reserveBand } : {}) };
}

// The operation-qualified grants to choose from. A grant above the reserve that
// cannot serve this operation does not hold back the drain.
export function servingCandidates(filtered: GrantCandidates, qualify: (entries: SelectedGrant[]) => SelectedGrant[]): { active: SelectedGrant[]; reserveDrain: boolean } {
  const active = qualify(filtered.available);
  return active.length || !filtered.reserveBand ? { active, reserveDrain: !!filtered.reserveDrain } : { active: qualify(filtered.reserveBand), reserveDrain: true };
}

// Strategy input for the selected candidates. A reserve drain keeps only the
// grants within the policy hysteresis, scaled to the reserve band, of the most
// remaining, so the strategy spreads the drain instead of emptying one grant
// first (a threshold cursor stays until another grant has that much more left).
export function grantChoices(active: SelectedGrant[], routing: GrantRoutingPolicy, nowMs: number, model: string | null | undefined, reserveDrain?: boolean) {
  const choices = active.map(item => ({ key: item.key, weight: grantWeight(item.grant), remainingRatio: grantQuotaRatio(item.runtimeState, nowMs, choiceStaleAfterMs(routing, reserveDrain), model) }));
  if (!reserveDrain) return choices;
  const best = Math.max(-1, ...choices.map(choice => choice.remainingRatio ?? -1)), margin = reserveDrainMargin(routing);
  return choices.filter(choice => reserveDrainKeeps(choice.remainingRatio, best, margin));
}

// A drain ranks by the readings that admitted its grants. Under staleState
// "allow" an aged reading still admits, so it still ranks.
export function choiceStaleAfterMs(routing: Pick<GrantRoutingPolicy, "strategy" | "staleAfterSeconds">, reserveDrain?: boolean): number {
  return reserveDrain ? Number.MAX_SAFE_INTEGER : rankingStaleAfterMs(routing);
}

export function reserveDrainMargin(routing: Pick<GrantRoutingPolicy, "hysteresisPercent" | "includedQuotaReservePercent">): number {
  return routing.hysteresisPercent * (routing.includedQuotaReservePercent ?? 0) / 10_000;
}

// Unmeasured ranks below measured, as in the most-remaining strategy.
export function reserveDrainKeeps(ratio: number | null | undefined, best: number, margin: number): boolean {
  const value = ratio ?? -1;
  return value >= best || value + margin > best + 1e-9;
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
