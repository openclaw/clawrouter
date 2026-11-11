import { privateVeniceRouteJson } from "./json-body.ts";
import { inspectGrantCredentials } from "./grant-credentials.ts";
import { filterGrantCandidates, grantRoutingPolicy } from "./grant-selection.ts";
import { assertPolicyModel } from "./policy-models.ts";
import { applyProviderCredential } from "./provider-auth.ts";
import type { ProxySelection } from "./proxy-selection.ts";
import type { UpstreamAuth } from "./providers.ts";
import { assertControlCallerLive, authorizeResponseControl, publicControlAuthorization, bindOwnedResponseControl, revalidateOwnedResponseControl, type ResponseControlAuthorization } from "./response-control-authorization.ts";
import { ownedHttpRevalidationFingerprint, applyOwnedHttpRevalidationCredential, checkOwnedHttpRevalidation, matchesOwnedHttpRevalidationGraph, admitOwnedHttpRevalidationRouting, fundOwnedHttpRevalidationEnvironment, type OwnedHttpRevalidation } from "./http-identity-owner.ts";
import { privateGrantRoutingPolicy } from "./grant-routing.ts";
import { identityPlan, identityFailure } from "./identity-admission.ts";
import type { AccessPolicy, GrantRoutingPolicy, AuthorizedIdentity, Env, UpstreamGrant } from "./types.ts";
import { envValue, HttpError, safeEqual, sha256Hex } from "./utils.ts";

// This is a fresh check of an already selected credential, never a new pool
// selection, refresh or environment fallback. Delivery repeats the same check.
type VeniceChatAuthority = { revalidate(signal: AbortSignal): Promise<void>; assertLive(): void };
export function prepareVeniceChatAuthority(env: Env, auth: AuthorizedIdentity, selection: ProxySelection,
  upstream: UpstreamAuth, url: URL, headers: Headers): Promise<VeniceChatAuthority> {
  return prepareVeniceAuthority(env, auth, selection, upstream, url, headers);
}
export function prepareOwnedVeniceChatAuthority(cap: OwnedHttpRevalidation, env: Env, auth: AuthorizedIdentity, selection: ProxySelection,
  upstream: UpstreamAuth, url: URL, headers: Headers): Promise<VeniceChatAuthority> {
  return prepareVeniceAuthority(env, auth, selection, upstream, url, headers, cap);
}
async function prepareVeniceAuthority(env: Env, auth: AuthorizedIdentity, selection: ProxySelection,
  upstream: UpstreamAuth, url: URL, headers: Headers, owned?: OwnedHttpRevalidation): Promise<VeniceChatAuthority> {
  if (owned !== undefined) checkOwnedHttpRevalidation(owned, env, auth, selection, upstream, url, headers);
  const { grant, grantKey } = upstream;
  const selectedHeaders = new Headers();
  if (owned !== undefined) applyOwnedHttpRevalidationCredential(owned, selectedHeaders, new URLSearchParams());
  else applyProviderCredential(selection.provider, grant, env, selectedHeaders, new URLSearchParams());
  const authorization = selectedHeaders.get("authorization");
  if (selection.provider.id !== "venice" || !selection.model || upstream.transport !== null
    || upstream.baseUrl !== "https://api.venice.ai/api/v1" || url.href !== "https://api.venice.ai/api/v1/chat/completions"
    || !authorization || upstream.headers.get("authorization") !== authorization
    || headers.get("authorization") !== authorization || upstream.query.size) unavailable();
  const original = grantKey && qualified(grant) ? owned !== undefined ? ownedHttpRevalidationFingerprint(owned, grant) : identity(grant) : null;
  const environment = !grantKey && !grant ? envValue(env, "VENICE_API_KEY") : null;
  if (grantKey ? !original
    : !environment || authorization !== `Bearer ${environment}`) unavailable();
  const caller = publicControlAuthorization(auth);
  const owner = { providerId: "venice", endpointId: selection.endpoint.id, grantKey,
    lineage: grant?.credentialLineage ?? null, policyGeneration: auth.policy.generation,
    routeSha256: await sha256Hex(owned !== undefined ? privateVeniceRouteJson(url.href, selection.endpoint.id, selection.model.upstream)
      : JSON.stringify([url.href, selection.endpoint.id, selection.model.upstream])) };
  if (owned !== undefined) {
    bindOwnedResponseControl(owned, env, caller, owner);
    (ownedVenice ??= new WeakMap()).set(owned, { env, selection, grant, grantKey, original, environment, caller });
    ownedVeniceCount++;
    return { assertLive: assertOwnedVeniceChatLive.bind(undefined, owned), revalidate: revalidateOwnedResponseControl.bind(undefined, owned) };
  }
  const assertLive = () => {
    assertControlCallerLive(caller);
    if (grant && (!qualified(grant) || identity(grant) !== original)
      || environment && !safeEqual(envValue(env, "VENICE_API_KEY") ?? "", environment)) unavailable();
  };
  return { assertLive, async revalidate(signal) {
    const policy = await authorizeResponseControl(env, caller, owner, signal);
    if (!policy) unavailable();
    assertPolicyModel(policy, selection);
    const routing = grantRoutingPolicy(policy.grantRouting);
    if (grantKey) {
      const current = await inspectGrantCredentials(env, grantKey, signal);
      if (!qualified(current) || identity(current) !== original
        || !filterGrantCandidates("venice", [{ key: grantKey, grant: current, runtimeState: null }], new Set(), routing,
          grantKey, undefined, Date.now()).available.length) unavailable();
    } else {
      // An explicit grant allowlist cannot silently become environment authority.
      if (Object.hasOwn(routing.eligibleGrants, "venice") && !routing.environmentFallback
        || !safeEqual(envValue(env, "VENICE_API_KEY") ?? "", environment!)) unavailable();
    }
    signal.throwIfAborted(); assertLive();
  } };
}

interface OwnedVenice {
  env: Env; selection: ProxySelection; grant: UpstreamGrant | null; grantKey: string | null;
  original: string | null; environment: string | null; caller: ResponseControlAuthorization;
  policy?: AccessPolicy; routing?: GrantRoutingPolicy; inspected?: true;
}
let ownedVenice: WeakMap<OwnedHttpRevalidation, OwnedVenice> | undefined;
let ownedVeniceCount = 0;
export function acceptOwnedVenicePolicy(cap: OwnedHttpRevalidation, policy: AccessPolicy): void {
  const state = ownedVenice?.get(cap);
  if (!state || !matchesOwnedHttpRevalidationGraph(cap, policy, "policy")) throw identityFailure("protocol");
  assertPolicyModel(policy, state.selection);
  state.policy = policy;
  state.routing = privateGrantRoutingPolicy(policy.grantRouting, emit => {
    const plan = identityPlan(); emit(plan, 0); admitOwnedHttpRevalidationRouting(cap, plan.counts);
  });
}
export function acceptOwnedVeniceInspection(cap: OwnedHttpRevalidation, value: unknown): void {
  const state = ownedVenice?.get(cap);
  if (!state?.policy || !state.routing || !state.grantKey || !matchesOwnedHttpRevalidationGraph(cap, value, "inspect")) throw identityFailure("protocol");
  const current = (value as { grant: UpstreamGrant | null }).grant;
  if (!qualified(current) || ownedHttpRevalidationFingerprint(cap, current) !== state.original
    || !filterGrantCandidates("venice", [{ key: state.grantKey, grant: current, runtimeState: null }], new Set(),
      state.routing, state.grantKey, undefined, Date.now()).available.length) unavailable();
  state.inspected = true;
}
export function finishOwnedVeniceRevalidation(cap: OwnedHttpRevalidation): void {
  const state = ownedVenice?.get(cap);
  if (!state?.policy || !state.routing) throw identityFailure("protocol");
  fundOwnedHttpRevalidationEnvironment(cap);
  if (state.grantKey) { if (!state.inspected) throw identityFailure("protocol"); }
  else if (Object.hasOwn(state.routing.eligibleGrants, "venice") && !state.routing.environmentFallback
    || !safeEqual(envValue(state.env, "VENICE_API_KEY") ?? "", state.environment!)) unavailable();
  assertControlCallerLive(state.caller);
  if (state.grant && (!qualified(state.grant) || ownedHttpRevalidationFingerprint(cap, state.grant) !== state.original)
    || state.environment && !safeEqual(envValue(state.env, "VENICE_API_KEY") ?? "", state.environment)) unavailable();
}
export function clearOwnedVeniceRevalidation(cap: OwnedHttpRevalidation): void {
  const state = ownedVenice?.get(cap);
  if (state) { state.policy = undefined; state.routing = undefined; state.inspected = undefined; }
}
export function retireOwnedVeniceRevalidation(cap: OwnedHttpRevalidation): void {
  const state = ownedVenice?.get(cap); if (!state) return;
  clearOwnedVeniceRevalidation(cap);
  state.env = undefined as never; state.selection = undefined as never; state.grant = null; state.grantKey = null;
  state.original = null; state.environment = null; state.caller = undefined as never;
  ownedVenice!.delete(cap);
  if (!--ownedVeniceCount) ownedVenice = undefined;
}
export function revalidateOwnedVeniceChat(cap: OwnedHttpRevalidation, signal: AbortSignal): Promise<void> {
  if (!ownedVenice?.has(cap)) throw identityFailure("protocol");
  return revalidateOwnedResponseControl(cap, signal);
}
export function assertOwnedVeniceChatLive(cap: OwnedHttpRevalidation): void {
  const state = ownedVenice?.get(cap);
  if (!state) throw identityFailure("protocol");
  assertControlCallerLive(state.caller); fundOwnedHttpRevalidationEnvironment(cap);
  if (state.grant && (!qualified(state.grant) || ownedHttpRevalidationFingerprint(cap, state.grant) !== state.original)
    || state.environment && !safeEqual(envValue(state.env, "VENICE_API_KEY") ?? "", state.environment)) unavailable();
}

function qualified(grant: UpstreamGrant | null): grant is UpstreamGrant {
  return !!grant && grant.provider === "venice" && grant.kind === "api_key" && grant.credentialStore === "durable_object"
    && grant.enabled === true && !grant.revokedAt && grant.credentialStatus === "active"
    && Number.isSafeInteger(grant.credentialGeneration) && !!grant.credentialLineage
    && (!grant.expiresAt || Number.isFinite(Date.parse(grant.expiresAt)) && Date.parse(grant.expiresAt) > Date.now());
}
function identity(grant: UpstreamGrant): string {
  return JSON.stringify([grant.provider, grant.kind, grant.credentialGeneration, grant.credentialLineage, grant.accountId ?? null]);
}
function unavailable(): never { throw new HttpError(503, "venice_chat_owner_unavailable", "the original Venice Chat authorization is unavailable"); }
