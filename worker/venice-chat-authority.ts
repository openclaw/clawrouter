import { inspectGrantCredentials } from "./grant-credentials.ts";
import { filterGrantCandidates, grantRoutingPolicy } from "./grant-selection.ts";
import { assertPolicyModel } from "./policy-models.ts";
import type { ProxySelection } from "./proxy-selection.ts";
import type { UpstreamAuth } from "./providers.ts";
import { assertControlCallerLive, authorizeResponseControl, publicControlAuthorization } from "./response-control-authorization.ts";
import type { AuthorizedIdentity, Env, UpstreamGrant } from "./types.ts";
import { envValue, HttpError, safeEqual, sha256Hex } from "./utils.ts";

// This is a fresh check of an already selected credential, never a new pool
// selection, refresh or environment fallback. Delivery repeats the same check.
export async function prepareVeniceChatAuthority(env: Env, auth: AuthorizedIdentity, selection: ProxySelection,
  upstream: UpstreamAuth, url: URL, headers: Headers): Promise<{ revalidate(signal: AbortSignal): Promise<void>; assertLive(): void }> {
  const { grant, grantKey } = upstream;
  const authorization = upstream.headers.get("authorization");
  if (selection.provider.id !== "venice" || !selection.model || upstream.transport !== null
    || upstream.baseUrl !== "https://api.venice.ai/api/v1" || url.href !== "https://api.venice.ai/api/v1/chat/completions"
    || !authorization || headers.get("authorization") !== authorization || upstream.query.size) unavailable();
  const original = grantKey && qualified(grant) ? identity(grant) : null;
  const environment = !grantKey && !grant ? envValue(env, "VENICE_API_KEY") : null;
  if (grantKey ? !original || typeof grant?.credential !== "string" || authorization !== `Bearer ${grant.credential}`
    : !environment || authorization !== `Bearer ${environment}`) unavailable();
  const caller = publicControlAuthorization(auth);
  const owner = { providerId: "venice", endpointId: selection.endpoint.id, grantKey,
    lineage: grant?.credentialLineage ?? null, policyGeneration: auth.policy.generation,
    routeSha256: await sha256Hex(JSON.stringify([url.href, selection.endpoint.id, selection.model.upstream])) };
  const assertLive = () => {
    assertControlCallerLive(caller);
    if (grant && (!qualified(grant) || identity(grant) !== original)
      || environment && !safeEqual(envValue(env, "VENICE_API_KEY") ?? "", environment)) unavailable();
  };
  return { assertLive, async revalidate(signal) {
    const policy = await authorizeResponseControl(env, caller, owner, signal);
    if (!policy) unavailable();
    assertPolicyModel(policy, selection);
    const routing = grantRoutingPolicy(policy.grantRouting);
    if (grantKey) {
      const current = await inspectGrantCredentials(env, grantKey, signal);
      if (!qualified(current) || identity(current) !== original
        || !filterGrantCandidates("venice", [{ key: grantKey, grant: current, runtimeState: null }], new Set(), routing,
          grantKey, undefined, Date.now()).available.length) unavailable();
    } else {
      // An explicit grant allowlist cannot silently become environment authority.
      if (routing.eligibleGrants.venice?.length && !routing.environmentFallback
        || !safeEqual(envValue(env, "VENICE_API_KEY") ?? "", environment!)) unavailable();
    }
    signal.throwIfAborted(); assertLive();
  } };
}

function qualified(grant: UpstreamGrant | null): grant is UpstreamGrant {
  return !!grant && grant.provider === "venice" && grant.kind === "api_key" && grant.credentialStore === "durable_object"
    && grant.enabled === true && !grant.revokedAt && grant.credentialStatus === "active"
    && Number.isSafeInteger(grant.credentialGeneration) && !!grant.credentialLineage
    && (!grant.expiresAt || Number.isFinite(Date.parse(grant.expiresAt)) && Date.parse(grant.expiresAt) > Date.now());
}
function identity(grant: UpstreamGrant): string {
  return JSON.stringify([grant.provider, grant.kind, grant.credentialGeneration, grant.credentialLineage, grant.accountId ?? null]);
}
function unavailable(): never { throw new HttpError(503, "venice_chat_owner_unavailable", "the original Venice Chat authorization is unavailable"); }
