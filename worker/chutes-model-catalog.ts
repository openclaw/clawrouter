import { readNativeJson } from "./native-json.ts";
import { HttpError } from "./utils.ts";

export const CHUTES_MODELS_FORMAT = "chutes.models";
const LIMIT_KEYS = ["context_length", "max_model_len", "max_output_length"] as const;
const PRICE_KEYS = ["prompt", "completion", "input_cache_read"] as const;
export interface ChutesModelRow {
  id: string;
  object: "model";
  context_length?: number;
  max_model_len?: number;
  max_output_length?: number;
  input_modalities?: string[];
  output_modalities?: string[];
  supported_features?: string[];
  supported_sampling_parameters?: string[];
  confidential_compute?: boolean;
  pricing?: Partial<Record<typeof PRICE_KEYS[number], number>>;
}
export interface ChutesModelCatalog { object: "list"; data: ChutesModelRow[] }

function invalid(): never {
  throw new HttpError(502, "invalid_model_discovery_response", "Chutes model catalog is invalid or exceeds the discovery bound");
}
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function tokens(value: unknown, max: number): string[] | undefined {
  return Array.isArray(value) && value.length <= max && value.every(v => typeof v === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(v))
    ? [...new Set(value)] : undefined;
}

// Public discovery never receives an inference or OAuth credential. Router
// authorization and the original policy filter remain the dispatcher's job.
export function chutesCatalogRequest(inferenceBaseUrl: string, signal: AbortSignal): Request {
  if (!["https://llm.chutes.ai/v1", "https://llm.chutes.ai/v1/"].includes(inferenceBaseUrl)) {
    throw new HttpError(503, "provider_catalog_not_supported", "Chutes catalog requires its canonical inference service");
  }
  return new Request("https://llm.chutes.ai/v1/models", {
    method: "GET", headers: { accept: "application/json" }, credentials: "omit", redirect: "manual", signal,
  });
}

export function filterChutesModels(payload: unknown, allows: (id: string) => boolean): ChutesModelCatalog {
  const envelope = record(payload);
  if (!envelope || envelope.object !== "list" || Object.keys(envelope).some(key => key !== "data" && key !== "object")
    || !Array.isArray(envelope.data) || envelope.data.length > 4096) invalid();
  const seen = new Set<string>(), models: ChutesModelRow[] = [];
  for (const value of envelope.data) {
    const row = record(value), id = row?.id;
    if (!row || typeof id !== "string" || !id || id.length > 512 || /[\s\p{Cc}]/u.test(id) || seen.has(id)) invalid();
    seen.add(id);
    if (row.object !== "model") invalid();
    const input = tokens(row.input_modalities, 16), output = tokens(row.output_modalities, 16);
    if (input && !input.includes("text") || output && !output.includes("text") || !allows(id)) continue;
    const model: ChutesModelRow = { id, object: "model" };
    if (input !== undefined) model.input_modalities = input;
    if (output !== undefined) model.output_modalities = output;
    for (const key of LIMIT_KEYS) {
      const value = row[key];
      if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) model[key] = value;
    }
    const features = tokens(row.supported_features, 32), parameters = tokens(row.supported_sampling_parameters, 64);
    if (features !== undefined) model.supported_features = features;
    if (parameters !== undefined) model.supported_sampling_parameters = parameters;
    if (typeof row.confidential_compute === "boolean") model.confidential_compute = row.confidential_compute;
    const pricing = record(row.pricing), observations: NonNullable<ChutesModelRow["pricing"]> = {};
    for (const key of PRICE_KEYS) {
      const value = pricing?.[key];
      if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1_000_000) observations[key] = value;
    }
    if (Object.keys(observations).length) model.pricing = observations;
    models.push(model);
  }
  models.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return { object: "list", data: models };
}

export function readChutesModels(response: Response, signal: AbortSignal, allows: (id: string) => boolean): Promise<ChutesModelCatalog> {
  return readNativeJson(response, signal, 2 * 1024 * 1024, payload => filterChutesModels(payload, allows), invalid);
}
