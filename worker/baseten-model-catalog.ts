import { readNativeJson } from "./native-json.ts";
import { HttpError } from "./utils.ts";

export const BASETEN_MODELS_FORMAT = "baseten.models";
const MAX_BYTES = 2 * 1024 * 1024;

export interface BasetenModelRow {
  id: string;
  object?: "model";
  name?: string;
  context_length?: number;
  max_completion_tokens?: number;
  supported_features?: string[];
  pricing?: Partial<Record<"prompt" | "completion" | "input_cache_read", string | number>>;
}
export interface BasetenModelCatalog { object?: "list"; data: BasetenModelRow[] }

function invalid(): never {
  throw new HttpError(502, "invalid_model_discovery_response", "Baseten model catalog is invalid or exceeds the discovery bound");
}
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function text(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return;
  const result = value.trim();
  return result && result.length <= max && !/[\p{Cc}]/u.test(result) ? result : undefined;
}
function positive(value: unknown): number | undefined {
  const n = typeof value === "string" && /^\d{1,16}$/.test(value) ? Number(value) : value;
  return typeof n === "number" && Number.isSafeInteger(n) && n > 0 ? n : undefined;
}
function rate(value: unknown): string | number | undefined {
  if (typeof value === "string" && /^(?:0|[1-9]\d{0,5})(?:\.\d{1,18})?$/.test(value)) return value;
  if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value < 1_000_000) return value;
}

export function basetenCatalogRequest(inferenceBaseUrl: string, selectedApiKey: string, signal: AbortSignal): Request {
  if (!["https://inference.baseten.co/v1", "https://inference.baseten.co/v1/"].includes(inferenceBaseUrl)
    || typeof selectedApiKey !== "string" || !/^[\x21-\x7e]{1,8192}$/.test(selectedApiKey)) {
    throw new HttpError(503, "provider_catalog_not_supported", "Baseten catalog requires its canonical service and selected credential");
  }
  return new Request("https://inference.baseten.co/v1/models", {
    method: "GET", headers: { accept: "application/json", authorization: `Bearer ${selectedApiKey}` },
    credentials: "omit", redirect: "manual", signal,
  });
}

// Baseten's frozen native discovery accepts data-only lists. This does not
// relax the separate OpenAI list decoder or publish account/tariff assertions.
export function filterBasetenModels(payload: unknown, allows: (id: string) => boolean): BasetenModelCatalog {
  const envelope = record(payload);
  if (!envelope || Object.keys(envelope).some(key => key !== "data" && key !== "object")
    || envelope.object !== undefined && envelope.object !== "list"
    || !Array.isArray(envelope.data) || envelope.data.length > 4096) invalid();
  const seen = new Set<string>(), models: BasetenModelRow[] = [];
  for (const value of envelope.data) {
    const row = record(value), id = row?.id;
    if (!row || typeof id !== "string" || !id || id.length > 512 || /[\s\p{Cc}]/u.test(id) || seen.has(id)) invalid();
    seen.add(id);
    if (row.object !== undefined && row.object !== "model" || id.startsWith("decision-models/") || !allows(id)) continue;
    const model: BasetenModelRow = { id };
    if (row.object === "model") model.object = "model";
    const name = text(row.name, 512), context = positive(row.context_length), output = positive(row.max_completion_tokens);
    if (name !== undefined) model.name = name;
    // Catalog limits can differ from enforced limits. Do not clamp, seed or
    // project them into request admission without separate serving qualification.
    if (context !== undefined) model.context_length = context;
    if (output !== undefined) model.max_completion_tokens = output;
    const features = row.supported_features;
    if (Array.isArray(features) && features.length <= 32 && features.every(value => typeof value === "string"
      && /^[a-zA-Z0-9_-]{1,128}$/.test(value))) model.supported_features = [...new Set(features)];
    const pricing = record(row.pricing), observations: NonNullable<BasetenModelRow["pricing"]> = {};
    for (const key of ["prompt", "completion", "input_cache_read"] as const) {
      const observed = rate(pricing?.[key]);
      if (observed !== undefined) observations[key] = observed;
    }
    if (Object.keys(observations).length) model.pricing = observations;
    models.push(model);
  }
  models.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return envelope.object === "list" ? { object: "list", data: models } : { data: models };
}

export function readBasetenModels(response: Response, signal: AbortSignal, allows: (id: string) => boolean): Promise<BasetenModelCatalog> {
  return readNativeJson(response, signal, MAX_BYTES, payload => filterBasetenModels(payload, allows), invalid);
}
