import { inspectGrantCredentials } from "./grant-credentials.ts";
import type { CredentialRecord } from "./grant-credential-record.ts";
import { filterGrantCandidates, grantRoutingPolicy } from "./grant-selection.ts";
import { transportForGrant } from "./provider-auth.ts";
import { modelSupportsEndpoint, snapshot } from "./providers.ts";
import { assertPolicyModel } from "./policy-models.ts";
import { authorizeIssuedControl, assertIssuedControlLive, publicControlAuthorization, type PublicControlBinding } from "./response-control-authorization.ts";
import { assertPublishedInputLive, publishedInputUnavailable, validatePublishedIssuer, type PublishedInputBinding } from "./published-input-receipt.ts";
import type { AuthorizedIdentity, CompiledEndpoint, CompiledModel, CompiledProvider, Env, UpstreamGrant } from "./types.ts";
import { sha256Hex } from "./utils.ts";

export function issuedPublishedInputCaller(auth: AuthorizedIdentity): PublicControlBinding {
  const authorization = publicControlAuthorization(auth);
  if (authorization.kind !== "public") publishedInputUnavailable();
  const binding = structuredClone(authorization.binding);
  validatePublishedIssuer(binding);
  return binding;
}
export async function publishedInputScope(issuer: PublicControlBinding): Promise<string> {
  validatePublishedIssuer(issuer);
  return `http-continuations:${await sha256Hex(JSON.stringify([issuer.proof.kind === "proxy_key" ? "proxy_key" : "access",
    issuer.tenantId, issuer.policyId, issuer.credentialId, issuer.principalId]))}`;
}

export function publishedMusicRoute(binding: PublishedInputBinding): { provider: CompiledProvider; endpoint: CompiledEndpoint; model: CompiledModel } {
  const provider = snapshot.providers.find(value => value.id === "openrouter");
  const endpoint = provider?.endpoints.find(value => value.id === binding.owner.endpointId);
  const model = provider?.models.find(value => value.id === binding.modelId);
  if (!provider || !endpoint || !model || provider.base_urls.default !== "https://openrouter.ai/api"
    || model.upstream !== binding.upstreamModel || !model.capabilities.includes("music.generate")
    || !provider.capabilities.some(value => value.id === "music.generate" && value.endpoint === endpoint.id)
    || !modelSupportsEndpoint(provider, model, endpoint)
    || endpoint.method !== "POST" || endpoint.path !== "/v1/chat/completions"
    || endpoint.request_format !== "openai.chat_completions" || endpoint.response_format !== "openai.chat_completions"
    || endpoint.streaming !== "sse" || endpoint.upstreamPath !== undefined || endpoint.path_params.length || Object.keys(endpoint.query).length
    || endpoint.websocket || endpoint.lifecycle || endpoint.responsesLifecycle || endpoint.modelPassthrough || endpoint.requestPricing
    || endpoint.inputProfile !== undefined) publishedInputUnavailable();
  return { provider, endpoint, model };
}

export async function publishedMusicRouteDigest(binding: Pick<PublishedInputBinding, "owner" | "modelId" | "upstreamModel" | "publicOrigin">): Promise<string> {
  return sha256Hex(JSON.stringify(["clawrouter.published-input-route.v1", "openrouter", binding.owner.endpointId,
    binding.modelId, binding.upstreamModel, "https://openrouter.ai/api/v1/chat/completions", "POST",
    "openai.chat_completions", "openai.chat_completions", "sse", binding.publicOrigin]));
}

// Owner freshness is necessary, not publication/forwarding consent. Each
// operation must also qualify the distinct current permission before egress.
// This function never materializes a key, refreshes, or selects another grant.
export async function authorizePublishedInputOwner(env: Env, binding: PublishedInputBinding, signal: AbortSignal) {
  assertPublishedInputLive(binding);
  if (env.CLAWROUTER_PUBLIC_ORIGIN !== binding.publicOrigin || await publishedInputScope(binding.issuer) !== binding.scope
    || await publishedMusicRouteDigest(binding) !== binding.owner.routeSha256) publishedInputUnavailable();
  const route = publishedMusicRoute(binding);
  const policy = await authorizeIssuedControl(env, binding.issuer, binding.owner, signal);
  assertPolicyModel(policy, { ...route, capability: "music.generate" });
  const grant = await inspectGrantCredentials(env, binding.owner.grantKey, signal);
  signal.throwIfAborted(); assertPublishedInputLive(binding); assertIssuedControlLive(binding.issuer);
  assertPublishedInputGrant(binding, grant);
  if (transportForGrant(route.provider, grant) !== null || !filterGrantCandidates("openrouter",
    [{ key: binding.owner.grantKey, grant, runtimeState: null }], new Set(), grantRoutingPolicy(policy.grantRouting),
    binding.owner.grantKey, undefined, Date.now()).available.length) publishedInputUnavailable();
  return { ...route, policy, grant };
}

export function assertPublishedInputGrant(binding: PublishedInputBinding, grant: UpstreamGrant | undefined): asserts grant is UpstreamGrant {
  if (!grant || grant.provider !== "openrouter" || grant.kind !== "api_key" || grant.credentialStore !== "durable_object"
    || grant.enabled !== true || grant.revokedAt || grant.credentialStatus !== "active"
    || grant.credentialGeneration !== binding.generation || grant.credentialLineage !== binding.owner.lineage
    || !grant.hasCredential || grant.credentialFields?.length
    || grant.expiresAt && (!Number.isFinite(Date.parse(grant.expiresAt)) || Date.parse(grant.expiresAt) <= Date.now())) publishedInputUnavailable();
}

// Called with the actual original owner record while its existing mutation
// tail is held. Kind alone cannot authorize an accessToken/map-value fallback.
export function assertPublishedInputCredential(binding: PublishedInputBinding, record: CredentialRecord | undefined): asserts record is CredentialRecord & { credential: string } {
  if (!record || record.version !== 1 || record.grantKey !== binding.owner.grantKey || record.providerId !== "openrouter"
    || record.kind !== "api_key" || record.generation !== binding.generation || record.lineage !== binding.owner.lineage
    || record.enabled !== true || record.revokedAt || record.status !== "active"
    || typeof record.credential !== "string" || !record.credential || Object.keys(record.credentials ?? {}).length
    || record.expiresAt && (!Number.isFinite(Date.parse(record.expiresAt)) || Date.parse(record.expiresAt) <= Date.now())) publishedInputUnavailable();
}
