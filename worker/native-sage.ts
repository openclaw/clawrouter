import { readNativeJson } from "./native-json.ts";
import { boundedDecisionJson, boundedDecisionResponse, decisionResponseBytes } from "./native-decision-json.ts";
import { nativeJsonResponse, nativeResponseLease, type NativeResponse } from "./native-response.ts";
import { decisionRecord } from "./provider-decision-wire.ts";
import { decodeSageResponse, prepareSageRequest } from "./provider-sage.ts";
import type { ProxySelection } from "./proxy-selection.ts";
import { HttpError } from "./utils.ts";

// The common owner selects the model/grant before calling this pure wrapper.
export function prepareNativeSage(selection: ProxySelection): NativeResponse | undefined {
  const { provider, endpoint, model } = selection;
  if (endpoint.request_format !== "levanto.sage" && endpoint.request_format !== "levanto.sage_batch") return;
  const batch = endpoint.request_format === "levanto.sage_batch";
  const capability = batch ? "llm.decisions.batch" : "llm.decisions";
  const endpointId = batch ? "decisions_batch" : "decisions", path = batch ? "/decide/batch" : "/decide";
  const facts = model?.nativeCapabilities?.endpoints?.[endpointId];
  if (provider.id !== "levanto" || provider.base_urls.default !== "https://sage.levanto.ai"
    || !model || model.id !== "levanto/levanto-sage-2" || model.upstream !== "levanto-sage-2"
    || !model.capabilities.includes(capability) || selection.capability !== capability
    || !provider.capabilities.some(item => item.id === capability && item.endpoint === endpoint.id && item.methods.includes("POST"))
    || selection.method !== "POST" || endpoint.method !== "POST" || endpoint.id !== endpointId
    || endpoint.path !== path || endpoint.response_format !== endpoint.request_format
    // The compiler preserves omitted metadata for old singular declarations.
    // Only explicitly qualified text/list metadata admits the batch route.
    || batch && (facts?.inference?.decision?.protocol !== "levanto-sage" || facts.inference.chat === true
      || facts.input?.length !== 2 || !facts.input.includes("text") || !facts.input.includes("json")
      || facts.inference.decision.limits?.image || facts.inference.decision.questions.choice?.maxImageOptions !== undefined)
    || endpoint.upstreamPath !== undefined || endpoint.path_params.length || Object.keys(selection.pathParams).length
    || Object.keys(endpoint.query).length || selection.nativeQuery !== undefined || endpoint.streaming || endpoint.websocket
    || endpoint.lifecycle || endpoint.responsesLifecycle || endpoint.modelPassthrough || endpoint.requestPricing) {
    throw new HttpError(400, "invalid_native_sage_route", "Sage requires its selected qualified native decision route");
  }
  let prepared;
  try {
    const body = decisionRecord(selection.body);
    if (!body || Object.hasOwn(body, "model") && body.model !== model.id && body.model !== model.upstream) throw new Error("model");
    const { model: _model, ...native } = body;
    prepared = prepareSageRequest(native, batch);
    // Both qualified routes are text/list only; native image input stays closed.
    const contents = "requests" in prepared ? prepared.requests.map(group => group.content) : [prepared.content];
    if (contents.some(content => typeof content !== "string" && content.kind === "image")) throw new Error("input");
  } catch {
    throw new HttpError(400, "invalid_native_sage_request", "Sage requires valid native text or JSON decision input");
  }
  selection.body = { ...prepared };
  return {
    origin: "https://sage.levanto.ai", path,
    acquire: () => nativeResponseLease(32 * 1024 * 1024),
    async read(response, signal) {
      return readNativeJson(boundedDecisionResponse(response, signal, invalidResponse), signal, decisionResponseBytes, value => {
        const envelope = decisionRecord(value);
        if (!envelope || Object.hasOwn(envelope, "error") || !boundedDecisionJson(value)) invalidResponse();
        const decoded = decodeSageResponse(value, prepared);
        if (!decoded) invalidResponse();
        return { response: nativeJsonResponse(decoded.response, new Response(null, { headers: {
          "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff",
        } })), usage: decoded.inspection };
      }, invalidResponse);
    },
  };
}

function invalidResponse(): never { throw new HttpError(502, "invalid_native_sage_response", "Sage did not return a complete valid native decision"); }
