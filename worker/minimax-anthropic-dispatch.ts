import { miniMaxAnthropicProjection, miniMaxAnthropicUnavailable, miniMaxCredential } from "./minimax-anthropic-binding.ts";
import { prepareMiniMaxAnthropicRequest } from "./provider-minimax-oauth.ts";
import { inspectGrantCredentials } from "./grant-credentials.ts";
import { filterGrantCandidates, grantRoutingPolicy } from "./grant-selection.ts";
import { assertPolicyModel } from "./policy-models.ts";
import { assertControlCallerLive, authorizeResponseControl, publicControlAuthorization } from "./response-control-authorization.ts";
import type { ProxySelection } from "./proxy-selection.ts";
import type { UpstreamAuth } from "./providers.ts";
import type { AuthorizedIdentity, CompiledEndpoint, CompiledProvider, Env, UpstreamGrant } from "./types.ts";
import { sha256Hex } from "./utils.ts";

export function miniMaxAnthropicRoute(provider: Pick<CompiledProvider, "id">, endpoint: Pick<CompiledEndpoint, "request_format">): boolean {
  return provider.id === "minimax" && endpoint.request_format === "anthropic.messages";
}

function identity(grant: UpstreamGrant): string {
  const binding = miniMaxAnthropicProjection(grant);
  if (!binding) miniMaxAnthropicUnavailable();
  return JSON.stringify([grant.provider, grant.kind, grant.accountId ?? null, grant.credentialGeneration, grant.credentialLineage, binding, grant.expiresAt ?? null]);
}

// Regional routing derives only from the already selected owner's attestation.
// The declaration remains /anthropic/v1/messages; it cannot provide another
// URL, credential source or refresh endpoint. Preparation precedes serialization.
export async function prepareMiniMaxAnthropicDispatch(request: Request, env: Env, auth: AuthorizedIdentity,
  selection: ProxySelection, upstream: UpstreamAuth, hasQuery: boolean, transport: "http" | "websocket") {
  if (!miniMaxAnthropicRoute(selection.provider, selection.endpoint)) return undefined;
  const { endpoint, model } = selection, grant = upstream.grant, key = upstream.grantKey;
  const binding = miniMaxAnthropicProjection(grant);
  if (!grant || !key || !binding || !model || transport !== "http" || hasQuery || new URL(request.url).search
    || selection.capability !== "llm.chat" || selection.method !== "POST" || endpoint.method !== "POST"
    || endpoint.response_format !== "anthropic.messages" || endpoint.path !== "/anthropic/v1/messages"
    || endpoint.upstreamPath !== undefined || endpoint.path_params.length || endpoint.auth || endpoint.websocket
    || endpoint.lifecycle || endpoint.responsesLifecycle || endpoint.modelPassthrough || endpoint.inputProfile
    || Object.keys(endpoint.query).length || upstream.query.size || upstream.transport !== null
    || Object.keys(selection.pathParams).some(name => !["model", "deployment"].includes(name) || selection.pathParams[name] !== model.upstream)
    || !selection.provider.models.some(row => row.id === model.id && row.upstream === model.upstream && row.capabilities.includes("llm.chat"))
    || Array.isArray(selection.body) || selection.body.model !== model.upstream) miniMaxAnthropicUnavailable();
  const credential = miniMaxCredential({ ...grant, providerId: grant.provider, grantKey: key,
    generation: grant.credentialGeneration!, lineage: grant.credentialLineage });
  let prepared: ReturnType<typeof prepareMiniMaxAnthropicRequest>;
  try { prepared = prepareMiniMaxAnthropicRequest(selection.body, model.upstream, credential, credential.ownerBinding, Date.now()); }
  catch { miniMaxAnthropicUnavailable(); }
  const destination = new URL(prepared.url);
  if (destination.href !== `${binding.resource}/v1/messages`
    || !["https://api.minimax.io", destination.origin].includes(upstream.baseUrl)
    || selection.provider.auth.schemes.some(scheme => scheme.type !== "bearer" && scheme.type !== "oauth")) miniMaxAnthropicUnavailable();
  selection.body = prepared.body;
  const original = identity(grant), caller = publicControlAuthorization(auth);
  const owner = { providerId: "minimax", endpointId: endpoint.id, grantKey: key, lineage: grant.credentialLineage!,
    routeSha256: await sha256Hex(JSON.stringify([endpoint.request_format, destination.href, model.id, model.upstream])), policyGeneration: auth.policy.generation };
  return {
    upstream: { ...upstream, baseUrl: destination.origin, headers: new Headers(prepared.headers) },
    apply(url: URL, headers: Headers) {
      if (url.href !== destination.href) miniMaxAnthropicUnavailable();
      // Neither caller forwarding nor static templates can replace the codec's
      // original auth or native API headers after regional qualification.
      for (const name of [...headers.keys()]) headers.delete(name);
      new Headers(prepared.headers).forEach((value, name) => headers.set(name, value));
    },
    async revalidate(signal: AbortSignal) {
      const policy = await authorizeResponseControl(env, caller, owner, signal);
      if (!policy) miniMaxAnthropicUnavailable();
      assertPolicyModel(policy, selection);
      // The last await is owner-authoritative, bypassing admission/materialize
      // caches. It compares equality; it never refreshes or selects a new key.
      const current = await inspectGrantCredentials(env, key, signal);
      signal.throwIfAborted(); assertControlCallerLive(caller);
      if (identity(current) !== original || !filterGrantCandidates("minimax", [{ key, grant: current, runtimeState: null }],
        new Set(), grantRoutingPolicy(policy.grantRouting), key, undefined, Date.now()).available.length
        || credential.kind === "oauth" && credential.expiresAt <= Date.now() + 60_000) miniMaxAnthropicUnavailable();
    },
  };
}
