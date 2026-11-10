import { jsonBodyBytes, jsonBodyStream, mediaJsonBody } from "./json-body.ts";
import { prepareNativeRawDispatch } from "./native-raw-input.ts";
import { inlineMusicInput } from "./openrouter-music-runtime.ts";
import { applyProxyQuery, applyStreamingQuery, type ProxyQuery } from "./proxy-query.ts";
import { applyTransportHeaders, transformTransportBody } from "./provider-auth.ts";
import { resolveTemplate, PreparationAdmission, preparationHeader } from "./provider-templates.ts";
import { copyRequestHeaders, upstreamPath, type UpstreamAuth } from "./providers.ts";
import type { ProxySelection } from "./proxy-selection.ts";
import type { Env } from "./types.ts";
import { HttpError, maxJsonBodyBytes } from "./utils.ts";
import { abandonOwnedHttpUpload, adoptOwnedHttpUploadSource, checkOwnedHttpUpload, finishOwnedHttpUploadPreparation, pipeOwnedHttpUpload, type OwnedHttpUpload } from "./http-identity-owner.ts";
import { acceptOwnedHttpPreparation } from "./proxy.ts";

export function prepareUpstreamRequest(
  request: Request, env: Env, selection: ProxySelection, queryInput: ProxyQuery,
  upstream: UpstreamAuth, transport: "http" | "websocket", owner?: PreparationAdmission,
) {
  return prepareUpstreamFields(request, env, selection, queryInput, upstream, transport, owner);
}

// The only receiver is the named private attempt command in proxy.ts. Neither
// an async graph result nor a caller-supplied graph callback crosses this seam.
export function prepareOwnedUpstreamRequest(
  upload: OwnedHttpUpload, request: Request, env: Env, selection: ProxySelection, queryInput: ProxyQuery,
  upstream: UpstreamAuth, owner: PreparationAdmission,
): void {
  checkOwnedHttpUpload(upload);
  try {
    const prepared = prepareUpstreamFields(request, env, selection, queryInput, upstream, "http", owner, upload);
    acceptOwnedHttpPreparation(upload, prepared);
    finishOwnedHttpUploadPreparation(upload);
  } catch (error) {
    // Initiate cancellation before leaving preparation. The encompassing owner
    // joins the ORIGINAL pipe even when a later header/signing check throws.
    void abandonOwnedHttpUpload(upload);
    throw error;
  }
}

function prepareUpstreamFields(
  request: Request, env: Env, selection: ProxySelection, queryInput: ProxyQuery,
  upstream: UpstreamAuth, transport: "http" | "websocket", owner?: PreparationAdmission, upload?: OwnedHttpUpload,
) {
  owner?.headers(upstream.headers, true);
  const headers = new Headers(upstream.headers);
  copyRequestHeaders(request.headers, selection.provider, selection.endpoint, headers, env, owner);
  applyTransportHeaders(headers, upstream.transport, upstream.grant, owner);
  const path = upstreamPath(selection.provider, selection.endpoint, selection.pathParams, env, upstream, owner);
  owner?.url(upstream.baseUrl, path);
  const url = new URL(`${upstream.baseUrl.replace(/\/$/, "")}${path}`);
  upstream.query.forEach((value, name) => { owner?.urlQuery(url, name, value); url.searchParams.set(name, value); });
  for (const name in selection.endpoint.query) { const value = resolveTemplate(selection.provider, selection.endpoint.query[name], env, owner, 4096); owner?.urlQuery(url, name, value); url.searchParams.set(name, value); }
  // Continuations and controls reconstruct the configured route, not the
  // incidental query of one create call. Credential/config changes still pin.
  owner?.text(url.href, 16384);
  const configuredOwnerUrl = new URL(url);
  const admittedQuery = owner ? owner.proxyQuery(url, queryInput) : queryInput;
  applyProxyQuery(url.searchParams, admittedQuery, upstream.query.keys());
  if (selection.endpoint.streaming === "sse" && !url.searchParams.has("alt") && selection.endpoint.response_format === "google.stream_generate_content") owner?.urlQuery(url, "alt", "sse");
  applyStreamingQuery(url.searchParams, selection.endpoint);
  owner?.text(url.href, 16384);
  const music = inlineMusicInput(selection);
  if (music) {
    if (transport !== "http" || upstream.transport !== null || upstream.query.size
      || url.href !== "https://openrouter.ai/api/v1/chat/completions")
      throw new HttpError(400, "invalid_inline_music_destination", "inline music requires its original fixed HTTP destination");
    preparationHeader(headers, "content-type", "application/json", owner); preparationHeader(headers, "accept", "text/event-stream", owner);
    return { headers, url, configuredOwnerUrl, requestBody: music.transport(), streamBody: true };
  }
  const raw = prepareNativeRawDispatch(selection, url, headers, transport === "http" && upstream.transport === null);
  if (raw !== undefined) return { headers, url, configuredOwnerUrl, requestBody: raw, streamBody: false };
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
  let requestBody: string | ReadableStream<Uint8Array> | undefined;
  if (upload && streamBody && !bodyless) {
    const source = media ? media.stream() : jsonBodyStream(body);
    adoptOwnedHttpUploadSource(upload, source);
    const fixed = new FixedLengthStream(bytes);
    requestBody = pipeOwnedHttpUpload(upload, source, fixed);
  } else requestBody = bodyless ? undefined : media ? media.stream().pipeThrough(new FixedLengthStream(bytes)) : streamBody ? jsonBodyStream(body).pipeThrough(new FixedLengthStream(bytes)) : JSON.stringify(body);
  return { headers, url, configuredOwnerUrl, requestBody, streamBody };
}
