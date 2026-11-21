import { inspectGrantCredentials } from "./grant-credentials.ts";
import { filterGrantCandidates, grantRoutingPolicy } from "./grant-selection.ts";
import { assertPolicyModel } from "./policy-models.ts";
import type { ProxySelection } from "./proxy-selection.ts";
import type { UpstreamAuth } from "./providers.ts";
import { assertControlCallerLive, authorizeResponseControl, publicControlAuthorization } from "./response-control-authorization.ts";
import type { AuthorizedIdentity, Env, UpstreamGrant } from "./types.ts";
import { HttpError, safeEqual, sha256Hex } from "./utils.ts";

// The leaf validates the opaque wire. Only common dispatch can establish its
// original credential and freshly re-admit the caller after reservation awaits.
export async function prepareOpenRouterPcmOwner(env: Env, auth: AuthorizedIdentity, selection: ProxySelection,
  upstream: UpstreamAuth, url: URL, headers: Headers): Promise<(signal: AbortSignal) => Promise<void>> {
  const { grant, grantKey } = upstream;
  if (!grantKey || !qualified(grant) || typeof grant.credential !== "string" || !grant.credential
    || upstream.transport !== null || upstream.query.size || upstream.baseUrl !== "https://openrouter.ai/api"
    || url.href !== "https://openrouter.ai/api/v1/audio/speech"
    || !safeEqual(headers.get("authorization") ?? "", `Bearer ${grant.credential}`)
    || headers.get("authorization") !== upstream.headers.get("authorization")) unavailable();
  const original = identity(grant), caller = publicControlAuthorization(auth);
  const owner = { providerId: "openrouter", endpointId: selection.endpoint.id, grantKey,
    lineage: grant.credentialLineage!, policyGeneration: auth.policy.generation,
    routeSha256: await sha256Hex(JSON.stringify([url.href, selection.model?.id, selection.model?.upstream])) };
  return async signal => {
    const policy = await authorizeResponseControl(env, caller, owner, signal);
    if (!policy) unavailable();
    assertPolicyModel(policy, selection);
    const current = await inspectGrantCredentials(env, grantKey, signal);
    signal.throwIfAborted(); assertControlCallerLive(caller);
    if (!qualified(current) || identity(current) !== original || !qualified(grant)
      || !filterGrantCandidates("openrouter", [{ key: grantKey, grant: current, runtimeState: null }], new Set(),
        grantRoutingPolicy(policy.grantRouting), grantKey, undefined, Date.now()).available.length) unavailable();
  };
}

function qualified(grant: UpstreamGrant | null): grant is UpstreamGrant {
  return !!grant && grant.provider === "openrouter" && grant.kind === "api_key" && grant.credentialStore === "durable_object"
    && grant.enabled === true && !grant.revokedAt && grant.credentialStatus === "active"
    && Number.isSafeInteger(grant.credentialGeneration) && !!grant.credentialLineage
    && (!grant.expiresAt || Number.isFinite(Date.parse(grant.expiresAt)) && Date.parse(grant.expiresAt) > Date.now());
}
function identity(grant: UpstreamGrant): string {
  return JSON.stringify([grant.provider, grant.kind, grant.credentialGeneration, grant.credentialLineage, grant.accountId ?? null]);
}
function unavailable(): never {
  throw new HttpError(503, "native_pcm_owner_unavailable", "the original OpenRouter PCM caller, credential or destination is unavailable");
}
