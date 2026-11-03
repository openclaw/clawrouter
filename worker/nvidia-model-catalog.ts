import { readNativeJson } from "./native-json";
import { HttpError } from "./utils";

const INVENTORY_URL = "https://integrate.api.nvidia.com/v1/models";
const FEATURED_URL = "https://assets.ngc.nvidia.com/products/api-catalog/featured-models.json";
const MAX_BYTES = 2 * 1024 * 1024;

export interface NvidiaPublicModel {
  id: string;
  name: string;
  contextWindow: number;
  outputTokenBudget: number;
  metadataSource: "frozen" | "featured";
  input: readonly ("text" | "image" | "video")[] | null;
  reasoning: boolean | null;
  pricing: null;
}

// Finite OpenClaw 31ad71a inventory. Output budgets are catalog defaults, not
// service/account maxima. Availability always comes from fresh /models.
const FROZEN: readonly NvidiaPublicModel[] = [
  { id: "nvidia/nemotron-3-ultra-550b-a55b", name: "Nemotron 3 Ultra 550B", contextWindow: 1048576, outputTokenBudget: 8192,
    metadataSource: "frozen", input: ["text"], reasoning: true, pricing: null },
  { id: "nvidia/nemotron-3.5-lightning-30b-a3b", name: "Nemotron 3.5 Lightning 30B", contextWindow: 1048576, outputTokenBudget: 16384,
    metadataSource: "frozen", input: ["text"], reasoning: true, pricing: null },
  { id: "nvidia/nemotron-3.5-super-vl-120b-a12b", name: "Nemotron 3.5 Super VL", contextWindow: 1048576, outputTokenBudget: 8192,
    metadataSource: "frozen", input: ["text", "image", "video"], reasoning: true, pricing: null },
  { id: "moonshotai/kimi-k2.6", name: "Kimi K2.6", contextWindow: 262144, outputTokenBudget: 65536,
    metadataSource: "frozen", input: ["text", "image"], reasoning: true, pricing: null },
];

function invalid(): never {
  throw new HttpError(502, "provider_catalog_invalid", "NVIDIA public model catalog is invalid");
}

function unsupported(): never {
  throw new HttpError(503, "provider_catalog_not_supported", "NVIDIA public catalog requires the canonical hosted service");
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function boundedString(value: unknown, id: boolean): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text && text.length <= 200 && !(id ? /[\s\p{Cc}]/u : /[\p{Cc}]/u).test(text) ? text : null;
}

function integer(value: unknown, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= max;
}

export function nvidiaPublicCatalogRequests(inferenceBaseUrl: string, signal: AbortSignal): { inventory: Request; featured: Request } {
  let url: URL;
  try { url = new URL(inferenceBaseUrl); } catch { unsupported(); }
  if (url.origin !== "https://integrate.api.nvidia.com" || !["/v1", "/v1/"].includes(url.pathname)
    || url.username || url.password || url.search || url.hash) {
    unsupported();
  }
  const request = (target: string) => new Request(target, {
    method: "GET", headers: { accept: "application/json" }, credentials: "omit", redirect: "error", signal,
  });
  return { inventory: request(INVENTORY_URL), featured: request(FEATURED_URL) };
}

function inventoryIds(payload: unknown): Set<string> {
  const envelope = record(payload);
  if (envelope?.object !== "list" || !Array.isArray(envelope.data) || envelope.data.length > 4096) invalid();
  const ids = new Set<string>();
  for (const value of envelope.data) {
    const row = record(value), id = boundedString(row?.id, true);
    if (!id || row?.object !== undefined && row.object !== "model" || ids.has(id)) invalid();
    ids.add(id);
  }
  return ids;
}

function featuredModels(payload: unknown): Map<string, NvidiaPublicModel> {
  const rows = record(payload)?.["featured-models"];
  if (!Array.isArray(rows) || rows.length > 32) invalid();
  const models = new Map<string, NvidiaPublicModel>();
  for (const value of rows) {
    const row = record(value), rawId = boundedString(row?.model, true), name = boundedString(row?.["model-name"], false);
    if (!rawId || !name || !integer(row?.context, 10_000_000) || !integer(row?.["max-output"], 1_000_000)) continue;
    const id = rawId.includes("/") ? rawId : `nvidia/${rawId}`;
    if (id.length > 200 || models.has(id)) invalid();
    models.set(id, { id, name, contextWindow: row.context, outputTokenBudget: row["max-output"],
      metadataSource: "featured", input: null, reasoning: null, pricing: null });
  }
  if (rows.length && !models.size) invalid();
  return models;
}

function intersect(inventory: Set<string>, featured: Map<string, NvidiaPublicModel>, permitted: ReadonlySet<string>): NvidiaPublicModel[] {
  const known = new Map(FROZEN.map(model => [model.id, model]));
  const ranked = new Map([...featured].map(([id, model]) => {
    const seed = known.get(id);
    return [id, seed ? { ...model, input: seed.input, reasoning: seed.reasoning } : model] as const;
  }));
  for (const [id, model] of known) if (!ranked.has(id)) ranked.set(id, model);
  // A featured recommendation never revives a missing model or authorizes a grant.
  // Unclassified inventory rows include embeddings and cannot become Chat offers.
  return [...ranked.values()].filter(model => inventory.has(model.id) && permitted.has(model.id))
    .map(model => ({ ...model, input: model.input ? [...model.input] : null }));
}

export function parseNvidiaPublicCatalog(inventory: unknown, featured: unknown, permittedModelIds: ReadonlySet<string>): NvidiaPublicModel[] {
  const ids = inventoryIds(inventory);
  return ids.size ? intersect(ids, featuredModels(featured), permittedModelIds) : [];
}

export async function readNvidiaPublicCatalog(
  inventoryResponse: Response, featuredResponse: Response, signal: AbortSignal, permittedModelIds: ReadonlySet<string>,
): Promise<NvidiaPublicModel[]> {
  const [inventory, featured] = await Promise.allSettled([
    readNativeJson(inventoryResponse, signal, MAX_BYTES, inventoryIds, invalid),
    readNativeJson(featuredResponse, signal, MAX_BYTES, featuredModels, invalid),
  ]);
  if (inventory.status === "rejected" || signal.aborted) invalid();
  // An authoritative empty inventory wins even when featured metadata fails.
  if (!inventory.value.size) return [];
  if (featured.status === "rejected") invalid();
  return intersect(inventory.value, featured.value, permittedModelIds);
}
