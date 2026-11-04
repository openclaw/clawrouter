import { vertexAnthropicProjection, vertexAnthropicUnavailable } from "./vertex-anthropic-binding.ts";
import { prepareVertexAnthropicRequest } from "./provider-vertex.ts";
import { jsonBodyBytes } from "./json-body.ts";
import { inspectGrantCredentials } from "./grant-credentials.ts";
import { filterGrantCandidates, grantRoutingPolicy } from "./grant-selection.ts";
import { assertPolicyModel } from "./policy-models.ts";
import { assertControlCallerLive, authorizeResponseControl, publicControlAuthorization } from "./response-control-authorization.ts";
import type { ProxySelection } from "./proxy-selection.ts";
import type { UpstreamAuth } from "./providers.ts";
import type { AuthorizedIdentity, CompiledEndpoint, CompiledProvider, Env, UpstreamGrant } from "./types.ts";
import { maxJsonBodyBytes, sha256Hex } from "./utils.ts";

export function vertexAnthropicRoute(provider: Pick<CompiledProvider, "id">, endpoint: Pick<CompiledEndpoint, "request_format">): boolean {
  return provider.id === "anthropic-vertex" && endpoint.request_format === "anthropic.messages";
}
function identity(grant: UpstreamGrant): string {
  const binding = vertexAnthropicProjection(grant);
  if (!binding) vertexAnthropicUnavailable();
  return JSON.stringify([grant.provider, grant.kind, grant.accountId ?? null, grant.credentialGeneration, grant.credentialLineage, binding, grant.expiresAt]);
}

export async function prepareVertexAnthropicDispatch(request: Request, env: Env, auth: AuthorizedIdentity,
  selection: ProxySelection, upstream: UpstreamAuth, hasQuery: boolean, transport: "http" | "websocket") {
  const { endpoint, model } = selection, grant = upstream.grant, key = upstream.grantKey;
  const binding = vertexAnthropicProjection(grant);
  if (!vertexAnthropicRoute(selection.provider, endpoint) || !grant || !key || !binding || !model || transport !== "http"
    || hasQuery || new URL(request.url).search || selection.capability !== "llm.chat" || selection.method !== "POST"
    || endpoint.method !== "POST" || endpoint.response_format !== "anthropic.messages" || endpoint.path !== "/v1/messages"
    || endpoint.upstreamPath !== undefined || endpoint.path_params.length || endpoint.auth || endpoint.websocket
    || endpoint.lifecycle || endpoint.responsesLifecycle || endpoint.modelPassthrough || endpoint.inputProfile
    || Object.keys(endpoint.query).length || upstream.query.size || upstream.transport !== null
    || Object.keys(selection.pathParams).some(name => !["model", "deployment"].includes(name) || selection.pathParams[name] !== model.upstream)
    || !selection.provider.models.some(row => row.id === model.id && row.upstream === model.upstream && row.capabilities.includes("llm.chat"))
    || Array.isArray(selection.body) || selection.body.model !== model.upstream || jsonBodyBytes(selection.body) > maxJsonBodyBytes
    || ["project", "project_id", "location", "region", "resource", "endpoint", "base_url", "baseUrl", "url"].some(name => Object.hasOwn(selection.body, name))) vertexAnthropicUnavailable();
  const original = identity(grant), caller = publicControlAuthorization(auth);
  const token = { accessToken: grant.accessToken!, expiresAt: Math.floor(Date.parse(grant.expiresAt!) / 1000) };
  let prepared: Request;
  try { prepared = prepareVertexAnthropicRequest(selection.body, binding, model.upstream, token, Math.floor(Date.now() / 1000)); }
  catch { vertexAnthropicUnavailable(); }
  try {
    const url = new URL(prepared.url);
    if (!["https://aiplatform.googleapis.com", url.origin].includes(upstream.baseUrl)
      || selection.provider.auth.schemes.some(scheme => scheme.type !== "bearer" && scheme.type !== "oauth")) vertexAnthropicUnavailable();
    const owner = { providerId: "anthropic-vertex", endpointId: endpoint.id, grantKey: key, lineage: grant.credentialLineage!,
      routeSha256: await sha256Hex(JSON.stringify([endpoint.request_format, url.href, model.id, model.upstream])), policyGeneration: auth.policy.generation };
    const requestBody = await prepared.text();
    // The codec owns the entire outbound request. Never merge caller/static
    // headers or serialize a second body with routing fields reintroduced.
    return {
      prepared: { url, configuredOwnerUrl: new URL(url), headers: new Headers(prepared.headers), requestBody, streamBody: false },
      async revalidate(signal: AbortSignal) {
        const policy = await authorizeResponseControl(env, caller, owner, signal);
        if (!policy) vertexAnthropicUnavailable();
        assertPolicyModel(policy, selection);
        const current = await inspectGrantCredentials(env, key, signal);
        signal.throwIfAborted(); assertControlCallerLive(caller);
        if (identity(current) !== original || !filterGrantCandidates("anthropic-vertex", [{ key, grant: current, runtimeState: null }],
          new Set(), grantRoutingPolicy(policy.grantRouting), key, undefined, Date.now()).available.length
          || token.expiresAt * 1000 <= Date.now() + 60_000) vertexAnthropicUnavailable();
      },
    };
  } catch (error) { void prepared.body?.cancel().catch(() => undefined); throw error; }
}
