import { readNativeJson } from "./native-json.ts";
import { boundedDecisionJson, boundedDecisionResponse, decisionResponseBytes } from "./native-decision-json.ts";
import { nativeJsonResponse, nativeResponseLease, type NativeResponse } from "./native-response.ts";
import { decisionRecord } from "./provider-decision-wire.ts";
import { decodeSystemOneResponse, prepareSystemOneRequest } from "./provider-systemone.ts";
import type { ProxySelection } from "./proxy-selection.ts";
import { HttpError } from "./utils.ts";

export function prepareNativeSystemOne(selection: ProxySelection): NativeResponse | undefined {
  const { provider, endpoint, model } = selection;
  const product = endpoint.request_format === "liquid.systemone" ? "liquid-ai"
    : endpoint.request_format === "typesafe.systemone" ? "typesafe" : undefined;
  if (!product) return;
  const upstream = product === "liquid-ai" ? "d1.1" : "jev-latest";
  const base = product === "liquid-ai" ? "https://api.liquid.ai/decisions/v1" : "https://api.typesafe.ai/v1";
  if (provider.id !== product || provider.base_urls.default !== base || !model
    || model.id !== `${product}/${upstream}` || model.upstream !== upstream || !model.capabilities.includes("llm.decisions")
    || selection.capability !== "llm.decisions"
    || !provider.capabilities.some(item => item.id === "llm.decisions" && item.endpoint === endpoint.id && item.methods.includes("POST"))
    || selection.method !== "POST" || endpoint.method !== "POST" || endpoint.id !== "decisions" || endpoint.path !== "/systemone"
    || endpoint.response_format !== endpoint.request_format || endpoint.upstreamPath !== undefined
    || endpoint.path_params.length || Object.keys(selection.pathParams).length || Object.keys(endpoint.query).length
    || selection.nativeQuery !== undefined || endpoint.streaming || endpoint.websocket || endpoint.lifecycle
    || endpoint.responsesLifecycle || endpoint.modelPassthrough || endpoint.requestPricing) {
    throw new HttpError(400, "invalid_native_systemone_route", "SystemOne requires the selected Liquid or TypeSafe native decision route");
  }
  let prepared;
  try {
    const body = decisionRecord(selection.body);
    if (!body || Object.hasOwn(body, "images") || Object.hasOwn(body, "assets")) throw new Error("images");
    prepared = prepareSystemOneRequest(body, upstream, product);
  } catch {
    throw new HttpError(400, "invalid_native_systemone_request", "SystemOne requires valid native text or JSON decision input");
  }
  selection.body = { ...prepared };
  return {
    origin: product === "liquid-ai" ? "https://api.liquid.ai" : "https://api.typesafe.ai",
    path: product === "liquid-ai" ? "/decisions/v1/systemone" : "/v1/systemone",
    acquire: () => nativeResponseLease(32 * 1024 * 1024),
    async read(response, signal) {
      return readNativeJson(boundedDecisionResponse(response, signal, invalidResponse), signal, decisionResponseBytes, value => {
        const envelope = decisionRecord(value);
        if (!envelope || Object.hasOwn(envelope, "error") || !boundedDecisionJson(value)) invalidResponse();
        const decoded = decodeSystemOneResponse(value, prepared, product);
        if (!decoded) invalidResponse();
        return { response: nativeJsonResponse(decoded.response, new Response(null, { headers: {
          "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff",
        } })), usage: decoded.inspection };
      }, invalidResponse);
    },
  };
}

function invalidResponse(): never { throw new HttpError(502, "invalid_native_systemone_response", "SystemOne did not return a complete valid native decision"); }
