import { inspectGrantCredentials } from "./grant-credentials.ts";
import { miniMaxApiKeySecret, qualifyMiniMaxEnvironmentBinding, miniMaxMediaProjection, miniMaxMusicRequirement } from "./native-media-credential.ts";
import { filterGrantCandidates, grantRoutingPolicy } from "./grant-selection.ts";
import { assertPolicyModel } from "./policy-models.ts";
import type { GrantRequirement } from "./provider-auth.ts";
import { assertControlCallerLive, authorizeResponseControl, publicControlAuthorization } from "./response-control-authorization.ts";
import type { ProxySelection } from "./proxy-selection.ts";
import type { UpstreamAuth } from "./providers.ts";
import type { AuthorizedIdentity, Env, UpstreamGrant } from "./types.ts";
import { HttpError } from "./utils.ts";

const denied = () => new HttpError(403, "native_media_authorization_required", "Global MiniMax speech requires unchanged original credential authorization");
function ownerIdentity(grant: UpstreamGrant): string {
  if (!miniMaxMediaProjection(grant) || !Number.isSafeInteger(grant.credentialGeneration) || !grant.credentialLineage) throw denied();
  return JSON.stringify([grant.provider, grant.kind, grant.accountId ?? null, grant.credentialGeneration,
    grant.credentialLineage, grant.nativeMediaBinding]);
}

// Prepared only for this qualified product. No credential refresh or selection
// occurs here. The returned check runs after every other pre-dispatch await.
export async function prepareMiniMaxMediaDispatch(
  selection: ProxySelection, env: Env, upstream: UpstreamAuth, destination: URL, headers: Headers, auth?: AuthorizedIdentity,
): Promise<((signal: AbortSignal) => Promise<void>) | undefined> {
  if (selection.endpoint.request_format === "minimax.music")
    return prepareMiniMaxMusicDispatch(selection, env, upstream, destination, headers, auth);
  if (selection.endpoint.request_format !== "minimax.speech") return;
  const scheme = selection.provider.auth.schemes.find(value => value.type !== "oauth");
  if (selection.provider.id !== "minimax" || upstream.baseUrl !== "https://api.minimax.io"
    || destination.href !== "https://api.minimax.io/v1/t2a_v2" || upstream.transport !== null
    || scheme?.type !== "bearer" || scheme.header.toLowerCase() !== "authorization"
    || scheme.format !== "Bearer ${secret}" || scheme.secretKind !== "api_key" || [...upstream.query].length) throw denied();
  const key = upstream.grantKey;
  if (key !== null) {
    const grant = upstream.grant;
    if (!grant) throw denied();
    const identity = ownerIdentity(grant), secret = miniMaxApiKeySecret(grant);
    if (!secret || headers.get("authorization") !== `Bearer ${secret}`) throw denied();
    return async signal => {
      signal.throwIfAborted();
      // /inspect reads the credential owner, not KV, admission or credential caches.
      // Generation must equal the already selected revision; materialize's
      // expectedGeneration is deliberately not used as an equality check.
      const current = await inspectGrantCredentials(env, key, signal);
      signal.throwIfAborted();
      if (ownerIdentity(current) !== identity) throw denied();
    };
  }
  if (upstream.grant !== null) throw denied();
  const selected = await qualifyMiniMaxEnvironmentBinding(selection.provider, env);
  if (!selected || headers.get("authorization") !== `Bearer ${selected.secret}`) throw denied();
  const routeIdentity = JSON.stringify(["clawrouter.minimax-media-route.v1", destination.href,
    "MINIMAX_API_KEY", selected.binding, selected.fingerprint]);
  return async signal => {
    signal.throwIfAborted();
    const current = await qualifyMiniMaxEnvironmentBinding(selection.provider, env);
    signal.throwIfAborted();
    if (!current || routeIdentity !== JSON.stringify([
      "clawrouter.minimax-media-route.v1", destination.href, "MINIMAX_API_KEY", current.binding, current.fingerprint])) throw denied();
  };
}

export function miniMaxMusicDenied(): never {
  throw new HttpError(403, "minimax_music_authorization_required", "MiniMax music requires unchanged original global music authorization");
}

export function miniMaxMusicIdentity(grant: UpstreamGrant): string {
  if (!miniMaxMediaProjection(grant, "minimax.music") || !Number.isSafeInteger(grant.credentialGeneration)
    || !grant.credentialLineage || grant.expiresAt != null && (!Number.isFinite(Date.parse(grant.expiresAt)) || Date.parse(grant.expiresAt) <= Date.now()))
    miniMaxMusicDenied();
  return JSON.stringify([grant.provider, grant.kind, grant.accountId ?? null, grant.credentialGeneration,
    grant.credentialLineage, grant.nativeMediaBinding, grant.expiresAt ?? null]);
}

// Reused before materialization and immediately before fetch. Neither stale
// admission projections nor a new key under the original grant may qualify.
export async function revalidateMiniMaxMusicOwner(env: Env, auth: AuthorizedIdentity, requirement: GrantRequirement,
  key: string, grant: UpstreamGrant, signal: AbortSignal): Promise<UpstreamGrant> {
  if (!miniMaxMusicRequirement(requirement)) miniMaxMusicDenied();
  const original = miniMaxMusicIdentity(grant), caller = publicControlAuthorization(auth);
  const model = requirement.provider.models.find(row => row.id === requirement.model || row.upstream === requirement.model)!;
  const owner = { providerId: "minimax", endpointId: requirement.endpoint.id, grantKey: key,
    lineage: grant.credentialLineage!, routeSha256: `minimax.music:${model.upstream}:global`, policyGeneration: auth.policy.generation };
  const policy = await authorizeResponseControl(env, caller, owner, signal);
  if (!policy) miniMaxMusicDenied();
  assertPolicyModel(policy, { endpoint: requirement.endpoint, capability: "music.generate", model });
  const current = await inspectGrantCredentials(env, key, signal);
  signal.throwIfAborted(); assertControlCallerLive(caller);
  if (miniMaxMusicIdentity(current) !== original || !filterGrantCandidates("minimax", [{ key, grant: current, runtimeState: null }],
    new Set(), grantRoutingPolicy(policy.grantRouting), key, requirement, Date.now()).available.length) miniMaxMusicDenied();
  return current;
}

async function prepareMiniMaxMusicDispatch(selection: ProxySelection, env: Env, upstream: UpstreamAuth,
  destination: URL, headers: Headers, auth?: AuthorizedIdentity): Promise<(signal: AbortSignal) => Promise<void>> {
  const requirement = { provider: selection.provider, endpoint: selection.endpoint, mode: "http" as const, model: selection.model?.upstream };
  if (!auth || !miniMaxMusicRequirement(requirement) || selection.capability !== "music.generate"
    || upstream.transport !== null || upstream.baseUrl !== "https://api.minimax.io"
    || destination.href !== "https://api.minimax.io/v1/music_generation" || upstream.query.size || Object.keys(selection.pathParams).length) miniMaxMusicDenied();
  if (upstream.grantKey !== null) {
    const grant = upstream.grant, key = upstream.grantKey;
    if (!grant || !miniMaxApiKeySecret(grant) || headers.get("authorization") !== `Bearer ${miniMaxApiKeySecret(grant)}`) miniMaxMusicDenied();
    miniMaxMusicIdentity(grant);
    return async signal => { await revalidateMiniMaxMusicOwner(env, auth, requirement, key, grant, signal); };
  }
  if (upstream.grant !== null) miniMaxMusicDenied();
  const selected = await qualifyMiniMaxEnvironmentBinding(selection.provider, env, "minimax.music");
  if (!selected || headers.get("authorization") !== `Bearer ${selected.secret}`) miniMaxMusicDenied();
  const caller = publicControlAuthorization(auth);
  const routing = JSON.stringify(grantRoutingPolicy(auth.policy.grantRouting));
  const owner = { providerId: "minimax", endpointId: selection.endpoint.id, grantKey: null, lineage: null,
    routeSha256: `minimax.music:${selection.model!.upstream}:global`, policyGeneration: auth.policy.generation };
  return async signal => {
    const policy = await authorizeResponseControl(env, caller, owner, signal);
    if (!policy || JSON.stringify(grantRoutingPolicy(policy.grantRouting)) !== routing) miniMaxMusicDenied();
    assertPolicyModel(policy, selection);
    const current = await qualifyMiniMaxEnvironmentBinding(selection.provider, env, "minimax.music");
    signal.throwIfAborted(); assertControlCallerLive(caller);
    if (!current || current.binding !== selected.binding || current.secret !== selected.secret) miniMaxMusicDenied();
  };
}
