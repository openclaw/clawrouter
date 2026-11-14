import { readNativeJson } from "./native-json.ts";
import { HttpError } from "./utils.ts";

export const VENICE_MODELS_FORMAT = "venice.models";
const CAPABILITY_KEYS = ["supportsFunctionCalling", "supportsReasoning", "supportsReasoningEffort", "supportsVision",
  "supportsMultipleImages", "supportsLogProbs", "supportsResponseSchema"] as const;
const PRICE_KEYS = ["input", "output", "cache_input", "cache_write"] as const;
const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
type VeniceEffort = typeof EFFORTS[number];
type VeniceRates = Partial<Record<typeof PRICE_KEYS[number], { usd?: number; diem?: number }>>;
export interface VeniceModelSpec {
  availableContextTokens?: number;
  maxCompletionTokens?: number;
  capabilities?: Partial<Record<typeof CAPABILITY_KEYS[number], boolean>> & {
    reasoningEffortOptions?: VeniceEffort[];
    defaultReasoningEffort?: VeniceEffort;
  };
  offline?: boolean;
  privacy?: "private" | "anonymized";
  deprecation?: { date: string };
  pricing?: VeniceRates & { extended?: VeniceRates & { context_token_threshold: number } };
}
export interface VeniceModelCatalog {
  object: "list";
  type: "text";
  data: { id: string; object: "model"; type: "text"; model_spec?: VeniceModelSpec }[];
}

function invalid(): never {
  throw new HttpError(502, "invalid_model_discovery_response", "Venice text model catalog is invalid or exceeds the discovery bound");
}
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function integer(value: unknown, min: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min;
}
function rates(value: unknown): VeniceRates {
  const row = record(value), result: VeniceRates = {};
  for (const key of PRICE_KEYS) {
    const price = record(row?.[key]), observed: { usd?: number; diem?: number } = {};
    for (const currency of ["usd", "diem"] as const) {
      const amount = price?.[currency];
      if (typeof amount === "number" && Number.isFinite(amount) && amount >= 0 && amount <= 1_000_000) observed[currency] = amount;
    }
    if (Object.keys(observed).length) result[key] = observed;
  }
  return result;
}

// The primary OpenAPI operation explicitly permits anonymous discovery. Private
// caller authorization and original-grant filtering remain local to the router.
export function veniceCatalogRequest(inferenceBaseUrl: string, signal: AbortSignal): Request {
  if (!["https://api.venice.ai/api/v1", "https://api.venice.ai/api/v1/"].includes(inferenceBaseUrl)) {
    throw new HttpError(503, "provider_catalog_not_supported", "Venice text catalog requires its canonical inference service");
  }
  return new Request("https://api.venice.ai/api/v1/models?type=text", {
    method: "GET", headers: { accept: "application/json" }, credentials: "omit", redirect: "manual", signal,
  });
}

export function filterVeniceModels(payload: unknown, allows: (id: string) => boolean): VeniceModelCatalog {
  const envelope = record(payload);
  if (!envelope || envelope.object !== "list" || envelope.type !== "text"
    || Object.keys(envelope).some(key => !["data", "object", "type"].includes(key))
    || !Array.isArray(envelope.data) || envelope.data.length > 4096) invalid();
  const seen = new Set<string>(), models: VeniceModelCatalog["data"] = [];
  for (const value of envelope.data) {
    const row = record(value), id = row?.id;
    if (!row || typeof id !== "string" || !id || id.length > 512 || /[\s\p{Cc}]/u.test(id) || seen.has(id)
      || row.object !== "model" || typeof row.type !== "string") invalid();
    seen.add(id);
    if (row.type !== "text") continue;
    const spec = record(row.model_spec);
    if (row.model_spec !== undefined && !spec || spec?.offline !== undefined && typeof spec.offline !== "boolean") invalid();
    const facts: VeniceModelSpec = {};
    if (spec?.deprecation !== undefined) {
      const deprecation = record(spec.deprecation), date = deprecation?.date;
      if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(date)
        || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString() !== date) invalid();
      facts.deprecation = { date };
    }
    if (spec?.offline === true || !allows(id)) continue;
    for (const key of ["availableContextTokens", "maxCompletionTokens"] as const) {
      const value = spec?.[key];
      if (integer(value, 1)) facts[key] = value;
    }
    if (typeof spec?.offline === "boolean") facts.offline = spec.offline;
    if (spec?.privacy === "private" || spec?.privacy === "anonymized") facts.privacy = spec.privacy;
    const capabilities = record(spec?.capabilities), observedCapabilities: NonNullable<VeniceModelSpec["capabilities"]> = {};
    for (const key of CAPABILITY_KEYS) {
      if (typeof capabilities?.[key] === "boolean") observedCapabilities[key] = capabilities[key];
    }
    const options = capabilities?.reasoningEffortOptions;
    if (observedCapabilities.supportsReasoningEffort === true && Array.isArray(options)
      && options.length > 0 && options.length <= EFFORTS.length && new Set(options).size === options.length
      && options.every((value): value is VeniceEffort => EFFORTS.some(effort => effort === value))) {
      observedCapabilities.reasoningEffortOptions = [...options];
      const defaultEffort = options.find(value => value === capabilities?.defaultReasoningEffort);
      if (defaultEffort !== undefined) observedCapabilities.defaultReasoningEffort = defaultEffort;
    }
    if (Object.keys(observedCapabilities).length) facts.capabilities = observedCapabilities;
    const pricing = record(spec?.pricing), observedPricing: NonNullable<VeniceModelSpec["pricing"]> = rates(pricing);
    const extended = record(pricing?.extended);
    // An invalid extended schedule must not make the base schedule look complete.
    if (pricing?.extended === undefined || extended && integer(extended.context_token_threshold, 0)) {
      if (extended && integer(extended.context_token_threshold, 0)) {
        observedPricing.extended = { ...rates(extended), context_token_threshold: extended.context_token_threshold };
      }
      if (Object.keys(observedPricing).length) facts.pricing = observedPricing;
    }
    models.push({ id, object: "model", type: "text", ...(Object.keys(facts).length ? { model_spec: facts } : {}) });
  }
  models.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return { object: "list", type: "text", data: models };
}

export function readVeniceModels(response: Response, signal: AbortSignal, allows: (id: string) => boolean): Promise<VeniceModelCatalog> {
  return readNativeJson(response, signal, 2 * 1024 * 1024, payload => filterVeniceModels(payload, allows), invalid);
}
