import { jsonBodyBytes, jsonBodyStream, mediaJsonBody } from "./json-body.ts";
import { applyProxyQuery, applyStreamingQuery, type ProxyQuery } from "./proxy-query.ts";
import { applyTransportHeaders, transformTransportBody } from "./provider-auth.ts";
import { resolveTemplate } from "./provider-templates.ts";
import { copyRequestHeaders, upstreamPath, type UpstreamAuth } from "./providers.ts";
import type { ProxySelection } from "./proxy-selection.ts";
import type { Env } from "./types.ts";
import { maxJsonBodyBytes } from "./utils.ts";

export function prepareUpstreamRequest(
  request: Request, env: Env, selection: ProxySelection, queryInput: ProxyQuery,
  upstream: UpstreamAuth, transport: "http" | "websocket",
) {
  const headers = new Headers(upstream.headers);
  copyRequestHeaders(request.headers, selection.provider, selection.endpoint, headers, env);
  applyTransportHeaders(headers, upstream.transport, upstream.grant);
  const path = upstreamPath(selection.provider, selection.endpoint, selection.pathParams, env, upstream);
  const url = new URL(`${upstream.baseUrl.replace(/\/$/, "")}${path}`);
  upstream.query.forEach((value, name) => url.searchParams.set(name, value));
  for (const [name, value] of Object.entries(selection.endpoint.query)) url.searchParams.set(name, resolveTemplate(selection.provider, value, env));
  // Continuations and controls reconstruct the configured route, not the
  // incidental query of one create call. Credential/config changes still pin.
  const configuredOwnerUrl = new URL(url);
  applyProxyQuery(url.searchParams, queryInput, upstream.query.keys());
  applyStreamingQuery(url.searchParams, selection.endpoint);
  const body = transformTransportBody(upstream.transport, selection.body);
  // The 32 MB media envelope must not coexist with whole-document transport
  // copies in the Worker's 128 MB isolate. Unsigned bodies carrying media
  // splice it in as raw chunks; other Claude bodies above 8 MiB use the
  // chunked serializer. WebSocket creates send their own frame instead.
  const signed = selection.provider.auth.schemes.some(scheme => scheme.type === "sig_v4");
  const bodyless = ["GET", "HEAD"].includes(selection.method) || transport === "websocket";
  const media = bodyless || signed ? null : mediaJsonBody(body);
  const bytes = media ? media.bytes : !bodyless && !signed && selection.endpoint.request_format === "anthropic.messages" ? jsonBodyBytes(body) : 0;
  const streamBody = media !== null || bytes > maxJsonBodyBytes;
  const requestBody = bodyless ? undefined : media ? media.stream().pipeThrough(new FixedLengthStream(bytes)) : streamBody ? jsonBodyStream(body).pipeThrough(new FixedLengthStream(bytes)) : JSON.stringify(body);
  return { headers, url, configuredOwnerUrl, requestBody, streamBody };
}
