import { readNativeJson } from "./native-json.ts";
import { HttpError } from "./utils.ts";

export const NOVITA_MODELS_FORMAT = "novita.models";
export interface NovitaModelRow {
  id: string;
  object: "model";
  created: number;
  context_size: number;
  input_token_price_per_m?: number;
  output_token_price_per_m?: number;
}
export interface NovitaModelCatalog { data: NovitaModelRow[] }

function invalid(): never {
  throw new HttpError(502, "invalid_model_discovery_response", "Novita model catalog is invalid or exceeds the discovery bound");
}
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function integer(value: unknown, min: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min;
}

export function novitaCatalogRequest(inferenceBaseUrl: string, selectedApiKey: string, signal: AbortSignal): Request {
  if (!["https://api.novita.ai/openai/v1", "https://api.novita.ai/openai/v1/"].includes(inferenceBaseUrl)
    || typeof selectedApiKey !== "string" || !/^[\x21-\x7e]{1,8192}$/.test(selectedApiKey)) {
    throw new HttpError(503, "provider_catalog_not_supported", "Novita catalog requires its canonical inference service and selected credential");
  }
  return new Request("https://api.novita.ai/openai/v1/models", {
    method: "GET", headers: { accept: "application/json", "content-type": "application/json", authorization: `Bearer ${selectedApiKey}` },
    credentials: "omit", redirect: "manual", signal,
  });
}

// The primary native list is data-only. Do not fabricate an OpenAI list marker
// or convert integer price observations into a currency or inference tariff.
export function filterNovitaModels(payload: unknown, allows: (id: string) => boolean): NovitaModelCatalog {
  const envelope = record(payload);
  if (!envelope || Object.keys(envelope).some(key => key !== "data")
    || !Array.isArray(envelope.data) || envelope.data.length > 4096) invalid();
  const seen = new Set<string>(), models: NovitaModelRow[] = [];
  for (const value of envelope.data) {
    const row = record(value), id = row?.id;
    if (!row || typeof id !== "string" || !id || id.length > 512 || /[\s\p{Cc}]/u.test(id) || seen.has(id)
      || row.object !== "model" || !integer(row.created, 0) || !integer(row.context_size, 1)) invalid();
    seen.add(id);
    if (!allows(id)) continue;
    const model: NovitaModelRow = { id, object: "model", created: row.created, context_size: row.context_size };
    for (const key of ["input_token_price_per_m", "output_token_price_per_m"] as const) {
      const price = row[key];
      if (integer(price, 0)) model[key] = price;
    }
    models.push(model);
  }
  models.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return { data: models };
}

export function readNovitaModels(response: Response, signal: AbortSignal, allows: (id: string) => boolean): Promise<NovitaModelCatalog> {
  return readNativeJson(response, signal, 2 * 1024 * 1024, payload => filterNovitaModels(payload, allows), invalid);
}
