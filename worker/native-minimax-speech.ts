import { jsonBodyBytes } from "./json-body.ts";
import { mediaObject } from "./managed-media-json.ts";
import { observeMiniMaxSpeech, prepareMiniMaxSpeech } from "./minimax-speech.ts";
import { readNativeJson } from "./native-json.ts";
import { nativeJsonResponse, nativeResponseLease, type NativeResponse } from "./native-response.ts";
import type { ProxySelection } from "./proxy-selection.ts";
import { HttpError } from "./utils.ts";

const audioLimit = 4 * 1024 * 1024, responseLimit = audioLimit * 2 + 65536;

// This leaf establishes no native-media entitlement. Common dispatch must
// qualify the original global API-key grant; OAuth/Plan/CN substitution is closed.
export function prepareNativeMiniMaxSpeech(selection: ProxySelection): NativeResponse | undefined {
  const { provider, endpoint, model, body } = selection;
  if (endpoint.request_format !== "minimax.speech") return;
  if (provider.id !== "minimax" || provider.base_urls.default !== "https://api.minimax.io"
    || selection.capability !== "audio.speech" || !model || !model.capabilities.includes("audio.speech")
    || selection.method !== "POST" || endpoint.method !== "POST" || endpoint.path !== "/v1/t2a_v2"
    || endpoint.response_format !== "minimax.speech" || endpoint.upstreamPath !== undefined
    || endpoint.path_params.length || Object.keys(selection.pathParams).length || Object.keys(endpoint.query).length
    || selection.nativeQuery !== undefined || endpoint.streaming || endpoint.websocket || endpoint.lifecycle
    || endpoint.responsesLifecycle || endpoint.modelPassthrough || endpoint.requestPricing) {
    throw new HttpError(400, "invalid_native_minimax_speech_route", "MiniMax speech requires its selected model and qualified global unary path");
  }
  let prepared;
  try {
    if (jsonBodyBytes(body) > 65536) invalid();
    prepared = prepareMiniMaxSpeech(model.upstream, body);
  } catch {
    throw new HttpError(400, "invalid_native_minimax_speech_request", "MiniMax speech input must match its frozen native model and hex mode");
  }
  return {
    origin: "https://api.minimax.io", path: prepared.path,
    // BodyLease charges 64 MiB for the JSON, hex and decoded-audio copies.
    acquire: () => nativeResponseLease(32 * 1024 * 1024),
    async read(response, signal) {
      const encoding = response.headers.get("content-encoding"), mime = response.headers.get("content-type");
      if (response.status !== 200 || response.redirected
        || !mime || !/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?$/i.test(mime.trim())
        || encoding !== null && encoding.trim().toLowerCase() !== "identity") {
        void response.body?.cancel().catch(() => undefined); invalid();
      }
      if (encoding !== null) {
        const headers = new Headers(response.headers); headers.delete("content-encoding");
        response = new Response(response.body, { status: response.status, headers });
      }
      return readNativeJson(response, signal, responseLimit, value => {
        // Bound hex before the codec allocates decoded bytes. This leaf is
        // deliberately smaller than the standalone codec's 8 MiB audio ceiling.
        if (!mediaObject(value) || !mediaObject(value.data) || typeof value.data.audio !== "string"
          || value.data.audio.length > audioLimit * 2 + 4096 || value.data.audio.trim().length > audioLimit * 2) invalid();
        const observed = observeMiniMaxSpeech(value, prepared, true);
        if (observed.audio.length > audioLimit) invalid();
        return { response: nativeJsonResponse(observed.body, new Response(null, { headers: {
          "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff",
        } })), usage: { tokens: null, outcome: "success" as const } };
      }, invalid);
    },
  };
}

function invalid(): never { throw new Error("invalid_native_minimax_speech_response"); }
