import { jsonBodyBytes } from "./json-body.ts";
import { mediaObject } from "./managed-media-json.ts";
import { observeMiniMaxMusic, prepareMiniMaxMusic } from "./minimax-music.ts";
import { readNativeJson } from "./native-json.ts";
import { nativeJsonResponse, nativeResponseLease, type NativeResponse } from "./native-response.ts";
import type { ProxySelection } from "./proxy-selection.ts";
import { HttpError } from "./utils.ts";

const audioLimit = 4 * 1024 * 1024, responseLimit = audioLimit * 2 + 65536;

// Common dispatch must separately qualify original global music authority.
// A speech grant, OAuth/Plan/CN credential or this leaf supplies no entitlement.
export function prepareNativeMiniMaxMusic(selection: ProxySelection): NativeResponse | undefined {
  const { provider, endpoint, model, body } = selection;
  if (endpoint.request_format !== "minimax.music") return;
  if (provider.id !== "minimax" || provider.base_urls.default !== "https://api.minimax.io"
    || selection.capability !== "music.generate" || !model || !model.capabilities.includes("music.generate")
    || !["music-2.6", "music-2.6-free"].includes(model.upstream)
    || selection.method !== "POST" || endpoint.method !== "POST" || endpoint.path !== "/v1/music_generation"
    || endpoint.response_format !== "minimax.music" || endpoint.upstreamPath !== undefined
    || endpoint.path_params.length || Object.keys(selection.pathParams).length || Object.keys(endpoint.query).length
    || selection.nativeQuery !== undefined || endpoint.streaming || endpoint.websocket || endpoint.lifecycle
    || endpoint.responsesLifecycle || endpoint.modelPassthrough || endpoint.requestPricing) {
    throw new HttpError(400, "invalid_native_minimax_music_route", "MiniMax music requires its selected model and qualified global unary path");
  }
  let prepared;
  try {
    if (jsonBodyBytes(body) > 65536 || !mediaObject(body) || body.model !== model.upstream || body.stream !== false) invalid();
    prepared = prepareMiniMaxMusic("global", body);
  } catch {
    throw new HttpError(400, "invalid_native_minimax_music_request", "MiniMax music input must match its frozen native model and unary hex mode");
  }
  return {
    origin: prepared.origin, path: prepared.path,
    // BodyLease charges 64 MiB for JSON, hex and decoded-audio copies.
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
        // Bound full-file hex before the codec allocates decoded bytes.
        if (!mediaObject(value) || !mediaObject(value.data) || typeof value.data.audio !== "string"
          || value.data.audio.length > audioLimit * 2 + 2 || value.data.audio.trim().length > audioLimit * 2) invalid();
        for (const envelope of [value, value.data]) {
          if (["audio_url", "audio_base64", "file_id", "file", "url", "task_id"].some(key => Object.hasOwn(envelope, key))) invalid();
        }
        const observed = observeMiniMaxMusic([value], prepared, true);
        if (observed.audio.length > audioLimit) invalid();
        return { response: nativeJsonResponse(observed.frames[0], new Response(null, { headers: {
          "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff",
        } })), usage: { tokens: null, outcome: "success" as const } };
      }, invalid);
    },
  };
}

function invalid(): never { throw new Error("invalid_native_minimax_music_response"); }

