import { boundedJson } from "./private-codex-io";
import { privateAuthorizationCurrent, privateAuthorized, privatePolicy, privateUpstream, record } from "./private-codex-config";
import { containResponse, privateError, privateJson } from "./private-codex-output";
import { forwardPrivateHeaders, inspectPrivateOpaque, validPrivateHeaders, validPrivateProtocolBody } from "./private-codex-protocol";
import type { Env } from "./types";

const upstreamUrl = "https://chatgpt.com/backend-api/codex/responses";
const requestFields = new Set([
  "model", "input", "instructions", "stream", "store", "tools", "tool_choice", "parallel_tool_calls", "reasoning", "text",
  "include", "max_output_tokens", "temperature", "top_p", "truncation", "metadata", "previous_response_id",
  "prompt_cache_key", "prompt_cache_retention", "safety_identifier", "service_tier", "background",
  "client_metadata", "stream_options", "access_programs",
]);

export function privatePath(path: string): boolean {
  // Also intercept encoded spellings before public routing/correlation can reflect caller headers.
  try { return /^\/private(?:\/|$)/i.test(decodeURIComponent(path)); } catch { return path.startsWith("/private"); }
}

export function privateSubscriptionBody(body: Record<string, unknown>, target: string): Record<string, unknown> {
  const outgoing: Record<string, unknown> = { ...body, model: target };
  // The fixed subscription backend controls generation length; retain every other field.
  delete outgoing.max_output_tokens;
  return outgoing;
}

export async function privateCodex(request: Request, env: Env): Promise<Response> {
  try {
    const url = new URL(request.url);
    const discovery = request.method === "GET" && ["/private/v1/models", "/private/v1/catalog"].includes(url.pathname);
    const inference = request.method === "POST" && url.pathname === "/private/v1/responses";
    if ((!discovery && !inference) || url.search || url.hash || url.username || url.password) return privateError(404);
    const policy = await privatePolicy(env);
    if (!policy) return privateError(404);
    const authorization = await privateAuthorized(request, policy);
    if (!authorization || !await privateAuthorizationCurrent(authorization, policy, env)) return privateError(404);
    if (!validPrivateHeaders(request.headers, policy.alias.id)) return privateError(400);

    // Target/account/credential resolution happens only inside this authenticated boundary.
    const upstream = await privateUpstream(env, policy);
    if (!upstream || !await privateAuthorizationCurrent(authorization, policy, env) || upstream.expiresAt <= Date.now() + 30_000) return privateError(404);
    const { id, name } = policy.alias;
    if (discovery) {
      if (request.body) return privateError(400);
      const reasoning = policy.alias.supportedReasoningEfforts ? { supportedReasoningEfforts: policy.alias.supportedReasoningEfforts } : {};
      if (url.pathname.endsWith("/models")) return privateJson({ object: "list", data: [{ id, object: "model", owned_by: "private", display_name: name, capabilities: ["llm.responses"], ...reasoning }] });
      return privateJson({ version: "clawrouter.client-catalog.v1", providers: [{
        id: "private", displayName: name, allowed: true, executable: true, openaiCompatible: true,
        nativeBaseUrl: "/v1/native/private", routes: [{ endpoint: "responses", methods: ["POST"], path: "/v1/responses", requestFormat: "openai.responses", responseFormat: "openai.responses", streaming: "sse" }],
        models: [{ id, displayName: name, upstream: id, capabilities: ["llm.responses"], pricing_ref: null, pricing: null, ...reasoning }],
      }] });
    }
    if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(request.headers.get("content-type") ?? "")) return privateError(400);
    let body: unknown;
    try { body = await boundedJson(request.body, 1024 * 1024, AbortSignal.any([request.signal, AbortSignal.timeout(30_000)])); } catch { return privateError(400); }
    if (!record(body) || body.model !== id || Object.keys(body).some((key) => !requestFields.has(key))
      || body.store !== false || body.background === true || (body.background !== undefined && body.background !== false)
      || (body.stream !== undefined && typeof body.stream !== "boolean") || !validPrivateProtocolBody(body)
      || (body.max_output_tokens !== undefined && (typeof body.max_output_tokens !== "number" || !Number.isSafeInteger(body.max_output_tokens) || body.max_output_tokens <= 0))
      || !validPrivateHeaders(request.headers, id, body)) return privateError(400);
    try {
      const affinity = request.headers.get("x-codex-turn-state");
      if (affinity !== null) inspectPrivateOpaque(affinity, id, [upstream.target, upstream.accessToken, upstream.accountId]);
    } catch { return privateError(400); }

    // Re-read both bindings after a potentially slow upload; no authorization/secret cache or retry.
    const current = await privatePolicy(env);
    if (!current || JSON.stringify(current) !== JSON.stringify(policy)) return privateError(404);
    const refreshed = await privateAuthorized(request, current);
    if (!refreshed || !await privateAuthorizationCurrent(refreshed, current, env)) return privateError(404);
    const freshUpstream = await privateUpstream(env, current);
    if (!freshUpstream || JSON.stringify(freshUpstream) !== JSON.stringify(upstream)
      || !await privateAuthorizationCurrent(refreshed, current, env) || freshUpstream.expiresAt <= Date.now() + 30_000) return privateError(404);
    const ignoredMaxOutputTokens = body.max_output_tokens !== undefined;
    // A fixed disclosure must not echo a runtime identity, including on transport failure.
    if (ignoredMaxOutputTokens && [upstream.target, upstream.accountId, upstream.accessToken].some((secret) => "x-clawrouter-ignored-parameters: max_output_tokens".includes(secret))) return new Response(null, { status: 502 });
    const headers = new Headers({ "content-type": "application/json", accept: body.stream === true ? "text/event-stream" : "application/json", "accept-encoding": "identity" });
    forwardPrivateHeaders(request.headers, headers, id, upstream.target);
    headers.set("authorization", `Bearer ${upstream.accessToken}`);
    headers.set("chatgpt-account-id", upstream.accountId);
    // Do not manufacture originator, client metadata, review, or attestation evidence.
    const abort = new AbortController();
    const signal = AbortSignal.any([request.signal, abort.signal, AbortSignal.timeout(600_000)]);
    try {
      const response = await fetch(upstreamUrl, {
        method: "POST", headers, body: JSON.stringify(privateSubscriptionBody(body, upstream.target)), redirect: "manual", signal,
      });
      return await containResponse(response, id, upstream, body.stream === true, signal, () => abort.abort(), ignoredMaxOutputTokens);
    } catch {
      abort.abort();
      return privateError(502, ignoredMaxOutputTokens);
    }
  } catch {
    // Never pass private exceptions through the public logger or error formatter.
    return privateError(404);
  }
}
