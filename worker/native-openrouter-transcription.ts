import { jsonBodyBytes } from "./json-body.ts";
import { nativeJsonResponse, nativeResponseLease, type NativeResponse } from "./native-response.ts";
import { openRouterTranscriptionModels, prepareOpenRouterTranscription, readOpenRouterTranscription } from "./openrouter-transcription.ts";
import type { ProxySelection } from "./proxy-selection.ts";
import { HttpError } from "./utils.ts";

const requestLimit = 24 * 1024 * 1024;
const format = "openrouter.audio_transcription";

// Common dispatch owns authenticated expanded JSON admission, original grants
// and settlement. This leaf validates native JSON, never a multipart fallback.
export function prepareNativeOpenRouterTranscription(selection: ProxySelection): NativeResponse | undefined {
  const { provider, endpoint, model, body } = selection;
  if (endpoint.request_format !== format) return;
  if (provider.id !== "openrouter" || provider.base_urls.default !== "https://openrouter.ai/api"
    || !model || !openRouterTranscriptionModels.some(value => value === model.upstream)
    || !model.capabilities.includes("audio.transcription") || selection.capability !== "audio.transcription"
    || selection.method !== "POST" || endpoint.method !== "POST" || endpoint.response_format !== format
    || endpoint.path !== "/v1/audio/transcriptions" || endpoint.upstreamPath !== undefined
    || endpoint.path_params.length || Object.keys(selection.pathParams).length || Object.keys(endpoint.query).length
    || selection.nativeQuery !== undefined || endpoint.streaming || endpoint.websocket || endpoint.lifecycle
    || endpoint.responsesLifecycle || endpoint.modelPassthrough || endpoint.requestPricing) {
    throw new HttpError(400, "invalid_native_openrouter_transcription_route", "OpenRouter transcription requires its selected native JSON model and route");
  }
  const upstreamModel = model.upstream;
  let path: string;
  try {
    if (jsonBodyBytes(body) > requestLimit) throw new Error("size");
    // Do not retain the codec's cloned input or replace the common outbound body.
    path = prepareOpenRouterTranscription(upstreamModel, body).path;
  } catch {
    throw new HttpError(400, "invalid_native_openrouter_transcription_request", "OpenRouter transcription requires bounded native JSON audio");
  }
  return {
    origin: "https://openrouter.ai", path,
    // BodyLease charges 16 MiB; a 24 MiB request adds at most 48 MiB.
    acquire: () => nativeResponseLease(8 * 1024 * 1024),
    async read(response, signal) {
      const encoding = response.headers.get("content-encoding"), mime = response.headers.get("content-type");
      if (!mime || !/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?$/i.test(mime.trim())
        || encoding !== null && encoding.trim().toLowerCase() !== "identity") {
        void response.body?.cancel().catch(() => undefined); invalid();
      }
      if (encoding !== null) {
        if (response.redirected || response.status !== 200) { void response.body?.cancel().catch(() => undefined); invalid(); }
        const headers = new Headers(response.headers); headers.delete("content-encoding");
        response = new Response(response.body, { status: response.status, headers });
      }
      const result = await readOpenRouterTranscription(response, upstreamModel, signal);
      // The actual consumer rejects present null error/model fields too. The
      // codec's compatibility handling must not expose an unusable native result.
      if (Object.hasOwn(result.body, "error") || Object.hasOwn(result.body, "model") && result.body.model !== upstreamModel) invalid();
      const tokens = result.inputTokens === null && result.outputTokens === null && result.totalTokens === null ? null : {
        input: result.inputTokens, output: result.outputTokens, total: result.totalTokens,
        cached: null, cacheWrite: null, cacheWrite5m: null, cacheWrite1h: null,
      };
      const headers = new Headers({ "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" });
      if (result.generationId !== null) headers.set("x-generation-id", result.generationId);
      // Empty/whitespace text is successful silence. Native cost/seconds and the
      // bounded generation header are diagnostics, never a tariff or job grant.
      return { response: nativeJsonResponse(result.body, new Response(null, { headers })), usage: { tokens, outcome: "success" } };
    },
  };
}

function invalid(): never { throw new Error("invalid_native_openrouter_transcription_response"); }
