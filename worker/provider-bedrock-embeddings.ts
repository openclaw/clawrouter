type Family = "titan-v1" | "titan-v2" | "cohere-v3" | "cohere-v4" | "nova" | "marengo-2" | "marengo-3";
interface Spec { family: Family; dimensions: readonly number[]; defaultDimensions: number }
const specs: Record<string, Spec> = {
  "amazon.titan-embed-text-v2:0": { family: "titan-v2", dimensions: [256, 512, 1024], defaultDimensions: 1024 },
  "amazon.titan-embed-text-v1": { family: "titan-v1", dimensions: [1536], defaultDimensions: 1536 },
  "amazon.titan-embed-g1-text-02": { family: "titan-v1", dimensions: [1536], defaultDimensions: 1536 },
  "amazon.titan-embed-image-v1": { family: "titan-v1", dimensions: [1024], defaultDimensions: 1024 },
  "cohere.embed-english-v3": { family: "cohere-v3", dimensions: [1024], defaultDimensions: 1024 },
  "cohere.embed-multilingual-v3": { family: "cohere-v3", dimensions: [1024], defaultDimensions: 1024 },
  "cohere.embed-v4:0": { family: "cohere-v4", dimensions: [256, 512, 1024, 1536], defaultDimensions: 1536 },
  "amazon.nova-2-multimodal-embeddings-v1:0": { family: "nova", dimensions: [256, 384, 1024, 3072], defaultDimensions: 1024 },
  "twelvelabs.marengo-embed-2-7-v1:0": { family: "marengo-2", dimensions: [1024], defaultDimensions: 1024 },
  "twelvelabs.marengo-embed-3-0-v1:0": { family: "marengo-3", dimensions: [512], defaultDimensions: 512 },
};
export const bedrockEmbeddingModels = Object.keys(specs);
export interface BedrockEmbeddingRequest {
  modelId: string; family: Family; dimensions: number; count: number;
  body: Record<string, unknown>; path: string; headers: Headers;
}
const encoder = new TextEncoder();

export function prepareBedrockEmbedding(modelId: string, body: unknown): BedrockEmbeddingRequest {
  const spec = resolveSpec(modelId);
  if (!object(body) || encoder.encode(JSON.stringify(body)).byteLength > 2 * 1024 * 1024) throw new Error("invalid_bedrock_embedding_body");
  let dimensions = spec.defaultDimensions, count = 1;
  if (spec.family === "titan-v1" || spec.family === "titan-v2") {
    keys(body, spec.family === "titan-v1" ? ["inputText"] : ["inputText", "dimensions", "normalize", "embeddingTypes"]);
    text(body.inputText);
    if (spec.family === "titan-v2") {
      if (body.dimensions !== undefined) dimensions = dimension(body.dimensions, spec);
      if (body.normalize !== undefined && typeof body.normalize !== "boolean") throw new Error("invalid_bedrock_embedding_normalize");
      if (body.embeddingTypes !== undefined) floatOnly(body.embeddingTypes);
    }
  } else if (spec.family === "cohere-v3" || spec.family === "cohere-v4") {
    keys(body, ["texts", "input_type", "truncate", "embedding_types", ...(spec.family === "cohere-v4" ? ["output_dimension"] : [])]);
    if (!Array.isArray(body.texts) || !body.texts.length || body.texts.length > 96
      || !["search_query", "search_document"].includes(String(body.input_type))) throw new Error("invalid_bedrock_embedding_batch");
    body.texts.forEach(text); count = body.texts.length;
    const truncate = spec.family === "cohere-v3" ? ["NONE", "START", "END"] : ["NONE", "LEFT", "RIGHT"];
    if (body.truncate !== undefined && !truncate.includes(String(body.truncate))) throw new Error("invalid_bedrock_embedding_truncate");
    if (body.embedding_types !== undefined) floatOnly(body.embedding_types);
    if (body.output_dimension !== undefined) dimensions = dimension(body.output_dimension, spec);
  } else if (spec.family === "nova") {
    keys(body, ["taskType", "schemaVersion", "singleEmbeddingParams"]);
    if (body.taskType !== "SINGLE_EMBEDDING" || body.schemaVersion !== undefined && body.schemaVersion !== "nova-multimodal-embed-v1" || !object(body.singleEmbeddingParams)) throw new Error("invalid_bedrock_nova_embedding");
    const params = body.singleEmbeddingParams;
    keys(params, ["embeddingPurpose", "embeddingDimension", "text"]);
    if (params.embeddingPurpose !== "GENERIC_INDEX" || !object(params.text)) throw new Error("invalid_bedrock_nova_embedding");
    keys(params.text, ["truncationMode", "value"]);
    if (!["START", "END", "NONE"].includes(String(params.text.truncationMode))) throw new Error("invalid_bedrock_embedding_truncate");
    text(params.text.value);
    dimensions = dimension(params.embeddingDimension, spec);
  } else if (spec.family === "marengo-2") {
    keys(body, ["inputType", "inputText", "textTruncate"]);
    if (body.inputType !== "text" || body.textTruncate !== undefined && !["end", "none"].includes(String(body.textTruncate))) throw new Error("invalid_bedrock_marengo_embedding");
    text(body.inputText);
  } else {
    keys(body, ["inputType", "text"]);
    if (body.inputType !== "text" || !object(body.text)) throw new Error("invalid_bedrock_marengo_embedding");
    keys(body.text, ["inputText"]); text(body.text.inputText);
  }
  return { modelId, family: spec.family, dimensions, count, body,
    path: "/model/" + encodeURIComponent(modelId) + "/invoke",
    headers: new Headers({ "content-type": "application/json", accept: "application/json" }) };
}

// The runtime supplies complete bounded native JSON after the original signed
// request. Never extract vector length as tokens or rewrite/normalize native data.
export function observeBedrockEmbedding(value: unknown, request: BedrockEmbeddingRequest, complete: boolean): {
  vectors: number[][]; inputTokens: number | null;
} {
  if (!complete || !object(value) || value.error !== undefined || value.__type !== undefined) throw new Error("invalid_bedrock_embedding_response");
  let rows: unknown;
  switch (request.family) {
    case "cohere-v3": rows = value.embeddings; break;
    case "cohere-v4": rows = object(value.embeddings) ? value.embeddings.float : value.embeddings; break;
    case "nova":
      if (!Array.isArray(value.embeddings) || value.embeddings.length !== 1 || !object(value.embeddings[0])
        || value.embeddings[0].embeddingType !== undefined && value.embeddings[0].embeddingType !== "TEXT") throw new Error("invalid_bedrock_embedding_response");
      rows = [value.embeddings[0].embedding]; break;
    case "marengo-2":
    case "marengo-3":
      if (Array.isArray(value.data)) rows = value.data.map(item => object(item) ? item.embedding : null);
      else rows = [object(value.data) ? value.data.embedding : value.embedding];
      break;
    default: rows = [value.embedding];
  }
  if (!Array.isArray(rows) || rows.length !== request.count || request.count < 1 || request.count > 96
    || !Number.isSafeInteger(request.dimensions) || request.dimensions < 1 || request.dimensions > 3072) throw new Error("invalid_bedrock_embedding_response");
  for (const vector of rows) {
    if (!Array.isArray(vector) || vector.length !== request.dimensions || vector.some(item => typeof item !== "number" || !Number.isFinite(item))) throw new Error("invalid_bedrock_embedding_vector");
  }
  const count = value.inputTextTokenCount;
  const inputTokens = request.family.startsWith("titan-") && Number.isSafeInteger(count) && Number(count) >= 0 ? Number(count) : null;
  return { vectors: rows as number[][], inputTokens };
}

function resolveSpec(modelId: string): Spec {
  if (typeof modelId !== "string" || modelId.length > 200 || !/^[a-z0-9][a-z0-9.:-]+$/.test(modelId)) throw new Error("unsupported_bedrock_embedding_model");
  const bare = modelId.replace(/^(?:us|eu|ap|apac|au|jp|global)\./, "");
  if (Object.hasOwn(specs, bare)) return specs[bare];
  const parts = bare.split(":");
  for (let length = parts.length - 1; length >= 1; length--) {
    const base = parts.slice(0, length).join(":");
    if (Object.hasOwn(specs, base) && parts.slice(length).every(part => /^\d+(?:k)?$/.test(part))) return specs[base];
  }
  // Do not infer a Titan wire for unknown aliases, ARNs or future model families.
  throw new Error("unsupported_bedrock_embedding_model");
}
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function keys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error("unsupported_bedrock_embedding_field");
}
function text(value: unknown): void { if (typeof value !== "string" || !value.trim()) throw new Error("invalid_bedrock_embedding_text"); }
function dimension(value: unknown, spec: Spec): number {
  if (typeof value !== "number" || !spec.dimensions.includes(value)) throw new Error("invalid_bedrock_embedding_dimensions");
  return value;
}
function floatOnly(value: unknown): void {
  if (!Array.isArray(value) || value.length !== 1 || value[0] !== "float") throw new Error("unsupported_bedrock_embedding_type");
}
