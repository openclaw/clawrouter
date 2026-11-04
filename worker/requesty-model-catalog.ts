import { readNativeJson } from "./native-json.ts";
import { HttpError } from "./utils.ts";

export const REQUESTY_MODELS_FORMAT = "requesty.models_managed";
const PRICE_KEYS = ["input_price", "output_price", "cached_price", "caching_price"] as const;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_CHUNKS = 8192;

// Native observations only. Price units/current account tariffs are unqualified;
// absent fields stay unknown, and explicit zero is never synthesized.
export interface RequestyModelRow {
  id: string;
  api: "chat";
  context_window?: number;
  max_output_tokens?: number;
  supports_vision?: boolean;
  supports_reasoning?: boolean;
  input_price?: number | string;
  output_price?: number | string;
  cached_price?: number | string;
  caching_price?: number | string;
}
export interface RequestyModelCatalog { data: RequestyModelRow[] }

function invalid(): never {
  throw new HttpError(502, "invalid_model_discovery_response", "Requesty managed catalog is invalid or exceeds the discovery bound");
}
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function priceObservation(value: unknown): value is number | string {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0;
  return typeof value === "string" && value.length <= 128
    && /^(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value) && Number.isFinite(Number(value));
}

export function requestyCatalogRequest(inferenceBaseUrl: string, selectedApiKey: string, signal: AbortSignal): Request {
  if (!["https://router.requesty.ai/v1", "https://router.requesty.ai/v1/"].includes(inferenceBaseUrl)
    || typeof selectedApiKey !== "string" || !/^[\x21-\x7e]{1,8192}$/.test(selectedApiKey)) {
    throw new HttpError(503, "provider_catalog_not_supported", "Requesty catalog requires its global service and selected credential");
  }
  return new Request("https://router.requesty.ai/v1/models/managed", {
    method: "GET", headers: { accept: "application/json", authorization: `Bearer ${selectedApiKey}` },
    credentials: "omit", redirect: "manual", signal,
  });
}

// Frozen projectRequestyModels keeps the first eligible trimmed ID and excludes
// non-Chat and @regional policies. Never rewrite bare names to hosting aliases.
export function filterRequestyModels(payload: unknown, allows: (id: string) => boolean): RequestyModelCatalog {
  const envelope = record(payload);
  if (!envelope || Object.keys(envelope).some(key => key !== "data")
    || !Array.isArray(envelope.data) || envelope.data.length > 4096) invalid();
  const seen = new Set<string>(), models: RequestyModelRow[] = [];
  for (const value of envelope.data) {
    const row = record(value);
    if (!row || typeof row.id !== "string") continue;
    if (row.id.length > 512) invalid();
    const id = row.id.trim();
    if (!id) continue;
    if (/[\s\p{Cc}]/u.test(id)) invalid();
    if (id.includes("@") || row.api !== "chat") continue;
    if (seen.has(id)) continue;
    seen.add(id);
    if (!allows(id)) continue;
    const model: RequestyModelRow = { id, api: "chat" };
    for (const key of ["context_window", "max_output_tokens"] as const) {
      const value = row[key];
      if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) model[key] = value;
    }
    for (const key of ["supports_vision", "supports_reasoning"] as const) {
      const value = row[key];
      if (typeof value === "boolean") model[key] = value;
    }
    for (const key of PRICE_KEYS) {
      const value = row[key];
      if (priceObservation(value)) model[key] = value;
    }
    models.push(model);
  }
  return { data: models };
}

// Reuse the complete native JSON reader. The caller owns the original deadline,
// capacity and fresh authorization before fetch and after parsing/publication.
export async function readRequestyModels(response: Response, signal: AbortSignal, allows: (id: string) => boolean): Promise<RequestyModelCatalog> {
  if (response.status !== 200 || response.redirected || !response.body || signal.aborted) {
    void response.body?.cancel().catch(() => undefined);
    invalid();
  }
  let chunks = 0;
  const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      signal.throwIfAborted();
      if (++chunks > MAX_CHUNKS || !(chunk instanceof Uint8Array)) invalid();
      controller.enqueue(chunk);
    },
  }));
  return readNativeJson(new Response(body, { status: response.status, headers: response.headers }), signal, MAX_BYTES,
    payload => filterRequestyModels(payload, allows), invalid);
}
