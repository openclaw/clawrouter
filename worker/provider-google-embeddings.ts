export const googleEmbeddingModels = ["gemini-embedding-001", "gemini-embedding-2", "gemini-embedding-2-preview"] as const;
type Model = typeof googleEmbeddingModels[number];
type Mode = "unary" | "batch";
const taskTypes = new Set(["RETRIEVAL_QUERY", "RETRIEVAL_DOCUMENT", "SEMANTIC_SIMILARITY",
  "CLASSIFICATION", "CLUSTERING", "QUESTION_ANSWERING", "FACT_VERIFICATION", "CODE_RETRIEVAL_QUERY"]);
const encoder = new TextEncoder();
const requestLimit = 20 * 1024 * 1024, responseLimit = 16 * 1024 * 1024;

export interface GoogleEmbeddingRequest {
  model: Model;
  mode: Mode;
  dimensions: number[];
  body: Record<string, unknown>;
  path: string;
  headers: Headers;
}

// Accept the frozen client's native wire body. Task formatting, normalization
// and batching belong to the consumer; credentials and admission to runtime.
export function prepareGoogleEmbedding(model: string, body: unknown, mode: Mode): GoogleEmbeddingRequest {
  if (!(googleEmbeddingModels as readonly string[]).includes(model) || !["unary", "batch"].includes(mode)
    || !object(body) || encoder.encode(JSON.stringify(body)).byteLength > requestLimit) throw new Error("invalid_google_embedding_request");
  let requests: unknown[];
  if (mode === "batch") {
    keys(body, ["requests"]);
    if (!Array.isArray(body.requests) || !body.requests.length || body.requests.length > 100) throw new Error("invalid_google_embedding_batch");
    requests = body.requests;
  } else requests = [body];
  const dimensions = requests.map(value => validateItem(model as Model, value, mode === "batch"));
  return { model: model as Model, mode, dimensions, body,
    path: "/v1beta/models/" + model + (mode === "unary" ? ":embedContent" : ":batchEmbedContents"),
    headers: new Headers({ "content-type": "application/json", accept: "application/json" }) };
}

function validateItem(model: Model, value: unknown, requireModel: boolean): number {
  if (!object(value)) throw new Error("invalid_google_embedding_item");
  keys(value, ["model", "content", "taskType", "outputDimensionality"]);
  if ((requireModel || value.model !== undefined) && value.model !== "models/" + model) throw new Error("google_embedding_model_mismatch");
  if (value.taskType !== undefined && (model === "gemini-embedding-2" || typeof value.taskType !== "string" || !taskTypes.has(value.taskType))) throw new Error("invalid_google_embedding_task");
  const dimensions = value.outputDimensionality === undefined ? 3072 : value.outputDimensionality;
  if (!Number.isInteger(dimensions) || Number(dimensions) < 128 || Number(dimensions) > 3072) throw new Error("invalid_google_embedding_dimensions");
  if (!object(value.content)) throw new Error("invalid_google_embedding_content");
  keys(value.content, ["parts"]);
  const parts = value.content.parts;
  if (!Array.isArray(parts) || !parts.length || parts.length > 100) throw new Error("invalid_google_embedding_parts");
  for (const part of parts) {
    if (!object(part) || Object.keys(part).length !== 1) throw new Error("invalid_google_embedding_part");
    if (typeof part.text === "string" && part.text.length) continue;
    if (model === "gemini-embedding-001" || !object(part.inlineData)) throw new Error("invalid_google_embedding_part");
    const inline = part.inlineData;
    keys(inline, ["mimeType", "data"]);
    if (typeof inline.mimeType !== "string" || !/^(?:image|audio|video)\/[a-z0-9.+-]{1,64}$|^application\/pdf$/.test(inline.mimeType)
      || typeof inline.data !== "string" || !inline.data.length || inline.data.length % 4
      || !/^[A-Za-z0-9+/]+={0,2}$/.test(inline.data)) throw new Error("invalid_google_embedding_inline_data");
  }
  return Number(dimensions);
}

export interface GoogleEmbeddingObservation {
  body: Record<string, unknown>;
  vectors: number[][];
  inputTokens: number | null;
  // Modal counts are observations, never a price card or evidence of free work.
  inputTokenDetails: Record<string, number> | null;
}

export function observeGoogleEmbedding(body: unknown, request: GoogleEmbeddingRequest, complete: boolean): GoogleEmbeddingObservation {
  if (!complete || !object(body) || body.error !== undefined) throw new Error("invalid_google_embedding_response");
  const rows = request.mode === "unary" ? [body.embedding] : body.embeddings;
  if (!Array.isArray(rows) || rows.length !== request.dimensions.length) throw new Error("google_embedding_count_mismatch");
  const vectors = rows.map((row, index) => {
    if (!object(row) || !Array.isArray(row.values) || row.values.length !== request.dimensions[index]
      || !row.values.every(value => typeof value === "number" && Number.isFinite(value))) throw new Error("invalid_google_embedding_vector");
    return row.values as number[];
  });
  const usage = object(body.usageMetadata) ? body.usageMetadata : null;
  const inputTokens = integer(usage?.promptTokenCount) ? Number(usage?.promptTokenCount) : null;
  let inputTokenDetails: Record<string, number> | null = null;
  if (inputTokens !== null && Array.isArray(usage?.promptTokenDetails) && usage.promptTokenDetails.length > 0 && usage.promptTokenDetails.length <= 5) {
    const details: Record<string, number> = {};
    let valid = true, sum = 0;
    for (const row of usage.promptTokenDetails) {
      if (!object(row) || !["TEXT", "IMAGE", "VIDEO", "AUDIO", "DOCUMENT"].includes(String(row.modality))
        || Object.hasOwn(details, String(row.modality)) || !integer(row.tokenCount)) { valid = false; break; }
      details[String(row.modality)] = Number(row.tokenCount); sum += Number(row.tokenCount);
    }
    if (valid && sum === inputTokens) inputTokenDetails = details;
  }
  return { body, vectors, inputTokens, inputTokenDetails };
}

// Runtime supplies its existing deadline/caller signal. No prefix results are
// returned before complete bounded UTF-8 EOF; caller abort never implies refund.
export async function readGoogleEmbedding(response: Response, request: GoogleEmbeddingRequest, signal: AbortSignal): Promise<GoogleEmbeddingObservation> {
  if (signal.aborted || response.redirected || response.status !== 200 || !response.body
    || response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json"
    || Number(response.headers.get("content-length")) > responseLimit) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error("invalid_google_embedding_response");
  }
  const reader = response.body.getReader(), decoder = new TextDecoder("utf-8", { fatal: true });
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", abort, { once: true });
  let text = "", bytes = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (signal.aborted) throw new Error("aborted");
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > responseLimit) throw new Error("oversized");
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
    return observeGoogleEmbedding(JSON.parse(text), request, true);
  } catch {
    void reader.cancel().catch(() => undefined);
    throw new Error("invalid_google_embedding_response");
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}

function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function keys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error("unsupported_google_embedding_field");
}
function integer(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0; }
