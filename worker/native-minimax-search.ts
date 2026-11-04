import { jsonBodyBytes } from "./json-body.ts";
import { mediaObject } from "./managed-media-json.ts";
import { miniMaxSearchOrigins, miniMaxSearchPath, prepareMiniMaxSearch, readMiniMaxSearch } from "./minimax-search.ts";
import { nativeJsonResponse, nativeResponseLease, type NativeResponse } from "./native-response.ts";
import type { ProxySelection } from "./proxy-selection.ts";
import { HttpError } from "./utils.ts";

// Common dispatch must supply the destination after qualifying the original
// regional TokenPlan Search grant. This scalar is not proof of entitlement.
// Messages OAuth, native speech permission and manifest defaults cannot supply it.
export function prepareNativeMiniMaxSearch(
  selection: ProxySelection,
  input: Readonly<{ origin: "https://api.minimax.io" | "https://api.minimaxi.com" }>,
): NativeResponse | undefined {
  const { provider, endpoint, model, body } = selection;
  if (endpoint.request_format !== "minimax.search") return;
  if (provider.id !== "minimax" || selection.capability !== "search.web" || model !== null
    || selection.method !== "POST" || endpoint.method !== "POST" || endpoint.path !== miniMaxSearchPath
    || endpoint.response_format !== "minimax.search" || endpoint.upstreamPath !== undefined
    || endpoint.path_params.length || Object.keys(selection.pathParams).length || Object.keys(endpoint.query).length
    || selection.nativeQuery !== undefined || endpoint.streaming || endpoint.websocket || endpoint.lifecycle
    || endpoint.responsesLifecycle || endpoint.modelPassthrough || endpoint.requestPricing
    || input?.origin !== miniMaxSearchOrigins.global && input?.origin !== miniMaxSearchOrigins.cn) {
    throw new HttpError(400, "invalid_native_minimax_search_route", "MiniMax search requires its model-less native route and qualified original plan destination");
  }
  const origin = input.origin;
  try {
    if (jsonBodyBytes(body) > 16 * 1024) throw new Error("size");
    prepareMiniMaxSearch(origin === miniMaxSearchOrigins.global ? "global" : "cn", body);
  } catch {
    throw new HttpError(400, "invalid_native_minimax_search_request", "MiniMax search requires only a bounded native query");
  }
  // Retain only destination scalars, never the selected query or prepared body.
  return {
    origin, path: miniMaxSearchPath,
    // Charges 16 MiB in the existing pool. Common delivery owns release through
    // downstream EOF/cancel, including after this reader has buffered upstream.
    acquire: () => nativeResponseLease(8 * 1024 * 1024),
    async read(response, signal) {
      const encoding = response.headers.get("content-encoding"), mime = response.headers.get("content-type");
      if (response.status !== 200 || response.redirected || !mime
        || !/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?$/i.test(mime.trim())
        || encoding !== null && encoding.trim().toLowerCase() !== "identity") {
        void response.body?.cancel().catch(() => undefined); invalid();
      }
      if (encoding !== null) {
        const headers = new Headers(response.headers); headers.delete("content-encoding");
        response = new Response(response.body, { status: response.status, headers });
      }
      try {
        // Ten selects only the codec's consumer projection. Native rows (up to
        // 100) are retained; truncation alone is not a malformed response.
        const observed = await readMiniMaxSearch(response, 10, signal);
        // The codec filters unsafe destinations from its projection but retains
        // them in body. Validate every raw row before returning that native body.
        if (!Array.isArray(observed.body.organic)) invalid();
        for (const row of observed.body.organic) {
          if (!mediaObject(row) || typeof row.link !== "string") invalid();
          const url = new URL(row.link);
          if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) invalid();
        }
        return { response: nativeJsonResponse(observed.body, new Response(null, { headers: {
          "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff",
        } })), usage: { tokens: null, outcome: "success" as const } };
      } catch { invalid(); }
    },
  };
}

function invalid(): never { throw new Error("invalid_native_minimax_search_response"); }
