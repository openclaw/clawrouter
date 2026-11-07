import { policyRequestCost } from "../shared/request-pricing.ts";
import { musicCoverAccounting, musicCoverCompositionAccounting, planBudgetReservation, validateBudgetReservation, type EstimatedCost } from "./accounting.ts";
import { resolveConnection } from "./authority.ts";
import type { ContinuationOwner } from "./continuation-store.ts";
import { inspectGrantCredentials, materializeGrantCredentials } from "./grant-credentials.ts";
import { filterGrantCandidates, grantRoutingPolicy } from "./grant-eligibility.ts";
import { runMiniMaxMusicCoverControls, runMiniMaxMusicCoverComposition, musicCoverUnavailable, type MiniMaxMusicCoverControl, type MusicCoverFinalRead } from "./minimax-music-cover-control.ts";
import { isMiniMaxMusicCoverWave, type SealedMusicCoverInput, type MusicCoverInputMetadata } from "./minimax-music-cover-input.ts";
import { prepareMiniMaxMusicCoverCompositionUpload } from "./minimax-music-cover-upload.ts";
import { miniMaxApiKeySecret, miniMaxMusicCoverIdentity, miniMaxMusicCoverProjection } from "./native-media-credential.ts";
import { searchJsonBytes } from "./minimax-search-operation.ts";
import { authenticateProxyKey, proxyAdmission, proxyKeyVerification } from "./proxy-auth.ts";
import { assertControlCallerLive, authorizeResponseControl, publicControlAuthorization } from "./response-control-authorization.ts";
import { musicCoverSoftBudget, softBudgetPolicy } from "./soft-budget.ts";
import type { AccessPolicy, AuthorizedIdentity, Env, ProviderConnection, UpstreamGrant, UsageEvent } from "./types.ts";
import { HttpError, randomId } from "./utils.ts";

const capability = "music.generate", model = "minimax/music-cover";
const selection = Object.freeze({ providerId: "minimax", endpointId: "music-cover", mode: "http" as const,
  model: "music-cover", catalogModelId: model, capability });
export interface InactiveMusicCoverPreparation { readonly kind: "minimax-cover-preparation.inactive.v1" }
const preparations = new WeakMap<InactiveMusicCoverPreparation, Readonly<{ requestId: string; input: MusicCoverInputMetadata;
  grantKey: string; ownerIdentity: string; callerId: string; route: string; coverage: string }>>();
export function isInactiveMusicCoverPreparation(value: unknown): value is InactiveMusicCoverPreparation {
  return typeof value === "object" && value !== null && preparations.has(value as InactiveMusicCoverPreparation);
}

function cost(policy: AccessPolicy): EstimatedCost {
  const fixed = policyRequestCost(policy, capability);
  if (fixed !== null && (!Number.isSafeInteger(fixed) || fixed < 0)) musicCoverUnavailable();
  return { reserveMicros: fixed ?? 0, basis: fixed === null ? "unpriced_request" : "policy_fixed", inputTokens: null,
    outputTokens: null, ...(fixed === null ? { pricingGap: "opaque_input_bound" as const } : {}) };
}
function coverage(policy: AccessPolicy, connection: ProviderConnection): string {
  const value = [policy.generation, policy.budgetMode ?? "reserve", policy.budgetScope ?? null,
    policy.monthlyBudgetMicros ?? null, policy.dailyBudgetMicros ?? null, policy.weeklyBudgetMicros ?? null,
    connection.monthlyBudgetMicros ?? null, policyRequestCost(policy, capability)];
  searchJsonBytes(value); return JSON.stringify(value);
}
function allowed(policy: AccessPolicy, connection: ProviderConnection): void {
  if (!policy.enabled || !connection.enabled || connection.providerId !== "minimax"
    || policy.providers.length && !policy.providers.includes("minimax")
    || policy.models != null && !policy.models.includes(model)) musicCoverUnavailable(403);
  if (!softBudgetPolicy(policy) || [policy.monthlyBudgetMicros, policy.dailyBudgetMicros, policy.weeklyBudgetMicros, connection.monthlyBudgetMicros].includes(0))
    validateBudgetReservation(capability, cost(policy), policy.monthlyBudgetMicros,
    connection, policy.dailyBudgetMicros, policy.limitHint, policy.weeklyBudgetMicros);
}

interface CoverRefresh { current: UpstreamGrant; connection: ProviderConnection; coverage: string }
function refresh(env: Env, auth: AuthorizedIdentity, key: string, original: UpstreamGrant,
  control: MiniMaxMusicCoverControl, expectedCoverage?: string): Promise<CoverRefresh>;
function refresh<T>(env: Env, auth: AuthorizedIdentity, key: string, original: UpstreamGrant,
  control: MiniMaxMusicCoverControl, expectedCoverage: string, handoff: (current: CoverRefresh, read: MusicCoverFinalRead) => T): Promise<Awaited<T>>;
// Preparation returns only an observation. Composition moves this SAME tail
// to the actual synchronous POST handoff, after all other preparation/waits.
async function refresh(env: Env, auth: AuthorizedIdentity, key: string, original: UpstreamGrant,
  control: MiniMaxMusicCoverControl, expectedCoverage?: string,
  handoff?: (current: CoverRefresh, read: MusicCoverFinalRead) => unknown): Promise<unknown> {
  const caller = publicControlAuthorization(auth), signal = control.operation.signal;
  const owner: ContinuationOwner = { providerId: "minimax", endpointId: "music-cover", grantKey: key,
    lineage: original.credentialLineage!, routeSha256: "minimax.music:global:music-cover:inline-audio.v1",
    policyGeneration: auth.policy.generation };
  const connection = await resolveConnection(env, "minimax", undefined, undefined, undefined, control);
  const policy = await authorizeResponseControl(env, caller, owner, signal, undefined, undefined, undefined, undefined, false, control);
  if (!connection || !policy) musicCoverUnavailable();
  allowed(policy, connection);
  const currentCoverage = coverage(policy, connection);
  if (expectedCoverage !== undefined && currentCoverage !== expectedCoverage) musicCoverUnavailable(409);
  const identity = miniMaxMusicCoverIdentity(original);
  // All policy, price, connection, slot and preparation waits precede this read.
  const read = handoff ? control.markFinalOwnerRead() : undefined;
  const current = await inspectGrantCredentials(env, key, signal, undefined, undefined, undefined, control);
  signal.throwIfAborted(); assertControlCallerLive(caller);
  if (Date.now() >= control.phase.deadlineAt || miniMaxMusicCoverIdentity(current) !== identity
    || !filterGrantCandidates("minimax", [{ key, grant: current, runtimeState: null }], new Set(),
      grantRoutingPolicy(policy.grantRouting), key, undefined, Date.now()).available.length) musicCoverUnavailable(403);
  auth.policy = policy;
  const result = { current, connection, coverage: currentCoverage };
  return handoff ? handoff(result, read!) : result;
}

function preparationEvent(auth: AuthorizedIdentity, key: string, requestId: string, reserveMicros: number): UsageEvent {
  const event: UsageEvent = { id: randomId("usage"), type: "clawrouter.usage.v1", occurred_at_ms: Date.now(),
    tenant_id: auth.policy.tenantId ?? "default", policy_id: auth.policyId, credential_id: auth.credentialId,
    grant_key: key, grant_lane: "api_key", principal_id: auth.principalId, auth_type: auth.authType,
    session_id: null, agent_id: null, parent_agent_id: null, project_id: null, client: null, key_id: auth.policyId,
    request_id: requestId, trace_id: null, span_id: null, compound_request_id: null, compound_request_stage: null,
    compound_request_index: null, compound_request_size: null, compound_request_started_at_ms: null,
    provider: "minimax", capability, model, input_tokens: null, output_tokens: null, total_tokens: null,
    cached_input_tokens: null, cache_write_input_tokens: null, reserved_cost_micros: reserveMicros, actual_cost_micros: 0,
    reserved_input_tokens: null, reserved_output_tokens: null, pricing_ref: null, pricing_effective_at: null,
    cost_basis: "not_dispatched", status_code: null, duration_ms: null, content_retained: false, content_ref: null,
    reporting_known_cost_micros: null, reporting_estimated_cost_micros: null, status: "denied" };
  searchJsonBytes(event); return event;
}

// Private test/integration seam only: no production route calls this function.
// The sealed input synchronously supplies the provisional owner BEFORE even
// key hashing or SQL admission; only the verifier's WeakMap identity can proceed.
export function prepareInactiveMiniMaxMusicCover(env: Env, headers: Headers, input: SealedMusicCoverInput) {
  return runMiniMaxMusicCoverControls(input, async control => {
    const auth = await authenticateProxyKey(headers, env, [{ id: "minimax", tokenRef: "minimax" }], false,
      undefined, selection, "authoritative", undefined, undefined, control);
    if (auth instanceof Response) { await auth.body?.cancel(); throw new HttpError(auth.status, "invalid_proxy_key", "Cover caller is unavailable"); }
    if (!proxyKeyVerification(auth)) musicCoverUnavailable(403);
    const selected = proxyAdmission(auth)?.selection?.selected;
    if (!selected || !miniMaxMusicCoverProjection(selected.grant)) musicCoverUnavailable(403);
    const first = await refresh(env, auth, selected.key, selected.grant, control);
    const soft = softBudgetPolicy(auth.policy); control.setBudgetMode(soft);
    const estimate = cost(auth.policy), plan = planBudgetReservation(auth, capability, estimate, first.connection, Date.now(), soft);
    // Freeze every attempt ID and event BEFORE secret materialization or ledger I/O.
    const requestId = randomId("cover"), event = preparationEvent(auth, selected.key, requestId, soft ? 0 : plan.reservedMicros);
    const accounting = musicCoverAccounting(env, control, plan, event);
    let primary: unknown, result: InactiveMusicCoverPreparation | undefined;
    try {
      const materialized = await materializeGrantCredentials(env, selected.key, first.current, "minimax", null, false,
        control.operation.signal, "minimax.music", undefined, undefined, undefined, control);
      if (!miniMaxApiKeySecret(materialized) || miniMaxMusicCoverIdentity(materialized) !== miniMaxMusicCoverIdentity(first.current)) musicCoverUnavailable();
      if (soft) await musicCoverSoftBudget(env, plan, first.connection, control);
      else { await accounting.reserve(); await accounting.dispatchAdmission(); }
      const last = await refresh(env, auth, selected.key, first.current, control, first.coverage);
      // No fetch constructor, URL, bearer header, raw bytes or reusable permit.
      result = Object.freeze({ kind: "minimax-cover-preparation.inactive.v1" });
      preparations.set(result, Object.freeze({ requestId, input: control.phase.metadata,
        grantKey: selected.key, ownerIdentity: miniMaxMusicCoverIdentity(last.current), callerId: auth.credentialId!,
        route: control.phase.route, coverage: last.coverage }));
    } catch (error) { primary = error; }
    try { await accounting.finish(); }
    catch { if (!primary) primary = new HttpError(503, "accounting_unavailable", "Cover preparation finalization is unavailable"); }
    if (primary) throw primary;
    return result!;
  });
}

// Private authorized composition, deliberately absent from public factories,
// discovery and routes. Opaque-only input and completed preparation cannot enter.
export function composePrivateMiniMaxMusicCover(env: Env, headers: Headers, input: SealedMusicCoverInput) {
  if (!isMiniMaxMusicCoverWave(input)) musicCoverUnavailable(403);
  return runMiniMaxMusicCoverComposition(input, async (control, installFinalizer) => {
    const auth = await authenticateProxyKey(headers, env, [{ id: "minimax", tokenRef: "minimax" }], false,
      undefined, selection, "authoritative", undefined, undefined, control);
    if (auth instanceof Response) { await auth.body?.cancel(); throw new HttpError(auth.status, "invalid_proxy_key", "Cover caller is unavailable"); }
    if (!proxyKeyVerification(auth)) musicCoverUnavailable(403);
    const selected = proxyAdmission(auth)?.selection?.selected;
    if (!selected || !miniMaxMusicCoverProjection(selected.grant)) musicCoverUnavailable(403);
    const first = await refresh(env, auth, selected.key, selected.grant, control);
    const soft = softBudgetPolicy(auth.policy); control.setBudgetMode(soft);
    const estimate = cost(auth.policy), plan = planBudgetReservation(auth, capability, estimate, first.connection, Date.now(), soft);
    const event = preparationEvent(auth, selected.key, randomId("cover"), soft ? 0 : plan.reservedMicros);
    const accounting = musicCoverCompositionAccounting(env, control, plan, event, soft, policyRequestCost(auth.policy, capability));
    installFinalizer(accounting.finish); // Sole owner, including partial reserve.
    const materialized = await materializeGrantCredentials(env, selected.key, first.current, "minimax", null, false,
      control.operation.signal, "minimax.music", undefined, undefined, undefined, control);
    const secret = miniMaxApiKeySecret(materialized), identity = miniMaxMusicCoverIdentity(first.current);
    if (!secret || miniMaxMusicCoverIdentity(materialized) !== identity) musicCoverUnavailable();
    if (soft) await musicCoverSoftBudget(env, plan, first.connection, control);
    else { await accounting.reserve(); await accounting.dispatchAdmission(); }
    const capsule = prepareMiniMaxMusicCoverCompositionUpload(control, "Bearer " + secret);
    // The callback invokes fetch before refresh returns: no await, header work,
    // serializer preparation or queued predecessor follows the owner read.
    const response = await refresh(env, auth, selected.key, first.current, control, first.coverage, (last, read) =>
      control.tryPostHandoff<Response>(capsule, read, () => {
        if (!isMiniMaxMusicCoverWave(control.phase) || miniMaxMusicCoverIdentity(last.current) !== identity
          || last.coverage !== first.coverage) musicCoverUnavailable(403);
      }, accounting.invoked));
    accounting.succeeded();
    return response;
  });
}
