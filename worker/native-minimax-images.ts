import { jsonBodyBytes } from "./json-body.ts";
import { canonicalMediaBase64, mediaObject } from "./managed-media-json.ts";
import { miniMaxImageModel, miniMaxImagePath, observeMiniMaxImage, prepareMiniMaxImage } from "./minimax-images.ts";
import { readNativeJson } from "./native-json.ts";
import { nativeJsonResponse, nativeResponseLease, type NativeResponse } from "./native-response.ts";
import type { ProxySelection } from "./proxy-selection.ts";
import { HttpError } from "./utils.ts";

const jsonLimit = 8 * 1024 * 1024, outputLimit = 4 * 1024 * 1024;

// Common dispatch must separately qualify the original native image operation.
// A speech grant, API-key name or Bearer header supplies no image entitlement.
export function prepareNativeMiniMaxImage(selection: ProxySelection): NativeResponse | undefined {
  const { provider, endpoint, model, body } = selection;
  if (endpoint.request_format !== "minimax.images") return;
  if (provider.id !== "minimax" || provider.base_urls.default !== "https://api.minimax.io"
    || selection.capability !== "image.generate" || !model || model.upstream !== miniMaxImageModel
    || !model.capabilities.includes("image.generate") || selection.method !== "POST" || endpoint.method !== "POST"
    || endpoint.path !== miniMaxImagePath || endpoint.response_format !== "minimax.images"
    || endpoint.upstreamPath !== undefined || endpoint.path_params.length || Object.keys(selection.pathParams).length
    || Object.keys(endpoint.query).length || selection.nativeQuery !== undefined || endpoint.streaming || endpoint.websocket
    || endpoint.lifecycle || endpoint.responsesLifecycle || endpoint.modelPassthrough || endpoint.requestPricing) {
    throw new HttpError(400, "invalid_native_minimax_image_route", "MiniMax images require the frozen model and qualified global unary path");
  }
  let prepared;
  try {
    if (jsonBodyBytes(body) > 16 * 1024 || !mediaObject(body) || Object.hasOwn(body, "subject_reference")) invalid();
    prepared = prepareMiniMaxImage("global", body);
  } catch {
    throw new HttpError(400, "invalid_native_minimax_image_request", "MiniMax images require bounded prompt-only native JSON and explicit base64 output");
  }
  return {
    origin: prepared.origin, path: prepared.path,
    // BodyLease charges 64 MiB, alongside ingress, before dispatch through delivery.
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
      return readNativeJson(response, signal, jsonLimit, value => {
        if (!mediaObject(value) || !mediaObject(value.data) || Object.hasOwn(value.data, "image_urls")
          || !Array.isArray(value.data.image_base64) || value.data.image_base64.length > prepared.count) invalid();
        let bytes = 0;
        // Bound every canonical base64 string before the codec allocates images.
        for (const image of value.data.image_base64) {
          const encoded = canonicalMediaBase64(image, outputLimit, invalid);
          bytes += encoded.decodedBytes;
          if (image !== encoded.base64 || bytes > outputLimit) invalid();
        }
        const observed = observeMiniMaxImage(value, prepared, true);
        if (observed.delivery !== "complete") invalid();
        // Native JSON contains no image MIME. Do not infer one or expose binary output.
        return { response: nativeJsonResponse(observed.body, new Response(null, { headers: {
          "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff",
        } })), usage: { tokens: null, outcome: "success" as const } };
      }, invalid);
    },
  };
}

function invalid(): never { throw new Error("invalid_native_minimax_image_response"); }
