import { observeDeepSeekSearch, prepareDeepSeekSearch } from "./deepseek-search.ts";
import { jsonBodyBytes } from "./json-body.ts";
import { mediaObject } from "./managed-media-json.ts";
import { readNativeJson } from "./native-json.ts";
import { nativeJsonResponse, nativeResponseLease, type NativeResponse, type ValidatedNativeUsage } from "./native-response.ts";
import { deepSeekSearchCost } from "./pricing.ts";
import { selectRequestTariff } from "./request-tariff.ts";
import type { ProxySelection } from "./proxy-selection.ts";
import { HttpError } from "./utils.ts";

export function prepareNativeDeepSeekSearch(selection: ProxySelection): NativeResponse | undefined {
  const { provider, endpoint, model, body } = selection;
  if (endpoint.request_format !== "deepseek.search") return;
  if (provider.id !== "deepseek" || provider.base_urls.default !== "https://api.deepseek.com"
    || selection.capability !== "search.web" || model !== null || selection.method !== "POST" || endpoint.method !== "POST"
    || endpoint.path !== "/v1/tools/search" || endpoint.response_format !== "deepseek.search" || endpoint.upstreamPath !== undefined
    || endpoint.path_params.length || Object.keys(selection.pathParams).length || Object.keys(endpoint.query).length
    || selection.nativeQuery !== undefined || endpoint.streaming || endpoint.websocket || endpoint.lifecycle
    || endpoint.responsesLifecycle || endpoint.modelPassthrough) {
    throw new HttpError(400, "invalid_native_deepseek_search_route", "DeepSeek search requires its model-less unary native route");
  }
  let prepared;
  try {
    // The frozen client sends explicit options; upstream's default count is 10,
    // while the codec's default is 5. Never change the selected request body.
    if (!mediaObject(body) || !Object.hasOwn(body, "count") || typeof body.count !== "number"
      || body.need_content !== false || jsonBodyBytes(body) > 4096) invalid();
    prepared = prepareDeepSeekSearch(body);
  } catch {
    throw new HttpError(400, "invalid_native_deepseek_search_request", "DeepSeek search requires an explicit bounded query, count and content option");
  }
  const tariff = selectRequestTariff(endpoint, body);
  if (tariff && tariff.kind !== "deepseek_search") throw new HttpError(503, "request_tariff_unqualified", "native Search requires its qualified operation tariff");
  return {
    origin: "https://api.deepseek.com", path: prepared.path, tariff,
    acquire: () => nativeResponseLease(8 * 1024 * 1024),
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
      return readNativeJson(response, signal, 1024 * 1024, value => {
        // The codec validates the requested slice. Refuse any excess tail or
        // filtered destination so every delivered row has passed observation.
        if (!mediaObject(value) || !Array.isArray(value.results) || value.results.length > prepared.body.count) invalid();
        const observed = observeDeepSeekSearch(value, prepared, true);
        if (observed.omittedResults) invalid();
        const usage: ValidatedNativeUsage = { tokens: null, outcome: "success" };
        if (tariff) {
          usage.nativeRequestUsage = Object.freeze({ operation: "deepseek.search", pricingVersion: tariff.version, billableRequests: observed.billableRequests });
          usage.requestCostReceipt = deepSeekSearchCost(tariff.pricing, usage) ?? undefined;
        }
        return { response: nativeJsonResponse(observed.body, new Response(null, { headers: {
          "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff",
        } })), usage };
      }, invalid);
    },
  };
}

function invalid(): never { throw new Error("invalid_native_deepseek_search_response"); }
