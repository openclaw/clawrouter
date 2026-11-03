import { readNativeJson } from "./native-json";
import { HttpError } from "./utils";

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_ROWS = 4096;

export interface DeepInfraTokenPricing {
  currency: "USD";
  unit: "cents_per_token";
  input: number;
  output: number;
  discount: number | null;
  cachedInputRatio: number | null;
}

export interface DeepInfraCatalogModel {
  id: string;
  tags: string[];
  contextWindow: number | null;
  // Native max_tokens is not a qualified completion limit.
  nativeMaxTokens: number | null;
  reasoning: true | null;
  vision: true | null;
  pricing: DeepInfraTokenPricing | null;
}

export interface DeepInfraAvailabilityObservation {
  id: string;
  deprecatedAt: number | null;
  servingModel: string | null;
}

export interface DeepInfraCatalog {
  models: DeepInfraCatalogModel[];
  availability: DeepInfraAvailabilityObservation[];
}

function invalid(): never {
  throw new HttpError(502, "provider_catalog_invalid", "DeepInfra model catalog is invalid");
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function id(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 512 || /[\s\p{Cc}]/u.test(value)) invalid();
  return value;
}

function positive(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function amount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function tokenPricing(value: unknown): DeepInfraTokenPricing | null {
  const row = record(value);
  if (!row || row.type !== "tokens") return null;
  const input = amount(row.cents_per_input_token), output = amount(row.cents_per_output_token);
  const discount = amount(row.discount), cachedInputRatio = amount(row.rate_per_input_token_cached);
  if (input === null || output === null || row.discount != null && (discount === null || discount > 1)
    || row.rate_per_input_token_cached != null && cachedInputRatio === null
    || row.full != null && row.full !== ""
    || row.table != null && (!record(row.table) || Object.keys(row.table as object).length > 0)
    || row.discount_ends_at != null || row.rate_per_input_token_cache_write != null) return null;
  // Observations only: no discount arithmetic, cache-write zero, service-tier or retention tariff.
  return { currency: "USD", unit: "cents_per_token", input, output, discount, cachedInputRatio };
}

export function deepinfraCatalogRequests(
  inferenceBaseUrl: string, selectedApiKey: string, signal: AbortSignal,
): { metadata: Request; pricing: Request } {
  if (!["https://api.deepinfra.com/v1/openai", "https://api.deepinfra.com/v1/openai/"].includes(inferenceBaseUrl)
    || typeof selectedApiKey !== "string" || !/^[\x21-\x7e]{1,8192}$/.test(selectedApiKey)) {
    throw new HttpError(503, "provider_catalog_not_supported", "DeepInfra catalog requires its canonical service and selected credential");
  }
  const options = { method: "GET", credentials: "omit", redirect: "error", signal } as const;
  return {
    metadata: new Request("https://api.deepinfra.com/v1/openai/models?sort_by=openclaw&filter=with_meta", {
      ...options, headers: { accept: "application/json", authorization: `Bearer ${selectedApiKey}` },
    }),
    pricing: new Request("https://api.deepinfra.com/models/list", { ...options, headers: { accept: "application/json" } }),
  };
}

function metadataModels(payload: unknown): Omit<DeepInfraCatalogModel, "pricing">[] {
  const envelope = record(payload);
  if (envelope?.object !== "list" || !Array.isArray(envelope.data) || envelope.data.length > MAX_ROWS) invalid();
  const seen = new Set<string>(), models: Omit<DeepInfraCatalogModel, "pricing">[] = [];
  for (const value of envelope.data) {
    const row = record(value), modelId = id(row?.id);
    if (!row || row.object !== "model" || seen.has(modelId)) invalid();
    seen.add(modelId);
    if (row.metadata === null) continue;
    const metadata = record(row.metadata), tags = metadata?.tags;
    if (!metadata || !Array.isArray(tags) || tags.length > 64
      || !tags.every(tag => typeof tag === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(tag))) invalid();
    models.push({ id: modelId, tags: [...new Set(tags)], contextWindow: positive(metadata.context_length),
      nativeMaxTokens: positive(metadata.max_tokens),
      reasoning: tags.includes("reasoning") || tags.includes("reasoning_effort") ? true : null,
      vision: tags.includes("vlm") || tags.includes("vision") ? true : null });
  }
  if (envelope.data.length && !models.length) invalid();
  const chat = models.filter(model => model.tags.includes("chat"));
  return chat.length ? chat : models.filter(model => model.tags.includes("vlm"));
}

function nativeRows(payload: unknown): Map<string, { pricing: DeepInfraTokenPricing | null; availability: DeepInfraAvailabilityObservation | null }> {
  if (!Array.isArray(payload) || payload.length > MAX_ROWS) invalid();
  const rows = new Map<string, { pricing: DeepInfraTokenPricing | null; availability: DeepInfraAvailabilityObservation | null }>();
  for (const value of payload) {
    const row = record(value), modelId = id(row?.model_name);
    if (!row || rows.has(modelId)) invalid();
    const deprecatedAt = row.deprecated == null ? null : positive(row.deprecated);
    if (row.deprecated != null && deprecatedAt === null) invalid();
    const servingModel = row.replaced_by == null ? null : id(row.replaced_by);
    if (servingModel === modelId) invalid();
    rows.set(modelId, {
      pricing: tokenPricing(row.pricing),
      availability: deprecatedAt !== null || servingModel !== null ? { id: modelId, deprecatedAt, servingModel } : null,
    });
  }
  return rows;
}

function project(
  models: Omit<DeepInfraCatalogModel, "pricing">[], native: ReturnType<typeof nativeRows>, permittedModelIds: ReadonlySet<string>,
): DeepInfraCatalog {
  const compare = (a: { id: string }, b: { id: string }) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  return {
    models: models.filter(model => permittedModelIds.has(model.id))
      .map(model => ({ ...model, pricing: native.get(model.id)?.pricing ?? null })).sort(compare),
    availability: [...native.values()].flatMap(row => row.availability && permittedModelIds.has(row.availability.id) ? [row.availability] : []).sort(compare),
  };
}

export function parseDeepInfraCatalog(metadata: unknown, pricing: unknown, permittedModelIds: ReadonlySet<string>): DeepInfraCatalog {
  return project(metadataModels(metadata), nativeRows(pricing), permittedModelIds);
}

export async function readDeepInfraCatalog(
  responses: { metadata: Response; pricing: Response }, signal: AbortSignal, permittedModelIds: ReadonlySet<string>,
): Promise<DeepInfraCatalog> {
  // Finish both independent readers before publishing. A failed metadata request
  // never falls back to a seed; failed pricing only permits an authoritative empty inventory.
  const [metadata, pricing] = await Promise.allSettled([
    readNativeJson(responses.metadata, signal, MAX_BYTES, metadataModels, invalid),
    readNativeJson(responses.pricing, signal, MAX_BYTES, nativeRows, invalid),
  ]);
  if (signal.aborted || metadata.status === "rejected") invalid();
  if (pricing.status === "rejected") {
    if (metadata.value.length) invalid();
    return { models: [], availability: [] };
  }
  return project(metadata.value, pricing.value, permittedModelIds);
}
