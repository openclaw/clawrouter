import { inspectGrantCredentials } from "./grant-credentials.ts";
import { filterGrantCandidates, grantRoutingPolicy } from "./grant-selection.ts";
import { miniMaxImageDenied, miniMaxImageIdentity, miniMaxImageRequirement } from "./minimax-image-credential.ts";
import { miniMaxApiKeySecret } from "./native-media-credential.ts";
import { assertPolicyModel } from "./policy-models.ts";
import type { GrantRequirement } from "./provider-auth.ts";
import type { ProxySelection } from "./proxy-selection.ts";
import type { UpstreamAuth } from "./providers.ts";
import { assertControlCallerLive, authorizeResponseControl, publicControlAuthorization } from "./response-control-authorization.ts";
import type { AuthorizedIdentity, Env, UpstreamGrant } from "./types.ts";

// Read-only, owner-authoritative qualification before secret materialization.
// Final dispatch repeats it after the budget and retention waits. No selection
// refresh, alternative credential or environment fallback is permitted.
export async function revalidateMiniMaxImageOwner(env: Env, auth: AuthorizedIdentity, requirement: GrantRequirement,
  key: string, grant: UpstreamGrant, signal: AbortSignal): Promise<UpstreamGrant> {
  if (!miniMaxImageRequirement(requirement)) miniMaxImageDenied();
  const original = miniMaxImageIdentity(grant), caller = publicControlAuthorization(auth);
  const owner = { providerId: "minimax", endpointId: requirement.endpoint.id, grantKey: key,
    lineage: grant.credentialLineage!, routeSha256: "minimax.images:image-01:global", policyGeneration: auth.policy.generation };
  const policy = await authorizeResponseControl(env, caller, owner, signal);
  if (!policy) miniMaxImageDenied();
  const model = requirement.provider.models.find(row => row.id === requirement.model || row.upstream === requirement.model)!;
  assertPolicyModel(policy, { endpoint: requirement.endpoint, capability: "image.generate", model });
  const current = await inspectGrantCredentials(env, key, signal);
  signal.throwIfAborted(); assertControlCallerLive(caller);
  if (miniMaxImageIdentity(current) !== original || !filterGrantCandidates("minimax", [{ key, grant: current, runtimeState: null }],
    new Set(), grantRoutingPolicy(policy.grantRouting), key, requirement, Date.now()).available.length) miniMaxImageDenied();
  return current;
}

export function prepareMiniMaxImageDispatch(env: Env, auth: AuthorizedIdentity, selection: ProxySelection,
  upstream: UpstreamAuth, destination: URL, headers: Headers): (signal: AbortSignal) => Promise<void> {
  const requirement = { provider: selection.provider, endpoint: selection.endpoint, mode: "http" as const, model: selection.model?.upstream };
  const grant = upstream.grant, key = upstream.grantKey;
  if (!grant || !key || !miniMaxImageRequirement(requirement) || upstream.transport !== null
    || upstream.baseUrl !== "https://api.minimax.io" || destination.href !== "https://api.minimax.io/v1/image_generation"
    || upstream.query.size || Object.keys(selection.pathParams).length || selection.capability !== "image.generate"
    || !miniMaxApiKeySecret(grant) || headers.get("authorization") !== `Bearer ${miniMaxApiKeySecret(grant)}`) miniMaxImageDenied();
  return async signal => { await revalidateMiniMaxImageOwner(env, auth, requirement, key, grant, signal); };
}
