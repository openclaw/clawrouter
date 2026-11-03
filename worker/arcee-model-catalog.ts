import { readNativeJson } from "./native-json.ts";
import { HttpError } from "./utils.ts";

export const ARCEE_MODELS_FORMAT = "arcee.models";
const PRICE_KEYS = ["prompt", "completion", "image", "request", "input_cache_reads", "input_cache_writes"] as const;
export interface ArceeModelRow {
  id: string;
  name: string;
  object?: "model";
  context_length: number;
  max_output_length: number;
  input_modalities: string[];
  output_modalities: string[];
  supported_features?: string[];
  supported_sampling_parameters?: string[];
  pricing?: Partial<Record<typeof PRICE_KEYS[number], string>>;
}
export interface ArceeModelCatalog { object?: "list"; data: ArceeModelRow[] }

function invalid(): never {
  throw new HttpError(502, "invalid_model_discovery_response", "Arcee model catalog is invalid or exceeds the discovery bound");
}
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function tokens(value: unknown, max: number): string[] | undefined {
  return Array.isArray(value) && value.length <= max && value.every(v => typeof v === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(v))
    ? [...new Set(value)] : undefined;
}

export function arceeCatalogRequest(inferenceBaseUrl: string, selectedApiKey: string, signal: AbortSignal): Request {
  if (!["https://api.arcee.ai/api/v1", "https://api.arcee.ai/api/v1/"].includes(inferenceBaseUrl)
    || typeof selectedApiKey !== "string" || !/^[\x21-\x7e]{1,8192}$/.test(selectedApiKey)) {
    throw new HttpError(503, "provider_catalog_not_supported", "Arcee catalog requires its canonical direct service and selected credential");
  }
  return new Request("https://api.arcee.ai/api/v1/models", {
    method: "GET", headers: { accept: "application/json", authorization: `Bearer ${selectedApiKey}` },
    credentials: "omit", redirect: "error", signal,
  });
}

// Arcee documents a data-only list with native modalities/limits. Its optional
// OpenRouter metadata never changes selected IDs, credentials or destinations.
export function filterArceeModels(payload: unknown, allows: (id: string) => boolean): ArceeModelCatalog {
  const envelope = record(payload);
  if (!envelope || Object.keys(envelope).some(key => key !== "data" && key !== "object")
    || envelope.object !== undefined && envelope.object !== "list"
    || !Array.isArray(envelope.data) || envelope.data.length > 4096) invalid();
  const seen = new Set<string>(), models: ArceeModelRow[] = [];
  for (const value of envelope.data) {
    const row = record(value), id = row?.id;
    if (!row || typeof id !== "string" || !id || id.length > 512 || /[\s\p{Cc}]/u.test(id) || seen.has(id)) invalid();
    seen.add(id);
    const input = tokens(row.input_modalities, 16), output = tokens(row.output_modalities, 16);
    if (!input?.length || !output?.length || !positive(row.context_length) || !positive(row.max_output_length)) invalid();
    if (row.object !== undefined && row.object !== "model" || !input.includes("text") || !output.includes("text") || !allows(id)) continue;
    const name = typeof row.name === "string" ? row.name.trim() : "";
    const model: ArceeModelRow = {
      id, name: name && name.length <= 512 && !/[\p{Cc}]/u.test(name) ? name : id,
      context_length: row.context_length, max_output_length: row.max_output_length,
      input_modalities: input, output_modalities: output,
    };
    if (row.object === "model") model.object = "model";
    const features = tokens(row.supported_features, 32), parameters = tokens(row.supported_sampling_parameters, 64);
    if (features !== undefined) model.supported_features = features;
    if (parameters !== undefined) model.supported_sampling_parameters = parameters;
    const pricing = record(row.pricing), observations: NonNullable<ArceeModelRow["pricing"]> = {};
    for (const key of PRICE_KEYS) {
      const value = pricing?.[key];
      if (typeof value === "string" && /^(?:0|[1-9]\d{0,5})(?:\.\d{1,18})?$/.test(value)) observations[key] = value;
    }
    if (Object.keys(observations).length) model.pricing = observations;
    models.push(model);
  }
  models.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return envelope.object === "list" ? { object: "list", data: models } : { data: models };
}

export function readArceeModels(response: Response, signal: AbortSignal, allows: (id: string) => boolean): Promise<ArceeModelCatalog> {
  return readNativeJson(response, signal, 2 * 1024 * 1024, payload => filterArceeModels(payload, allows), invalid);
}
