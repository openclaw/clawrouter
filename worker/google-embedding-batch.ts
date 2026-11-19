import { googleEmbeddingModels, prepareGoogleEmbedding } from "./provider-google-embeddings.ts";
import { mediaObject, readMediaJson } from "./managed-media-json.ts";

export interface GoogleEmbeddingBatchRow { key: string; dimensions: number }
export interface GoogleEmbeddingBatchInput {
  model: string;
  rows: GoogleEmbeddingBatchRow[];
  body: Blob;
  headers: Headers;
  path: string;
  query: URLSearchParams;
}
const encoder = new TextEncoder(), uploadLimit = 20 * 1024 * 1024;
const lineLimit = 512 * 1024, resultLimit = 4 * 1024 * 1024 * 1024;

export function googleEmbeddingFileName(value: unknown): string {
  if (typeof value !== "string" || !/^files\/[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/.test(value)) throw new Error("invalid_google_embedding_file");
  return value;
}
export function googleEmbeddingBatchName(value: unknown): string {
  if (typeof value !== "string" || !/^batches\/[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error("invalid_google_embedding_batch_name");
  return value;
}
function key(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(value)) throw new Error("invalid_google_embedding_row_key");
  return value;
}
function model(value: string): void {
  if (!(googleEmbeddingModels as readonly string[]).includes(value)) throw new Error("invalid_google_embedding_batch_model");
}

export function prepareGoogleEmbeddingBatchUpload(modelId: string, requests: unknown[], displayName: string): GoogleEmbeddingBatchInput {
  model(modelId);
  if (!Array.isArray(requests) || !requests.length || requests.length > 50_000
    || typeof displayName !== "string" || !displayName.length || [...displayName].length > 512) throw new Error("invalid_google_embedding_batch_upload");
  const rows: GoogleEmbeddingBatchRow[] = [], ids = new Set<string>(), lines: string[] = [];
  let bytes = 0;
  for (const row of requests) {
    if (!mediaObject(row) || Object.keys(row).some(name => !["custom_id", "request"].includes(name))) throw new Error("invalid_google_embedding_batch_row");
    const id = key(row.custom_id);
    if (ids.has(id)) throw new Error("duplicate_google_embedding_row_key");
    ids.add(id);
    const request = prepareGoogleEmbedding(modelId, row.request, "unary");
    const line = JSON.stringify({ key: id, request: request.body }) + "\n";
    bytes += encoder.encode(line).byteLength;
    if (bytes > uploadLimit) throw new Error("google_embedding_upload_too_large");
    lines.push(line); rows.push({ key: id, dimensions: request.dimensions[0] });
  }
  const boundary = "clawrouter-" + crypto.randomUUID();
  const metadata = JSON.stringify({ file: { displayName, mimeType: "application/jsonl" } });
  const text = "--" + boundary + "\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n" + metadata
    + "\r\n--" + boundary + "\r\nContent-Type: application/jsonl; charset=UTF-8\r\n\r\n"
    + lines.join("") + "\r\n--" + boundary + "--\r\n";
  // No prompts or bytes belong in the durable rows descriptor.
  return { model: modelId, rows, body: new Blob([text]), headers: new Headers({ "content-type": "multipart/related; boundary=" + boundary }),
    path: "/upload/v1beta/files", query: new URLSearchParams({ uploadType: "multipart" }) };
}

export async function readGoogleEmbeddingUpload(response: Response): Promise<{ name: string; state: "ACTIVE" | "PROCESSING" | null; expirationTime: string | null }> {
  const { body } = await readMediaJson(response, status => status === 200);
  if (!mediaObject(body.file) || body.error !== undefined || body.file.error !== undefined
    || body.file.state !== undefined && !["ACTIVE", "PROCESSING"].includes(String(body.file.state))) throw new Error("invalid_google_embedding_upload");
  return { name: googleEmbeddingFileName(body.file.name), state: body.file.state === "ACTIVE" ? "ACTIVE" : body.file.state === "PROCESSING" ? "PROCESSING" : null,
    expirationTime: typeof body.file.expirationTime === "string" && Number.isFinite(Date.parse(body.file.expirationTime)) ? body.file.expirationTime : null };
}

// boundInput comes from the existing caller/policy/provider/credential store,
// never a caller-authorized raw file name. This codec does not establish scope.
export function prepareGoogleEmbeddingBatchCreate(modelId: string, body: unknown, boundInput: { name: string; model: string }): {
  path: string; body: Record<string, unknown>;
} {
  model(modelId);
  if (boundInput.model !== modelId || !mediaObject(body) || Object.keys(body).some(name => name !== "batch") || !mediaObject(body.batch)) throw new Error("invalid_google_embedding_batch_create");
  const batch = body.batch;
  if (Object.keys(batch).some(name => !["displayName", "inputConfig"].includes(name))
    || typeof batch.displayName !== "string" || !batch.displayName.length || [...batch.displayName].length > 512
    || !mediaObject(batch.inputConfig) || Object.keys(batch.inputConfig).some(name => name !== "file_name")
    || googleEmbeddingFileName(batch.inputConfig.file_name) !== googleEmbeddingFileName(boundInput.name)) throw new Error("google_embedding_input_binding_mismatch");
  return { path: "/v1beta/models/" + modelId + ":asyncBatchEmbedContent", body };
}

export function googleEmbeddingBatchControl(action: "retrieve" | "cancel", name: string): { method: string; path: string } {
  const id = googleEmbeddingBatchName(name);
  if (!["retrieve", "cancel"].includes(action)) throw new Error("unsupported_google_embedding_batch_action");
  return { method: action === "retrieve" ? "GET" : "POST", path: "/v1beta/" + id + (action === "cancel" ? ":cancel" : "") };
}

// This name must be bound from an authenticated successful operation. Never use
// native uri/downloadUri as an authenticated destination or fall back to a URL.
export function googleEmbeddingBatchDownload(boundFile: string): { path: string; query: URLSearchParams } {
  return { path: "/download/v1beta/" + googleEmbeddingFileName(boundFile) + ":download", query: new URLSearchParams({ alt: "media" }) };
}

export interface GoogleEmbeddingBatchObservation {
  name: string;
  nativeStatus: string | null;
  terminal: "succeeded" | "failed" | "canceled" | null;
  observationUnavailable?: "expired_or_unknown";
  outputFile: string | null;
  followUp?: "retrieve";
}

export async function readGoogleEmbeddingBatch(response: Response, action: "create" | "retrieve" | "cancel", expectedName?: string): Promise<GoogleEmbeddingBatchObservation> {
  const { body } = await readMediaJson(response, status => status === 200);
  if (!["create", "retrieve", "cancel"].includes(action)) throw new Error("unsupported_google_embedding_batch_action");
  if (action === "cancel") {
    if (Object.keys(body).length) throw new Error("invalid_google_embedding_cancel_ack");
    return { name: googleEmbeddingBatchName(expectedName), nativeStatus: null, terminal: null, outputFile: null, followUp: "retrieve" };
  }
  const name = googleEmbeddingBatchName(body.name);
  if (action !== "create" && name !== googleEmbeddingBatchName(expectedName)) throw new Error("google_embedding_batch_identity_mismatch");
  if (body.done !== undefined && typeof body.done !== "boolean") throw new Error("invalid_google_embedding_batch_state");
  const metadata = mediaObject(body.metadata) ? body.metadata : {};
  const raw = metadata.state;
  if (raw !== undefined && (typeof raw !== "string" || !/^(?:BATCH|JOB)_STATE_(?:PENDING|RUNNING|SUCCEEDED|FAILED|CANCELLED|CANCELED|EXPIRED|UNSPECIFIED)$/.test(raw))) throw new Error("invalid_google_embedding_batch_state");
  const state = typeof raw === "string" ? raw.replace(/^(?:BATCH|JOB)_STATE_/, "") : null;
  const observation: GoogleEmbeddingBatchObservation = { name, nativeStatus: typeof raw === "string" ? raw : null, terminal: null, outputFile: null };
  if (state === "EXPIRED") return { ...observation, observationUnavailable: "expired_or_unknown" };
  if (body.error !== undefined) {
    if (!mediaObject(body.error) || !Number.isInteger(body.error.code) || Number(body.error.code) <= 0) throw new Error("invalid_google_embedding_batch_error");
    return { ...observation, terminal: body.error.code === 1 ? "canceled" : "failed" };
  }
  if (state === "FAILED") return { ...observation, terminal: "failed" };
  if (state === "CANCELLED" || state === "CANCELED") return { ...observation, terminal: "canceled" };
  if (state === "SUCCEEDED" || body.done === true) {
    const a = mediaObject(body.response) ? body.response.responsesFile : undefined;
    const b = mediaObject(metadata.output) ? metadata.output.responsesFile : undefined;
    if (a !== undefined && b !== undefined && a !== b) throw new Error("google_embedding_output_binding_conflict");
    return { ...observation, terminal: "succeeded", outputFile: a === undefined && b === undefined ? null : googleEmbeddingFileName(a ?? b) };
  }
  if (state === "PENDING" || state === "RUNNING" || body.done === false) return { ...observation, followUp: "retrieve" };
  throw new Error("unknown_google_embedding_batch_state");
}

export interface GoogleEmbeddingBatchResult { key: string; values: number[]; inputTokens: number | null }

// Yield validated rows into the consumer's staging transaction. Commit only
// after successful generator exhaustion; any late/duplicate/error row or EOF
// failure invalidates the download. Rows are never retained in this decoder.
export async function* readGoogleEmbeddingBatchResults(response: Response, expected: GoogleEmbeddingBatchRow[], signal: AbortSignal): AsyncGenerator<GoogleEmbeddingBatchResult> {
  if (!expected.length || expected.length > 50_000) throw new Error("invalid_google_embedding_result_manifest");
  const remaining = new Map<string, number>();
  for (const row of expected) {
    const id = key(row.key);
    if (remaining.has(id) || !Number.isInteger(row.dimensions) || row.dimensions < 128 || row.dimensions > 3072) throw new Error("invalid_google_embedding_result_manifest");
    remaining.set(id, row.dimensions);
  }
  const mime = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (signal.aborted || response.redirected || response.status !== 200 || !response.body
    || !["application/jsonl", "application/x-ndjson", "application/json", "text/plain"].includes(mime ?? "")
    || Number(response.headers.get("content-length")) > resultLimit) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error("invalid_google_embedding_result_response");
  }
  const reader = response.body.getReader(), decoder = new TextDecoder("utf-8", { fatal: true });
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", abort, { once: true });
  let buffer = "", bytes = 0, complete = false;
  const parse = (line: string): GoogleEmbeddingBatchResult => {
    if (encoder.encode(line).byteLength > lineLimit) throw new Error("oversized_google_embedding_result_line");
    const value: unknown = JSON.parse(line);
    if (!mediaObject(value)) throw new Error("invalid_google_embedding_result_line");
    const aliases = [value.key, value.custom_id, value.request_id].filter(value => value !== undefined);
    if (!aliases.length || aliases.some(value => value !== aliases[0])) throw new Error("conflicting_google_embedding_result_key");
    const id = key(aliases[0]), dimensions = remaining.get(id);
    if (dimensions === undefined) throw new Error("unexpected_google_embedding_result_key");
    const result = mediaObject(value.response) ? value.response : value;
    if (value.error !== undefined || result.error !== undefined || value.embedding !== undefined && result !== value && result.embedding !== undefined) throw new Error("invalid_google_embedding_result_line");
    const embedding = value.embedding ?? result.embedding;
    if (!mediaObject(embedding) || !Array.isArray(embedding.values) || embedding.values.length !== dimensions
      || !embedding.values.every(item => typeof item === "number" && Number.isFinite(item))) throw new Error("invalid_google_embedding_result_vector");
    remaining.delete(id);
    const usage = mediaObject(result.usageMetadata) ? result.usageMetadata : {};
    return { key: id, values: embedding.values as number[], inputTokens: Number.isSafeInteger(usage.promptTokenCount) && Number(usage.promptTokenCount) >= 0 ? Number(usage.promptTokenCount) : null };
  };
  try {
    for (;;) {
      const part = await reader.read();
      if (signal.aborted) throw new Error("aborted");
      if (part.done) { buffer += decoder.decode(); break; }
      bytes += part.value.byteLength;
      if (bytes > resultLimit) throw new Error("oversized");
      for (let offset = 0; offset < part.value.byteLength; offset += 64 * 1024) {
        buffer += decoder.decode(part.value.subarray(offset, offset + 64 * 1024), { stream: true });
        let newline: number;
        while ((newline = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          if (signal.aborted) throw new Error("aborted");
          if (line.trim()) yield parse(line);
        }
        if (encoder.encode(buffer).byteLength > lineLimit) throw new Error("oversized");
      }
    }
    if (signal.aborted) throw new Error("aborted");
    if (buffer.trim()) yield parse(buffer);
    if (remaining.size) throw new Error("missing_google_embedding_result_keys");
    complete = true;
  } catch { throw new Error("invalid_google_embedding_batch_results"); }
  finally {
    signal.removeEventListener("abort", abort);
    if (!complete) void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
