import { nativeJsonResponse, nativeResponseLease, type NativeResponse } from "./native-response.ts";
import { prepareGoogleEmbedding, readGoogleEmbedding } from "./provider-google-embeddings.ts";
import type { ProxySelection } from "./proxy-selection.ts";
import { HttpError } from "./utils.ts";

export function nativeEmbeddingMode(format: string): "unary" | "batch" | null {
  return format === "google.embed_content" ? "unary" : format === "google.batch_embed_contents" ? "batch" : null;
}

// Client task formatting and vector normalization stay with the native client.
// This boundary binds the source codec to the selected model and complete EOF.
export function prepareNativeEmbedding(selection: ProxySelection): NativeResponse | undefined {
  const mode = nativeEmbeddingMode(selection.endpoint.request_format);
  if (!mode) return;
  const { endpoint, model } = selection;
  if (!model || !["gemini-embedding-001", "gemini-embedding-2"].includes(model.upstream)
    || selection.pathParams.model !== model.upstream || selection.method !== "POST"
    || endpoint.response_format !== endpoint.request_format || endpoint.modelPassthrough || endpoint.lifecycle
    || endpoint.path !== `/v1beta/models/${"${model}"}:${mode === "unary" ? "embedContent" : "batchEmbedContents"}`)
    throw new HttpError(400, "invalid_native_embedding_route", "a qualified native embedding model and route are required");
  let prepared;
  try { prepared = prepareGoogleEmbedding(model.upstream, selection.body, mode); }
  catch { throw new HttpError(400, "invalid_native_embedding_request", "native embedding input does not match the selected model contract"); }
  return {
    origin: "https://generativelanguage.googleapis.com", path: prepared.path,
    acquire: () => nativeResponseLease(32 * 1024 * 1024),
    async read(response, signal) {
      const value = await readGoogleEmbedding(response, prepared, signal);
      const tokens = value.inputTokens === null ? null : { input: value.inputTokens, output: null, total: value.inputTokens,
        cached: null, cacheWrite: null, cacheWrite5m: null, cacheWrite1h: null };
      return { response: nativeJsonResponse(value.body, response), usage: { tokens, outcome: "success" } };
    },
  };
}
