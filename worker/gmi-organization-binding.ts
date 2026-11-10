import { inspectGrantCredentials } from "./grant-credentials.ts";
import { filterGrantCandidates, grantRoutingPolicy } from "./grant-selection.ts";
import { assertPolicyModel } from "./policy-models.ts";
import { applyProviderCredential } from "./provider-auth.ts";
import type { ProxySelection } from "./proxy-selection.ts";
import type { UpstreamAuth } from "./providers.ts";
import { assertControlCallerLive, authorizeResponseControl, publicControlAuthorization, bindOwnedResponseControl, revalidateOwnedResponseControl, type ResponseControlAuthorization } from "./response-control-authorization.ts";
import { applyOwnedHttpRevalidationCredential, checkOwnedHttpRevalidation, matchesOwnedHttpRevalidationGraph, admitOwnedHttpRevalidationRouting, fundOwnedHttpRevalidationEnvironment, type OwnedHttpRevalidation } from "./http-identity-owner.ts";
import { privateGrantRoutingPolicy } from "./grant-routing.ts";
import { identityPlan, identityFailure } from "./identity-admission.ts";
import type { AccessPolicy, GrantRoutingPolicy, AuthorizedIdentity, Env, UpstreamGrant } from "./types.ts";
import { envValue, HttpError, safeEqual, sha256Hex } from "./utils.ts";

// accountId is projected from the original credential owner, not caller or
// routing metadata. Absence deliberately leaves an ordinary Bearer request.
export function prepareGmiOrganizationBinding(request: Request, env: Env, auth: AuthorizedIdentity,
  selection: ProxySelection, upstream: UpstreamAuth, url: URL, headers: Headers): Promise<(signal: AbortSignal) => Promise<AccessPolicy>> {
  return prepareGmiBinding(request, env, auth, selection, upstream, url, headers);
}
export function prepareOwnedGmiOrganizationBinding(cap: OwnedHttpRevalidation, request: Request, env: Env, auth: AuthorizedIdentity,
  selection: ProxySelection, upstream: UpstreamAuth, url: URL, headers: Headers): Promise<(signal: AbortSignal) => Promise<void>> {
  return prepareGmiBinding(request, env, auth, selection, upstream, url, headers, cap);
}
function prepareGmiBinding(request: Request, env: Env, auth: AuthorizedIdentity,
  selection: ProxySelection, upstream: UpstreamAuth, url: URL, headers: Headers): Promise<(signal: AbortSignal) => Promise<AccessPolicy>>;
function prepareGmiBinding(request: Request, env: Env, auth: AuthorizedIdentity,
  selection: ProxySelection, upstream: UpstreamAuth, url: URL, headers: Headers, owned: OwnedHttpRevalidation): Promise<(signal: AbortSignal) => Promise<void>>;
async function prepareGmiBinding(request: Request, env: Env, auth: AuthorizedIdentity,
  selection: ProxySelection, upstream: UpstreamAuth, url: URL, headers: Headers, owned?: OwnedHttpRevalidation): Promise<(signal: AbortSignal) => Promise<AccessPolicy | void>> {
  if (owned !== undefined) checkOwnedHttpRevalidation(owned, env, auth, selection, upstream, url, headers, request);
  headers.delete("x-organization-id");
  const { provider, endpoint } = selection, { grant, grantKey } = upstream;
  const catalog = endpoint.request_format === "openai.models";
  const format = catalog ? "openai.models" : "openai.chat_completions";
  const path = catalog ? "/models" : "/chat/completions", method = catalog ? "GET" : "POST";
  const params = selection.pathParams, model = selection.model?.upstream;
  // Unified Chat supplies these two selectors internally; they do not change
  // GMI's literal path. Caller-supplied manifest/native parameters stay denied.
  const unifiedModelParams = !catalog && request.method === "POST" && new URL(request.url).pathname === "/v1/chat/completions"
    && Object.keys(params).length === 2 && Object.hasOwn(params, "model") && Object.hasOwn(params, "deployment")
    && typeof model === "string" && model.length > 0 && params.model === model && params.deployment === model
    && !Array.isArray(selection.body) && selection.body.model === model;
  if (provider.id !== "gmi" || provider.base_urls.default !== "https://api.gmi-serving.com/v1"
    || upstream.baseUrl !== provider.base_urls.default || url.href !== upstream.baseUrl + path
    || upstream.transport !== null || upstream.query.size || new URL(request.url).search
    || endpoint.request_format !== format || endpoint.response_format !== format
    || endpoint.path !== path || selection.method !== method || endpoint.method !== method
    || endpoint.auth != null || endpoint.upstreamPath !== undefined || endpoint.websocket || endpoint.lifecycle || endpoint.responsesLifecycle
    || endpoint.path_params.length || Object.keys(params).length && !unifiedModelParams || Object.keys(endpoint.query).length
    || selection.capability !== (catalog ? "models.list" : "llm.chat")) unavailable();
  const scheme = provider.auth.schemes.find(value => value.type !== "oauth");
  const selectedHeaders = new Headers();
  if (owned !== undefined) applyOwnedHttpRevalidationCredential(owned, selectedHeaders, new URLSearchParams());
  else applyProviderCredential(provider, grant, env, selectedHeaders, new URLSearchParams());
  const authorization = selectedHeaders.get("authorization");
  if (scheme?.type !== "bearer" || scheme.header.toLowerCase() !== "authorization" || scheme.format !== "Bearer ${secret}"
    || scheme.secretKind !== "api_key" || !authorization || upstream.headers.get("authorization") !== authorization
    || headers.get("authorization") !== authorization) unavailable();
  const original = grantKey && qualified(grant) ? identity(grant) : null;
  const environment = !grantKey && !grant ? envValue(env, "GMI_API_KEY") : null;
  if (grantKey ? !original
    : !environment || authorization !== `Bearer ${environment}`) unavailable();
  const organization = account(grant?.accountId);
  if (organization !== null) headers.set("x-organization-id", organization);
  const caller = publicControlAuthorization(auth);
  const owner = { providerId: "gmi", endpointId: endpoint.id, grantKey, lineage: grant?.credentialLineage ?? null,
    policyGeneration: auth.policy.generation, routeSha256: await sha256Hex(JSON.stringify([url.href, organization])) };
  if (owned !== undefined) {
    bindOwnedResponseControl(owned, env, caller, owner);
    (ownedGmi ??= new WeakMap()).set(owned, { env, selection, grant, grantKey, original, environment, organization, caller });
    ownedGmiCount++;
    return signal => revalidateOwnedResponseControl(owned, signal);
  }
  return async signal => {
    const policy = await authorizeResponseControl(env, caller, owner, signal);
    if (!policy) unavailable();
    assertPolicyModel(policy, selection);
    const routing = grantRoutingPolicy(policy.grantRouting);
    if (grantKey) {
      const current = await inspectGrantCredentials(env, grantKey, signal);
      if (!qualified(current) || identity(current) !== original || account(current.accountId) !== organization
        || !filterGrantCandidates("gmi", [{ key: grantKey, grant: current, runtimeState: null }], new Set(), routing,
          grantKey, undefined, Date.now()).available.length) unavailable();
    } else if (Object.hasOwn(routing.eligibleGrants, "gmi") && !routing.environmentFallback
      || !safeEqual(envValue(env, "GMI_API_KEY") ?? "", environment!)) unavailable();
    signal.throwIfAborted(); assertControlCallerLive(caller);
    if (grant && !qualified(grant)) unavailable();
    return policy;
  };
}

interface OwnedGmi {
  env: Env; selection: ProxySelection; grant: UpstreamGrant | null; grantKey: string | null;
  original: string | null; environment: string | null; organization: string | null; caller: ResponseControlAuthorization;
  policy?: AccessPolicy; routing?: GrantRoutingPolicy; inspected?: true;
}
let ownedGmi: WeakMap<OwnedHttpRevalidation, OwnedGmi> | undefined;
let ownedGmiCount = 0;
export function acceptOwnedGmiPolicy(cap: OwnedHttpRevalidation, policy: AccessPolicy): void {
  const state = ownedGmi?.get(cap);
  if (!state || !matchesOwnedHttpRevalidationGraph(cap, policy, "policy")) throw identityFailure("protocol");
  assertPolicyModel(policy, state.selection); state.policy = policy;
  state.routing = privateGrantRoutingPolicy(policy.grantRouting, emit => {
    const plan = identityPlan(); emit(plan, 0); admitOwnedHttpRevalidationRouting(cap, plan.counts);
  });
}
export function acceptOwnedGmiInspection(cap: OwnedHttpRevalidation, value: unknown): void {
  const state = ownedGmi?.get(cap);
  if (!state?.policy || !state.routing || !state.grantKey || !matchesOwnedHttpRevalidationGraph(cap, value, "inspect")) throw identityFailure("protocol");
  const current = (value as { grant: UpstreamGrant | null }).grant;
  if (!qualified(current) || identity(current) !== state.original || account(current.accountId) !== state.organization
    || !filterGrantCandidates("gmi", [{ key: state.grantKey, grant: current, runtimeState: null }], new Set(),
      state.routing, state.grantKey, undefined, Date.now()).available.length) unavailable();
  state.inspected = true;
}
export function finishOwnedGmiRevalidation(cap: OwnedHttpRevalidation): void {
  const state = ownedGmi?.get(cap);
  if (!state?.policy || !state.routing) throw identityFailure("protocol");
  fundOwnedHttpRevalidationEnvironment(cap);
  if (state.grantKey) { if (!state.inspected) throw identityFailure("protocol"); }
  else if (Object.hasOwn(state.routing.eligibleGrants, "gmi") && !state.routing.environmentFallback
    || !safeEqual(envValue(state.env, "GMI_API_KEY") ?? "", state.environment!)) unavailable();
  assertControlCallerLive(state.caller);
  if (state.grant && !qualified(state.grant)) unavailable();
}
export function clearOwnedGmiRevalidation(cap: OwnedHttpRevalidation): void {
  const state = ownedGmi?.get(cap);
  if (state) { state.policy = undefined; state.routing = undefined; state.inspected = undefined; }
}
export function retireOwnedGmiRevalidation(cap: OwnedHttpRevalidation): void {
  const state = ownedGmi?.get(cap); if (!state) return;
  clearOwnedGmiRevalidation(cap);
  state.env = undefined as never; state.selection = undefined as never; state.grant = null; state.grantKey = null;
  state.original = null; state.environment = null; state.organization = null; state.caller = undefined as never;
  ownedGmi!.delete(cap);
  if (!--ownedGmiCount) ownedGmi = undefined;
}

function account(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== "string" || !/^[\x21-\x7e]{1,512}$/.test(value) || value.includes(",")) unavailable();
  return value;
}
function qualified(grant: UpstreamGrant | null): grant is UpstreamGrant {
  return !!grant && grant.provider === "gmi" && grant.kind === "api_key" && grant.credentialStore === "durable_object"
    && grant.enabled === true && !grant.revokedAt && grant.credentialStatus === "active"
    && Number.isSafeInteger(grant.credentialGeneration) && !!grant.credentialLineage
    && (!grant.expiresAt || Number.isFinite(Date.parse(grant.expiresAt)) && Date.parse(grant.expiresAt) > Date.now());
}
function identity(grant: UpstreamGrant): string {
  return JSON.stringify([grant.provider, grant.kind, grant.credentialGeneration, grant.credentialLineage, grant.accountId ?? null]);
}
function unavailable(): never { throw new HttpError(503, "gmi_organization_owner_unavailable", "the original GMI credential, organization or destination is unavailable"); }
