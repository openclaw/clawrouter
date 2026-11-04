import { filterGrantCandidates, grantRoutingPolicy } from "./grant-selection.ts";
import { inspectGrantCredentials } from "./grant-credentials.ts";
import { discoveryAllows } from "./model-discovery.ts";
import { publicCatalogProvider } from "./public-model-discovery-formats.ts";
import type { ProxySelection } from "./proxy-selection.ts";
import type { UpstreamAuth } from "./providers.ts";
import { authorizeResponseControl, assertControlCallerLive, publicControlAuthorization } from "./response-control-authorization.ts";
import type { AuthorizedIdentity, Env, UpstreamGrant } from "./types.ts";
import { HttpError, sha256Hex } from "./utils.ts";

// No inference headers or credential bytes cross the public leaf ABI.
export async function preparePublicDiscoveryOwner(request: Request, env: Env, auth: AuthorizedIdentity,
  selection: ProxySelection, upstream: UpstreamAuth) {
  const { provider, endpoint } = selection, grant = upstream.grant, key = upstream.grantKey;
  const providerId = publicCatalogProvider(endpoint.request_format);
  if (!providerId || provider.id !== providerId || endpoint.response_format !== endpoint.request_format || !key || !qualified(grant, provider.id)
    || selection.method !== "GET" || endpoint.method !== "GET" || endpoint.path_params.length || Object.keys(selection.pathParams).length
    || endpoint.auth != null || endpoint.upstreamPath !== undefined || endpoint.streaming || endpoint.websocket || endpoint.lifecycle || endpoint.responsesLifecycle
    || Object.keys(selection.body).length || Object.keys(endpoint.query).length || new URL(request.url).search
    || upstream.query.size || upstream.transport !== null) unavailable();
  const identity = ownerIdentity(grant);
  const caller = publicControlAuthorization(auth);
  const owner = { providerId, endpointId: endpoint.id, grantKey: key, lineage: grant.credentialLineage!,
    routeSha256: await sha256Hex(JSON.stringify([providerId, endpoint.id, endpoint.request_format, upstream.baseUrl])),
    policyGeneration: auth.policy.generation };
  // A refresh may narrow this frozen finite set; it cannot add account offers.
  const permittedModelIds = new Set(provider.models.filter(model => discoveryAllows(auth.policy, provider, model.upstream)).map(model => model.upstream));
  let currentPolicy = auth.policy;
  const allows = (id: string) => permittedModelIds.has(id) && discoveryAllows(currentPolicy, provider, id);
  const revalidateAccount = async (signal: AbortSignal) => {
    const policy = await authorizeResponseControl(env, caller, owner, signal);
    const current = await inspectGrantCredentials(env, key, signal);
    signal.throwIfAborted(); assertControlCallerLive(caller);
    if (!policy || !qualified(current, providerId) || ownerIdentity(current) !== identity
      || !filterGrantCandidates(providerId, [{ key, grant: current, runtimeState: null }], new Set(),
        grantRoutingPolicy(policy.grantRouting), key, undefined, Date.now()).available.length) unavailable();
    currentPolicy = policy;
  };
  return { providerId, inferenceBaseUrl: upstream.baseUrl, revalidateAccount, allows, permittedModelIds };
}

function qualified(grant: UpstreamGrant | null, provider: string): grant is UpstreamGrant {
  return !!grant && grant.provider === provider && grant.kind === "api_key" && grant.credentialStore === "durable_object"
    && grant.enabled === true && !grant.revokedAt && grant.credentialStatus === "active"
    && Number.isSafeInteger(grant.credentialGeneration) && typeof grant.credentialLineage === "string" && !!grant.credentialLineage
    && (!grant.expiresAt || Number.isFinite(Date.parse(grant.expiresAt)) && Date.parse(grant.expiresAt) > Date.now());
}
function ownerIdentity(grant: UpstreamGrant): string {
  return JSON.stringify([grant.provider, grant.kind, grant.credentialGeneration, grant.credentialLineage, grant.accountId ?? null]);
}
function unavailable(): never { throw new HttpError(503, "model_discovery_owner_unavailable", "the original catalog caller, credential or destination is unavailable"); }
