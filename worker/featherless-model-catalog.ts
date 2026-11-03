import { readNativeJson } from "./native-json.ts";
import { HttpError } from "./utils.ts";

export const FEATHERLESS_MODELS_FORMAT = "featherless.models";
const PAGE_SIZE = 100;
const MAX_PAGES = 1000;
const PRICE_KEYS = ["prompt", "completion", "image", "request"] as const;
export interface FeatherlessModelRow {
  id: string;
  context_length?: number;
  max_completion_tokens?: number;
  concurrency_cost?: number;
  is_gated?: boolean;
  available_on_current_plan?: boolean;
  features?: { tool_use?: boolean; image_input?: boolean };
  pricing?: Partial<Record<typeof PRICE_KEYS[number], string>>;
}
export interface FeatherlessModelPage {
  data: FeatherlessModelRow[];
  pagination: { current_page: number; per_page: number; total_items: number; total_pages: number };
  total: number;
}

function invalid(): never {
  throw new HttpError(502, "invalid_model_discovery_response", "Featherless model catalog is invalid or exceeds the discovery bound");
}
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function integer(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}

// Every page uses the same original selected key. Public inventory availability
// never authorizes an anonymous retry of an authenticated catalog request.
export function featherlessCatalogRequest(inferenceBaseUrl: string, selectedApiKey: string, page: number, signal: AbortSignal): Request {
  if (!["https://api.featherless.ai/v1", "https://api.featherless.ai/v1/"].includes(inferenceBaseUrl)
    || typeof selectedApiKey !== "string" || !/^[\x21-\x7e]{1,8192}$/.test(selectedApiKey) || !integer(page, 1, MAX_PAGES)) {
    throw new HttpError(503, "provider_catalog_not_supported", "Featherless catalog requires its canonical service, selected credential and bounded page");
  }
  return new Request(`https://api.featherless.ai/v1/models?capabilities=chat&page=${page}&per_page=${PAGE_SIZE}`, {
    method: "GET", headers: { accept: "application/json", authorization: `Bearer ${selectedApiKey}` },
    credentials: "omit", redirect: "error", signal,
  });
}

export function filterFeatherlessModels(payload: unknown, allows: (id: string) => boolean, expectedPage: number): FeatherlessModelPage {
  const envelope = record(payload), pagination = record(envelope?.pagination);
  if (!integer(expectedPage, 1, MAX_PAGES) || !envelope || !pagination
    || Object.keys(envelope).some(key => !["data", "pagination", "total"].includes(key))
    || Object.keys(pagination).some(key => !["current_page", "per_page", "total_items", "total_pages"].includes(key))
    || pagination.current_page !== expectedPage || pagination.per_page !== PAGE_SIZE
    || !integer(pagination.total_items, 0, PAGE_SIZE * MAX_PAGES) || !integer(pagination.total_pages, 0, MAX_PAGES)
    || envelope.total !== pagination.total_items || !Array.isArray(envelope.data) || envelope.data.length > PAGE_SIZE
    || pagination.total_items === 0 && (expectedPage !== 1 || pagination.total_pages > 1 || envelope.data.length !== 0)
    || pagination.total_items > 0 && (pagination.total_pages !== Math.ceil(pagination.total_items / PAGE_SIZE)
      || expectedPage > pagination.total_pages || envelope.data.length > pagination.total_items)) invalid();
  const seen = new Set<string>(), models: FeatherlessModelRow[] = [];
  for (const value of envelope.data) {
    const row = record(value), id = row?.id;
    if (!row || typeof id !== "string" || !id || id.length > 512 || /[\s\p{Cc}]/u.test(id) || seen.has(id)
      || row.available_on_current_plan !== undefined && typeof row.available_on_current_plan !== "boolean") invalid();
    seen.add(id);
    if (row.object !== undefined && row.object !== "model" || row.status !== undefined && row.status !== "active"
      || row.available_on_current_plan === false || !allows(id)) continue;
    const model: FeatherlessModelRow = { id };
    for (const key of ["context_length", "max_completion_tokens", "concurrency_cost"] as const) {
      if (integer(row[key], 1)) model[key] = row[key];
    }
    for (const key of ["is_gated", "available_on_current_plan"] as const) {
      if (typeof row[key] === "boolean") model[key] = row[key];
    }
    const features = record(row.features), observedFeatures: NonNullable<FeatherlessModelRow["features"]> = {};
    for (const key of ["tool_use", "image_input"] as const) {
      if (typeof features?.[key] === "boolean") observedFeatures[key] = features[key];
    }
    if (Object.keys(observedFeatures).length) model.features = observedFeatures;
    const pricing = record(row.pricing), observations: NonNullable<FeatherlessModelRow["pricing"]> = {};
    for (const key of PRICE_KEYS) {
      const value = pricing?.[key];
      if (typeof value === "string" && /^(?:0|[1-9]\d{0,5})(?:\.\d{1,18})?$/.test(value)) observations[key] = value;
    }
    if (Object.keys(observations).length) model.pricing = observations;
    models.push(model);
  }
  // Preserve upstream page progress even when the policy removes every row.
  // A short or empty page is not terminal while total_pages advertises more.
  return { data: models, pagination: { current_page: expectedPage, per_page: PAGE_SIZE,
    total_items: pagination.total_items, total_pages: pagination.total_pages }, total: pagination.total_items };
}

export function readFeatherlessModels(response: Response, signal: AbortSignal, allows: (id: string) => boolean, expectedPage: number): Promise<FeatherlessModelPage> {
  return readNativeJson(response, signal, 2 * 1024 * 1024, payload => filterFeatherlessModels(payload, allows, expectedPage), invalid);
}
