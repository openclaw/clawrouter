import { basetenCatalogRequest, readBasetenModels } from "./baseten-model-catalog.ts";
import { arceeCatalogRequest, readArceeModels } from "./arcee-model-catalog.ts";
import { novitaCatalogRequest, readNovitaModels } from "./novita-model-catalog.ts";
import type { ProxySelection } from "./proxy-selection.ts";
import type { UpstreamAuth } from "./providers.ts";
import type { AuthorizedIdentity, Env, UpstreamGrant } from "./types.ts";
import { HttpError, sha256Hex } from "./utils.ts";

const catalogs = {
  "baseten.models": { provider: "baseten", request: basetenCatalogRequest, read: readBasetenModels },
  "arcee.models": { provider: "arcee", request: arceeCatalogRequest, read: readArceeModels },
  "novita.models": { provider: "novita", request: novitaCatalogRequest, read: readNovitaModels },
} as const;

export function isKeyedModelDiscovery(format: string): format is keyof typeof catalogs {
  return Object.hasOwn(catalogs, format);
}

export function readKeyedModelDiscovery(format: keyof typeof catalogs, response: Response, signal: AbortSignal, allows: (id: string) => boolean) {
  return catalogs[format].read(response, signal, allows);
}

// Only these native keyed catalogs use this boundary. Public metadata has a
// separate request contract and must never inherit these credential headers.
export async function prepareKeyedModelDiscovery(request: Request, env: Env, auth: AuthorizedIdentity,
  selection: ProxySelection, upstream: UpstreamAuth, url: URL, headers: Headers): Promise<(signal: AbortSignal) => Promise<void>> {
  const { provider, endpoint } = selection, format = endpoint.request_format;
  if (!isKeyedModelDiscovery(format)) unavailable();
  const contract = catalogs[format], grant = upstream.grant, key = upstream.grantKey;
  if (provider.id !== contract.provider || endpoint.response_format !== format || selection.method !== "GET" || endpoint.method !== "GET"
    || endpoint.path !== "/models" || endpoint.path_params.length || Object.keys(selection.pathParams).length
    || endpoint.auth != null || endpoint.upstreamPath !== undefined || endpoint.streaming || endpoint.websocket || endpoint.lifecycle || endpoint.responsesLifecycle
    || Object.keys(selection.body).length || Object.keys(endpoint.query).length || url.search || new URL(request.url).search
    || upstream.query.size || upstream.transport !== null || !key || !qualifiedGrant(grant, provider.id)) unavailable();
  const scheme = provider.auth.schemes.find(scheme => scheme.type !== "oauth");
  if (scheme?.type !== "bearer" || scheme.header.toLowerCase() !== "authorization" || scheme.format !== "Bearer ${secret}"
    || scheme.secretKind !== "api_key") unavailable();
  const authorization = upstream.headers.get("authorization"), match = authorization?.match(/^Bearer ([\x21-\x7e]{1,8192})$/);
  if (!match || typeof grant.credential !== "string" || grant.credential !== match[1]) unavailable();
  const native = contract.request(upstream.baseUrl, match[1], request.signal);
  if (native.url !== url.href) unavailable();
  // Use only the published request's headers; caller/static header controls
  // cannot turn discovery into another account or add forwarded credentials.
  for (const name of [...headers.keys()]) headers.delete(name);
  native.headers.forEach((value, name) => headers.set(name, value));
  const original = ownerIdentity(grant);
  const owner = { providerId: provider.id, endpointId: endpoint.id, grantKey: key, lineage: grant.credentialLineage!,
    routeSha256: await sha256Hex(JSON.stringify([format, native.url])), policyGeneration: auth.policy.generation };
  const { publicControlAuthorization, authorizeResponseControl, assertControlCallerLive } = await import("./response-control-authorization.ts");
  const { inspectGrantCredentials } = await import("./grant-credentials.ts");
  const caller = publicControlAuthorization(auth);
  return async signal => {
    // Reuse canonical caller/policy authorization, then inspect the already
    // selected owner without admission/credential caches or materialization.
    await authorizeResponseControl(env, caller, owner, signal);
    const current = await inspectGrantCredentials(env, key, signal);
    signal.throwIfAborted(); assertControlCallerLive(caller);
    if (!qualifiedGrant(current, provider.id) || ownerIdentity(current) !== original) unavailable();
  };
}

function qualifiedGrant(grant: UpstreamGrant | null, provider: string): grant is UpstreamGrant {
  return !!grant && grant.provider === provider && grant.kind === "api_key" && grant.credentialStore === "durable_object"
    && grant.enabled === true && !grant.revokedAt && grant.credentialStatus === "active"
    && Number.isSafeInteger(grant.credentialGeneration) && typeof grant.credentialLineage === "string" && !!grant.credentialLineage
    && (!grant.expiresAt || Number.isFinite(Date.parse(grant.expiresAt)) && Date.parse(grant.expiresAt) > Date.now());
}
function ownerIdentity(grant: UpstreamGrant): string {
  return JSON.stringify([grant.provider, grant.kind, grant.credentialGeneration, grant.credentialLineage, grant.accountId ?? null]);
}
function unavailable(): never { throw new HttpError(503, "model_discovery_owner_unavailable", "the original catalog credential or destination is unavailable"); }
