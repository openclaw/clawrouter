import { googleGroundedSearchModel, observeGoogleGroundedSearch, prepareGoogleGroundedSearch } from "./google-grounded-search.ts";
import { jsonBodyBytes } from "./json-body.ts";
import { mediaObject } from "./managed-media-json.ts";
import { readNativeJson } from "./native-json.ts";
import { nativeJsonResponse, nativeResponseLease, type NativeResponse } from "./native-response.ts";
import type { ProxySelection } from "./proxy-selection.ts";
import { HttpError } from "./utils.ts";

const encoder = new TextEncoder(), decoder = new TextDecoder("utf-8", { fatal: true });

export function prepareNativeGoogleGroundedSearch(selection: ProxySelection): NativeResponse | undefined {
  const { provider, endpoint, model, body } = selection;
  if (endpoint.request_format !== "google.grounded_search") return;
  if (provider.id !== "google-gemini" || model?.upstream !== googleGroundedSearchModel || selection.capability !== "search.web"
    || selection.method !== "POST" || endpoint.method !== "POST" || endpoint.path !== "/v1beta/models/${model}:generateContent"
    || endpoint.response_format !== "google.grounded_search" || endpoint.upstreamPath !== undefined || Object.keys(endpoint.query).length
    || endpoint.path_params.length !== 1 || endpoint.path_params[0] !== "model"
    || Object.keys(selection.pathParams).length !== 1 || selection.pathParams.model !== model.upstream
    || selection.nativeQuery !== undefined || endpoint.streaming || endpoint.lifecycle || endpoint.responsesLifecycle
    || endpoint.websocket || endpoint.modelPassthrough || endpoint.requestPricing) {
    throw new HttpError(400, "invalid_native_google_search_route", "Google grounded search requires its selected model and unary native path");
  }
  let prepared;
  try {
    if (jsonBodyBytes(body) > 128 * 1024) invalid();
    prepared = prepareGoogleGroundedSearch(model.upstream, body);
  } catch {
    throw new HttpError(400, "invalid_native_google_search_request", "Google grounded search input is invalid");
  }
  return {
    origin: "https://generativelanguage.googleapis.com", path: prepared.path,
    acquire: () => nativeResponseLease(8 * 1024 * 1024),
    async read(response, signal) {
      const encoding = response.headers.get("content-encoding");
      if (response.status !== 200 || response.redirected || encoding !== null && encoding.trim().toLowerCase() !== "identity") {
        void response.body?.cancel().catch(() => undefined); invalid();
      }
      if (encoding !== null) {
        const headers = new Headers(response.headers); headers.delete("content-encoding");
        response = new Response(response.body, { status: response.status, headers });
      }
      return readNativeJson(response, signal, 1024 * 1024, original => {
        const observed = observeGoogleGroundedSearch(original, true), root = observed.body;
        // Reject unsafe/unsupported citations without renumbering native chunks.
        if (observed.filteredCitations) invalid();
        const candidate = object(list(root.candidates, 1)[0]), content = object(candidate.content), parts = list(content.parts, 64).map(object);
        for (const part of parts) if (part.thought !== true && (part.file_data !== undefined || part.function_call !== undefined || part.functionResponse !== undefined)) invalid();
        const metadata = candidate.groundingMetadata === undefined ? {} : object(candidate.groundingMetadata);
        const chunks = metadata.groundingChunks === undefined ? [] : list(metadata.groundingChunks, 256);
        for (const value of metadata.groundingSupports === undefined ? [] : list(metadata.groundingSupports, 256)) {
          const support = object(value), segment = object(support.segment), index = integer(segment.partIndex ?? 0, parts.length);
          const part = parts[index]; if (part.thought === true || typeof part.text !== "string") invalid();
          const bytes = encoder.encode(part.text), start = integer(segment.startIndex ?? 0, bytes.length + 1), end = integer(segment.endIndex, bytes.length + 1);
          if (end <= start) invalid();
          const text = decoder.decode(bytes.subarray(start, end));
          if (segment.text !== undefined && segment.text !== text) invalid();
          for (const index of support.groundingChunkIndices === undefined ? [] : list(support.groundingChunkIndices, 256)) integer(index, chunks.length);
          for (const index of support.renderedParts === undefined ? [] : list(support.renderedParts, 64)) {
            if (parts[integer(index, parts.length)].thought === true) invalid();
          }
        }
        // Keep part positions stable for native attribution; erase thought payloads.
        const output = { ...root, candidates: [{ ...candidate, content: { ...content,
          parts: parts.map(part => part.thought === true ? { thought: true, text: "" } : part),
        } }] };
        return { response: nativeJsonResponse(output, new Response(null, { headers: {
          "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff",
        } })), usage: { tokens: null, outcome: "success" as const } };
      }, invalid);
    },
  };
}

function integer(value: unknown, exclusive: number): number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value >= exclusive) invalid(); return value; }
function object(value: unknown): Record<string, unknown> { if (!mediaObject(value)) invalid(); return value; }
function list(value: unknown, max: number): unknown[] { if (!Array.isArray(value) || value.length > max) invalid(); return value; }
function invalid(): never { throw new Error("invalid_native_google_grounded_search_response"); }
