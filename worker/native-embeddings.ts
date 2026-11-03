import { BodyLease } from "./body-budget.ts";
import { jsonBodyStream } from "./json-body.ts";
import { prepareGoogleEmbedding, readGoogleEmbedding } from "./provider-google-embeddings.ts";
import type { ProxySelection } from "./proxy-selection.ts";
import type { UsageInspection } from "./token-usage.ts";
import { HttpError } from "./utils.ts";

export function nativeEmbeddingMode(format: string): "unary" | "batch" | null {
  return format === "google.embed_content" ? "unary" : format === "google.batch_embed_contents" ? "batch" : null;
}

export interface NativeEmbedding {
  path: string;
  acquire(): BodyLease;
  read(response: Response, signal: AbortSignal): Promise<{ response: Response; usage: UsageInspection }>;
}

// Client task formatting and vector normalization stay with the native client.
// This boundary binds the source codec to the selected model and complete EOF.
export function prepareNativeEmbedding(selection: ProxySelection): NativeEmbedding | undefined {
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
    path: prepared.path,
    acquire() {
      const lease = new BodyLease();
      // Reserve before paid dispatch, including decoded JSON and parsed vectors.
      // The existing shared budget holds this capacity through downstream EOF.
      if (!lease.grow(32 * 1024 * 1024)) throw new HttpError(503, "server_overloaded", "embedding response capacity is busy; retry shortly");
      return lease;
    },
    async read(response, signal) {
      const value = await readGoogleEmbedding(response, prepared, signal);
      const headers = new Headers(response.headers);
      for (const name of ["content-length", "content-encoding", "etag", "content-md5", "digest"]) headers.delete(name);
      const tokens = value.inputTokens === null ? null : { input: value.inputTokens, output: null, total: value.inputTokens,
        cached: null, cacheWrite: null, cacheWrite5m: null, cacheWrite1h: null };
      return { response: new Response(jsonBodyStream(value.body), { status: 200, headers }), usage: { tokens, outcome: "success" } };
    },
  };
}

export function assertNativeEmbeddingDestination(embedding: NativeEmbedding | undefined, url: URL): void {
  if (embedding && (url.origin !== "https://generativelanguage.googleapis.com" || url.pathname !== embedding.path || url.search || url.hash || url.username || url.password))
    throw new HttpError(400, "invalid_native_embedding_destination", "native embeddings require the qualified Google origin and model path");
}
