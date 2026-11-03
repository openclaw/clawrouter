import { nativeJsonResponse, nativeResponseLease, type NativeResponse } from "./native-response.ts";
import { BASETEN_SYSTEMONE_FORMAT, BASETEN_SYSTEMONE_MODELS, prepareBasetenSystemOneRequest, readBasetenSystemOneResponse } from "./provider-baseten-systemone.ts";
import type { ProxySelection } from "./proxy-selection.ts";
import { HttpError } from "./utils.ts";

// The native client encodes DecisionV2 before this boundary. The controller owns
// destination/credential checks, capacity lifetime, admission and settlement.
export function prepareNativeBasetenSystemOne(selection: ProxySelection): NativeResponse | undefined {
  const { provider, endpoint, model } = selection;
  if (endpoint.request_format !== BASETEN_SYSTEMONE_FORMAT) return;
  if (provider.id !== "baseten" || !model || !BASETEN_SYSTEMONE_MODELS.some(id => id === model.upstream)
    || model.id !== `baseten/${model.upstream}` || model.capabilities.length !== 1 || model.capabilities[0] !== "llm.decisions"
    || selection.capability !== "llm.decisions" || selection.method !== "POST" || endpoint.method !== "POST"
    || endpoint.response_format !== BASETEN_SYSTEMONE_FORMAT || endpoint.path !== "/systemone" || endpoint.upstreamPath
    || endpoint.streaming || endpoint.websocket || endpoint.modelPassthrough || endpoint.lifecycle || endpoint.responsesLifecycle
    || endpoint.path_params.length || Object.keys(selection.pathParams).length || Object.keys(endpoint.query).length)
    throw new HttpError(400, "invalid_native_baseten_systemone_route", "a qualified Baseten SystemOne model and route are required");
  let prepared;
  try { prepared = prepareBasetenSystemOneRequest(selection.body, model.upstream); }
  catch { throw new HttpError(400, "invalid_native_baseten_systemone_request", "Baseten SystemOne requires valid encoded native input"); }
  selection.body = { ...prepared };
  return {
    origin: "https://inference.baseten.co", path: "/v1/systemone",
    // Complete JSON is bounded to 1 MiB; reserve space for decoded/projected copies.
    acquire: () => nativeResponseLease(4 * 1024 * 1024),
    async read(response, signal) {
      const result = await readBasetenSystemOneResponse(response, prepared, signal);
      return { response: nativeJsonResponse(result.body, response), usage: result.usage };
    },
  };
}
