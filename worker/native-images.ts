import { readNativeJson } from "./native-json.ts";
import { nativeJsonResponse, nativeResponseLease, type NativeResponse } from "./native-response.ts";
import { imageRequestCost } from "./pricing.ts";
import type { ProxySelection } from "./proxy-selection.ts";
import { nativeImageMode, selectRequestTariff } from "./request-tariff.ts";
import { errorResponse, HttpError } from "./utils.ts";
import { observeXaiImage, prepareXaiImage } from "./xai-images.ts";

export function prepareNativeImage(selection: ProxySelection): NativeResponse | undefined {
  const mode = nativeImageMode(selection.endpoint.request_format);
  if (!mode) return;
  const { endpoint, model } = selection;
  if (!model || selection.capability !== "image.generate" || selection.method !== "POST"
    || endpoint.path !== `/v1/images/${mode === "generate" ? "generations" : "edits"}` || endpoint.response_format !== "xai.images"
    || endpoint.streaming || endpoint.lifecycle || endpoint.responsesLifecycle || endpoint.websocket || endpoint.modelPassthrough)
    throw new HttpError(400, "invalid_native_image_route", "a qualified native image model and route are required");
  let prepared;
  try { prepared = prepareXaiImage(model.upstream, mode, selection.body); }
  catch { throw new HttpError(400, "invalid_native_image_request", "image input does not match the selected native model contract"); }
  const tariff = selectRequestTariff(endpoint, selection.body, prepared);
  if (tariff && tariff.kind !== "image_request") throw new HttpError(503, "request_tariff_unqualified", "native images require a qualified image tariff");
  return {
    origin: "https://api.x.ai", path: prepared.path, tariff,
    // Shared capacity includes bounded JSON, decoded images and serialization.
    // Acquisition happens before paid dispatch and lasts through delivery.
    acquire: () => nativeResponseLease(40 * 1024 * 1024),
    async read(response, signal) {
      return readNativeJson(response, signal, 24 * 1024 * 1024, original => {
        const receipt = tariff ? imageRequestCost(tariff.pricing, tariff.selection, original, true) : null;
        const accounting = receipt ? { requestCostReceipt: receipt } : {};
        try {
          const observed = observeXaiImage(original, prepared, true);
          return { response: nativeJsonResponse(observed.body, response), usage: { tokens: null, outcome: "success" as const, ...accounting } };
        } catch {
          // A complete bill can be valid even when media cannot be delivered.
          // The receipt never authorizes partial output or a second paid POST.
          return { response: errorResponse("invalid_native_image_response", "upstream image output did not satisfy the native contract", 502),
            usage: { tokens: null, outcome: "provider_error" as const, ...accounting } };
        }
      }, () => { throw new Error("invalid_native_image_response"); });
    },
  };
}
