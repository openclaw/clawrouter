import type { PreparationAdmission } from "./provider-templates.ts";
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
  selection: ProxySelection, env: Env, upstream: UpstreamAuth, destination: URL, headers: Headers, auth?: AuthorizedIdentity, preparation?: PreparationAdmission,
): Promise<MediaCheck | undefined> {
  if (selection.endpoint.request_format === "minimax.music")
    return prepareMiniMaxMusicDispatch(selection, env, upstream, destination, headers, auth, preparation);
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
    return speechOwnerCheck(key, identity);
  }
  if (upstream.grant !== null) throw denied();
  const selected = await qualifyMiniMaxEnvironmentBinding(selection.provider, env, "minimax.speech", preparation);
  if (!selected || headers.get("authorization") !== `Bearer ${selected.secret}`) throw denied();
  const routeIdentity = JSON.stringify(["clawrouter.minimax-media-route.v1", destination.href,
    "MINIMAX_API_KEY", selected.binding, selected.fingerprint]);
  return speechEnvironmentCheck(selection.provider, destination.href, routeIdentity, preparation);

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
  destination: URL, headers: Headers, auth?: AuthorizedIdentity, preparation?: PreparationAdmission): Promise<MediaCheck> {
  const requirement = { provider: selection.provider, endpoint: selection.endpoint, mode: "http" as const, model: selection.model?.upstream };
  if (!auth || !miniMaxMusicRequirement(requirement) || selection.capability !== "music.generate"
    || upstream.transport !== null || upstream.baseUrl !== "https://api.minimax.io"
    || destination.href !== "https://api.minimax.io/v1/music_generation" || upstream.query.size || Object.keys(selection.pathParams).length) miniMaxMusicDenied();
  if (upstream.grantKey !== null) {
    const grant = upstream.grant, key = upstream.grantKey;
    if (!grant || !miniMaxApiKeySecret(grant) || headers.get("authorization") !== `Bearer ${miniMaxApiKeySecret(grant)}`) miniMaxMusicDenied();
    miniMaxMusicIdentity(grant);
    return musicOwnerCheck(auth, requirement, key, grant);
  }
  if (upstream.grant !== null) miniMaxMusicDenied();
  const selected = await qualifyMiniMaxEnvironmentBinding(selection.provider, env, "minimax.music", preparation);
  if (!selected || headers.get("authorization") !== `Bearer ${selected.secret}`) miniMaxMusicDenied();
  const caller = publicControlAuthorization(auth);
  const routing = JSON.stringify(grantRoutingPolicy(auth.policy.grantRouting));
  const owner = { providerId: "minimax", endpointId: selection.endpoint.id, grantKey: null, lineage: null,
    routeSha256: `minimax.music:${selection.model!.upstream}:global`, policyGeneration: auth.policy.generation };
  return musicEnvironmentCheck(caller, owner, routing, selection, selected.binding, selected.secret, preparation);
}

// Module factories cannot retain a preparation-time Env. Revalidation receives
// the current authority environment explicitly, and projects fresh primitives
// both before and after the fingerprint await.
type MediaCheck = (currentEnv: Env, signal: AbortSignal) => Promise<void>;
function speechOwnerCheck(key: string, identity: string): MediaCheck {
  return async (currentEnv, signal) => {
    signal.throwIfAborted();
    const current = await inspectGrantCredentials(currentEnv, key, signal);
    signal.throwIfAborted();
    if (ownerIdentity(current) !== identity) throw denied();
  };
}
function speechEnvironmentCheck(provider: ProxySelection["provider"], destination: string, identity: string, preparation?: PreparationAdmission): MediaCheck {
  return async (currentEnv, signal) => {
    signal.throwIfAborted();
    const current = await qualifyMiniMaxEnvironmentBinding(provider, currentEnv, "minimax.speech", preparation);
    signal.throwIfAborted();
    if (!current || identity !== JSON.stringify(["clawrouter.minimax-media-route.v1", destination,
      "MINIMAX_API_KEY", current.binding, current.fingerprint])) throw denied();
  };
}
function musicOwnerCheck(auth: AuthorizedIdentity, requirement: GrantRequirement, key: string, grant: UpstreamGrant): MediaCheck {
  return async (currentEnv, signal) => { await revalidateMiniMaxMusicOwner(currentEnv, auth, requirement, key, grant, signal); };
}
function musicEnvironmentCheck(caller: ReturnType<typeof publicControlAuthorization>, owner: Parameters<typeof authorizeResponseControl>[2],
  routing: string, selection: ProxySelection, binding: string, secret: string, preparation?: PreparationAdmission): MediaCheck {
  return async (currentEnv, signal) => {
    const policy = await authorizeResponseControl(currentEnv, caller, owner, signal);
    if (!policy || JSON.stringify(grantRoutingPolicy(policy.grantRouting)) !== routing) miniMaxMusicDenied();
    assertPolicyModel(policy, selection);
    const current = await qualifyMiniMaxEnvironmentBinding(selection.provider, currentEnv, "minimax.music", preparation);
    signal.throwIfAborted(); assertControlCallerLive(caller);
    if (!current || current.binding !== binding || current.secret !== secret) miniMaxMusicDenied();
  };
}
