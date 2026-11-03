import { readNativeJson } from "./native-json";
import { HttpError } from "./utils";

const PUBLIC_MODELS_URL = "https://api.cerebras.ai/public/v1/models";
const MAX_CATALOG_BYTES = 2 * 1024 * 1024;
const MAX_CATALOG_ROWS = 4096;

export interface CerebrasPublicModel {
  id: string;
  name: string;
  contextWindow: number;
  maxOutputTokens: number;
  reasoning: boolean | null;
  tools: boolean | null;
  vision: boolean | null;
  preview: boolean | null;
  pricing: { currency: "USD"; inputPerToken: string; outputPerToken: string } | null;
}

function invalid(): never {
  throw new HttpError(502, "provider_catalog_invalid", "Cerebras public model catalog is invalid");
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function flag(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function rate(value: unknown): string | null {
  // Preserve exact decimal observations; no float conversion, cache tariff or zero default.
  return typeof value === "string" && /^(?:0|[1-9]\d{0,5})(?:\.\d{1,18})?$/.test(value) ? value : null;
}

export function cerebrasPublicCatalogRequest(inferenceBaseUrl: string, signal: AbortSignal): Request {
  let url: URL;
  try { url = new URL(inferenceBaseUrl); } catch {
    throw new HttpError(503, "provider_catalog_not_supported", "Cerebras public catalog requires the canonical inference service");
  }
  if (url.origin !== "https://api.cerebras.ai" || !["/v1", "/v1/"].includes(url.pathname)
    || url.username || url.password || url.search || url.hash) {
    throw new HttpError(503, "provider_catalog_not_supported", "Cerebras public catalog requires the canonical inference service");
  }
  return new Request(PUBLIC_MODELS_URL, {
    method: "GET", headers: { accept: "application/json" }, credentials: "omit", redirect: "error", signal,
  });
}

export function parseCerebrasPublicCatalog(payload: unknown, permittedModelIds: ReadonlySet<string>): CerebrasPublicModel[] {
  const envelope = record(payload);
  if (envelope?.object !== "list" || !Array.isArray(envelope.data) || envelope.data.length > MAX_CATALOG_ROWS) invalid();
  const models = new Map<string, CerebrasPublicModel>();
  for (const value of envelope.data) {
    const row = record(value), id = typeof row?.id === "string" ? row.id.trim() : "";
    const limits = record(row?.limits);
    if (!row || !id || id.length > 512 || /[\s\p{Cc}]/u.test(id) || !permittedModelIds.has(id)
      || row.object !== undefined && row.object !== "model" || row.deprecated === true
      || row.deprecated !== undefined && typeof row.deprecated !== "boolean"
      || !positiveInteger(limits?.max_context_length) || !positiveInteger(limits?.max_completion_tokens)) continue;
    if (models.has(id)) invalid();
    const capabilities = record(row.capabilities), pricing = record(row.pricing);
    const input = rate(pricing?.prompt), output = rate(pricing?.completion);
    const name = typeof row.name === "string" ? row.name.trim() : "";
    models.set(id, {
      id, name: name && name.length <= 512 && !/[\p{Cc}]/u.test(name) ? name : id,
      contextWindow: limits.max_context_length, maxOutputTokens: limits.max_completion_tokens,
      reasoning: flag(capabilities?.reasoning), tools: flag(capabilities?.tools), vision: flag(capabilities?.vision),
      preview: flag(row.preview),
      pricing: input !== null && output !== null ? { currency: "USD", inputPerToken: input, outputPerToken: output } : null,
    });
  }
  return [...models.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export function readCerebrasPublicCatalog(
  response: Response, signal: AbortSignal, permittedModelIds: ReadonlySet<string>,
): Promise<CerebrasPublicModel[]> {
  return readNativeJson(response, signal, MAX_CATALOG_BYTES,
    payload => parseCerebrasPublicCatalog(payload, permittedModelIds), invalid);
}
