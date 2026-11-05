import { fetchFeatherlessModelCatalog } from "./featherless-catalog-scan.ts";
import { filterGrantCandidates, grantRoutingPolicy } from "./grant-selection.ts";
import { inspectGrantCredentials } from "./grant-credentials.ts";
import type { HttpOperation } from "./http-operation.ts";
import { jsonBodyStream } from "./json-body.ts";
import { discoveryAllows } from "./model-discovery.ts";
import { nativeResponseLease } from "./native-response.ts";
import { applyProviderCredential } from "./provider-auth.ts";
import type { ProxySelection } from "./proxy-selection.ts";
import type { UpstreamAuth } from "./providers.ts";
import { authorizeResponseControl, assertControlCallerLive, publicControlAuthorization } from "./response-control-authorization.ts";
import type { AuthorizedIdentity, Env, UpstreamGrant } from "./types.ts";
import { HttpError, sha256Hex } from "./utils.ts";

// A complete keyed scan owns the existing pool until delivery finishes. It has
// no ingress body and cannot stack a second native response lease.
export function acquireFeatherlessCatalog() { return nativeResponseLease(48 * 1024 * 1024); }

export async function featherlessCatalogResponse(input: Awaited<ReturnType<typeof prepareFeatherlessCatalogOwner>>
  & Pick<Parameters<typeof fetchFeatherlessModelCatalog>[0], "registerInput" | "registerFetch">, operation: HttpOperation): Promise<Response> {
  const result = await fetchFeatherlessModelCatalog({ ...input, operation });
  operation.signal.throwIfAborted();
  // Streaming serialization retains the bounded result, not another whole JSON
  // string plus UTF-8 copy. The caller releases capacity only at delivery EOF.
  return new Response(jsonBodyStream(result), { headers: { "content-type": "application/json", "cache-control": "private, no-store" } });
}

export async function prepareFeatherlessCatalogOwner(request: Request, env: Env, auth: AuthorizedIdentity,
  selection: ProxySelection, upstream: UpstreamAuth) {
  const { provider, endpoint } = selection, grant = upstream.grant, key = upstream.grantKey;
  if (request.method !== "GET" || request.body !== null || new URL(request.url).search
    || provider.id !== "featherless" || endpoint.id !== "catalog" || endpoint.path !== "/models"
    || endpoint.request_format !== "featherless.catalog" || endpoint.response_format !== "featherless.catalog"
    || selection.capability !== "models.list" || selection.model !== null || selection.method !== "GET" || endpoint.method !== "GET"
    || endpoint.native_proxy || endpoint.path_params.length || Object.keys(selection.pathParams).length
    || endpoint.auth != null || endpoint.upstreamPath !== undefined || endpoint.streaming || endpoint.websocket || endpoint.lifecycle || endpoint.responsesLifecycle
    || endpoint.inputProfile !== undefined || endpoint.requestPricing !== undefined || endpoint.modelPassthrough
    || Object.keys(selection.body).length || Object.keys(endpoint.query).length || upstream.query.size || upstream.transport !== null
    || !["https://api.featherless.ai/v1", "https://api.featherless.ai/v1/"].includes(upstream.baseUrl)
    || !key || !qualified(grant)) unavailable();
  const headers = new Headers(), query = new URLSearchParams();
  applyProviderCredential(provider, grant, env, headers, query);
  const authorization = headers.get("authorization");
  if (query.size || !authorization || !/^Bearer [\x21-\x7e]{1,8192}$/.test(authorization)
    || upstream.headers.get("authorization") !== authorization) unavailable();
  const selectedApiKey = authorization.slice(7), identity = ownerIdentity(grant);
  const caller = publicControlAuthorization(auth);
  const owner = { providerId: provider.id, endpointId: endpoint.id, grantKey: key, lineage: grant.credentialLineage!,
    routeSha256: await sha256Hex(JSON.stringify([provider.id, endpoint.id, endpoint.request_format, upstream.baseUrl])),
    policyGeneration: auth.policy.generation };
  const permittedModelIds = new Set(provider.models.filter(model => discoveryAllows(auth.policy, provider, model.upstream)).map(model => model.upstream));
  let currentPolicy = auth.policy;
  const allows = (id: string) => permittedModelIds.has(id) && discoveryAllows(currentPolicy, provider, id);
  const revalidateAccount = async (signal: AbortSignal) => {
    const policy = await authorizeResponseControl(env, caller, owner, signal);
    const current = await inspectGrantCredentials(env, key, signal);
    signal.throwIfAborted(); assertControlCallerLive(caller);
    if (!policy || !qualified(current) || ownerIdentity(current) !== identity
      || !filterGrantCandidates(provider.id, [{ key, grant: current, runtimeState: null }], new Set(),
        grantRoutingPolicy(policy.grantRouting), key, undefined, Date.now()).available.length) unavailable();
    currentPolicy = policy;
  };
  return { inferenceBaseUrl: upstream.baseUrl, selectedApiKey, revalidateAccount, allows, permittedModelIds };
}

function qualified(grant: UpstreamGrant | null): grant is UpstreamGrant {
  return !!grant && grant.provider === "featherless" && grant.kind === "api_key" && grant.credentialStore === "durable_object"
    && grant.enabled === true && !grant.revokedAt && grant.credentialStatus === "active"
    && Number.isSafeInteger(grant.credentialGeneration) && typeof grant.credentialLineage === "string" && !!grant.credentialLineage
    && (!grant.expiresAt || Number.isFinite(Date.parse(grant.expiresAt)) && Date.parse(grant.expiresAt) > Date.now());
}
function ownerIdentity(grant: UpstreamGrant): string {
  return JSON.stringify([grant.provider, grant.kind, grant.credentialGeneration, grant.credentialLineage, grant.accountId ?? null]);
}
function unavailable(): never { throw new HttpError(503, "model_discovery_owner_unavailable", "the original catalog caller, credential or destination is unavailable"); }
