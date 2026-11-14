import { inspectGrantCredentials } from "./grant-credentials.ts";
import { filterGrantCandidates, grantRoutingPolicy } from "./grant-selection.ts";
import { assertPolicyModel } from "./policy-models.ts";
import { applyProviderCredential } from "./provider-auth.ts";
import type { ProxySelection } from "./proxy-selection.ts";
import type { UpstreamAuth } from "./providers.ts";
import { assertControlCallerLive, authorizeResponseControl, publicControlAuthorization } from "./response-control-authorization.ts";
import type { AccessPolicy, AuthorizedIdentity, Env, UpstreamGrant } from "./types.ts";
import { envValue, HttpError, safeEqual, sha256Hex } from "./utils.ts";

// accountId is projected from the original credential owner, not caller or
// routing metadata. Absence deliberately leaves an ordinary Bearer request.
export async function prepareGmiOrganizationBinding(request: Request, env: Env, auth: AuthorizedIdentity,
  selection: ProxySelection, upstream: UpstreamAuth, url: URL, headers: Headers): Promise<(signal: AbortSignal) => Promise<AccessPolicy>> {
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
  applyProviderCredential(provider, grant, env, selectedHeaders, new URLSearchParams());
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
