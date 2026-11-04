import { configuredEndpointPath } from "./endpoint-path.ts";
import { inspectGrantCredentials } from "./grant-credentials.ts";
import { filterGrantCandidates, grantRoutingPolicy } from "./grant-selection.ts";
import { applyProviderCredential } from "./provider-auth.ts";
import { resolveTemplate } from "./provider-templates.ts";
import type { ProxySelection } from "./proxy-selection.ts";
import type { UpstreamAuth } from "./providers.ts";
import { assertControlCallerLive, authorizeResponseControl, publicControlAuthorization } from "./response-control-authorization.ts";
import type { AccessPolicy, AuthorizedIdentity, Env, UpstreamGrant } from "./types.ts";
import { HttpError, sha256Hex } from "./utils.ts";

// Generic OpenAI-shaped list metadata retains the already selected owner. It
// does not grant inference, select another key, or use environment credentials.
export async function prepareModelDiscoveryOwner(request: Request, env: Env, auth: AuthorizedIdentity,
  selection: ProxySelection, upstream: UpstreamAuth, url: URL, headers: Headers): Promise<(signal: AbortSignal) => Promise<AccessPolicy>> {
  const { provider, endpoint } = selection, { grant, grantKey } = upstream;
  if (endpoint.request_format !== "openai.models" || endpoint.response_format !== "openai.models"
    || selection.capability !== "models.list" || selection.model !== null || selection.method !== "GET" || endpoint.method !== "GET"
    || endpoint.path_params.length || Object.keys(selection.pathParams).length || Object.keys(selection.body).length
    || endpoint.auth || endpoint.streaming || endpoint.websocket || endpoint.lifecycle || endpoint.responsesLifecycle
    || endpoint.modelPassthrough || Object.keys(endpoint.query).length || new URL(request.url).search || url.search
    || upstream.transport !== null || upstream.query.size || !grantKey || !qualified(grant, provider.id)) unavailable();
  const destination = () => {
    const base = resolveTemplate(provider, provider.base_urls.default, env);
    if (base !== upstream.baseUrl) unavailable();
    return new URL(base.replace(/\/$/, "") + configuredEndpointPath(endpoint, undefined, base)).href;
  };
  if (url.href !== destination() || url.username || url.password || url.hash) unavailable();
  const selectedHeaders = new Headers(), selectedQuery = new URLSearchParams();
  applyProviderCredential(provider, grant, env, selectedHeaders, selectedQuery);
  if (selectedQuery.size || ![...selectedHeaders].length) unavailable();
  for (const [name, value] of selectedHeaders) if (headers.get(name) !== value || upstream.headers.get(name) !== value) unavailable();
  const original = identity(grant), originalModels = auth.policy.models == null ? null : [...auth.policy.models];
  const caller = publicControlAuthorization(auth), owner = {
    providerId: provider.id, endpointId: endpoint.id, grantKey, lineage: grant.credentialLineage!,
    routeSha256: await sha256Hex(JSON.stringify([endpoint.request_format, url.href])), policyGeneration: auth.policy.generation,
  };
  return async signal => {
    const policy = await authorizeResponseControl(env, caller, owner, signal);
    const current = await inspectGrantCredentials(env, grantKey, signal);
    signal.throwIfAborted(); assertControlCallerLive(caller);
    if (!policy || !qualified(current, provider.id) || identity(current) !== original || url.href !== destination()
      || !filterGrantCandidates(provider.id, [{ key: grantKey, grant: current, runtimeState: null }], new Set(),
        grantRoutingPolicy(policy.grantRouting), grantKey, undefined, Date.now()).available.length) unavailable();
    // A later policy may narrow the admitted inventory, never widen this call.
    return originalModels === null ? policy : { ...policy, models: originalModels.filter(id => policy.models == null || policy.models.includes(id)) };
  };
}

function qualified(grant: UpstreamGrant | null, provider: string): grant is UpstreamGrant {
  return !!grant && grant.provider === provider && grant.kind === "api_key" && grant.credentialStore === "durable_object"
    && grant.enabled === true && !grant.revokedAt && grant.credentialStatus === "active"
    && Number.isSafeInteger(grant.credentialGeneration) && !!grant.credentialLineage
    && (!grant.expiresAt || Number.isFinite(Date.parse(grant.expiresAt)) && Date.parse(grant.expiresAt) > Date.now());
}
function identity(grant: UpstreamGrant): string {
  return JSON.stringify([grant.provider, grant.kind, grant.credentialGeneration, grant.credentialLineage, grant.accountId ?? null]);
}
function unavailable(): never { throw new HttpError(503, "model_discovery_owner_unavailable", "the original catalog caller, credential or destination is unavailable"); }
