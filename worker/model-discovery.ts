import type { ModelDiscoveryAdapter, ModelDiscoveryFailure, ObservedModel } from "../shared/contracts.ts";

const MAX_BYTES = 1024 * 1024;
const MAX_MODELS = 1000;
const MAX_PAGES = 10;
export const MODEL_DISCOVERY_TIMEOUT_MS = 10_000;
export type ModelDiscoveryResult = { models: ObservedModel[]; error: null } | { models: null; error: ModelDiscoveryFailure };

class DiscoveryError extends Error {
  readonly code: ModelDiscoveryFailure;
  constructor(code: ModelDiscoveryFailure) { super(code); this.code = code; }
}

// Fixed list-only origins and no redirects: a manifest never supplies a URL
// that can receive the account secret. No quota or inference feedback is emitted.
export async function discoverModels(adapter: ModelDiscoveryAdapter, headers: Headers): Promise<ModelDiscoveryResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MODEL_DISCOVERY_TIMEOUT_MS);
  const budget = { bytes: 0 }, models = new Map<string, ObservedModel>(), tokens = new Set<string>();
  let pageToken = "";
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const url = new URL(adapter === "openai.models" ? "https://api.openai.com/v1/models" : "https://generativelanguage.googleapis.com/v1beta/models");
      if (adapter === "google.models") {
        url.searchParams.set("pageSize", "1000");
        if (pageToken) url.searchParams.set("pageToken", pageToken);
      }
      const response = await fetch(url, { method: "GET", headers, redirect: "error", signal: controller.signal });
      if (!response.ok) { void response.body?.cancel().catch(() => {}); throw new DiscoveryError("upstream_rejected"); }
      const parsed = parseModelPage(adapter, await responseJson(response, budget));
      for (const model of parsed.models) {
        const previous = models.get(model.id);
        if (previous && JSON.stringify(previous) !== JSON.stringify(model)) throw new DiscoveryError("invalid_response");
        models.set(model.id, model);
        if (models.size > MAX_MODELS) throw new DiscoveryError("limit_exceeded");
      }
      if (!parsed.nextPageToken) return { models: [...models.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0), error: null };
      if (tokens.has(parsed.nextPageToken)) throw new DiscoveryError("invalid_response");
      tokens.add(parsed.nextPageToken);
      pageToken = parsed.nextPageToken;
    }
    throw new DiscoveryError("limit_exceeded");
  } catch (error) {
    return { models: null, error: controller.signal.aborted ? "timeout" : error instanceof DiscoveryError ? error.code : "transport_error" };
  } finally { clearTimeout(timer); }
}

export function parseModelPage(adapter: ModelDiscoveryAdapter, value: unknown): { models: ObservedModel[]; nextPageToken: string } {
  const body = object(value);
  if (adapter === "openai.models") {
    if (body.object !== "list" || !Array.isArray(body.data)) invalid();
    return { models: body.data.map(value => {
      const row = object(value);
      if (row.object !== "model") invalid();
      return { id: text(row.id), created: integer(row.created), ownedBy: text(row.owned_by) };
    }), nextPageToken: "" };
  }
  // ProtoJSON treats omitted/null repeated fields as empty; null elements
  // remain invalid. Page tokens are opaque and are never trimmed or decoded.
  const rows = body.models ?? [];
  if (!Array.isArray(rows)) invalid();
  const nextPageToken = body.nextPageToken ?? "";
  if (typeof nextPageToken !== "string" || nextPageToken.length > 8192) invalid();
  return { models: rows.map(value => {
    const row = object(value), id = text(row.name);
    if (!/^models\/[^/]+$/.test(id)) invalid();
    const model: ObservedModel = { id };
    for (const field of ["baseModelId", "version", "displayName"] as const) if (row[field] != null) model[field] = text(row[field]);
    for (const field of ["inputTokenLimit", "outputTokenLimit"] as const) if (row[field] != null) model[field] = integer(row[field], true);
    const methods = row.supportedGenerationMethods ?? [];
    if (!Array.isArray(methods) || methods.length > 128) invalid();
    model.supportedGenerationMethods = [...new Set(methods.map(method => text(method)))].sort();
    return model;
  }), nextPageToken };
}

async function responseJson(response: Response, budget: { bytes: number }): Promise<unknown> {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length + budget.bytes > MAX_BYTES) {
    void response.body?.cancel().catch(() => {});
    throw new DiscoveryError("limit_exceeded");
  }
  const reader = response.body?.getReader();
  if (!reader) invalid();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      budget.bytes += value.byteLength;
      if (budget.bytes > MAX_BYTES) throw new DiscoveryError("limit_exceeded");
      chunks.push(value);
    }
  } catch (error) { void reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  const joined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(joined)); }
  catch { return invalid(); }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown, limit = 1024): string {
  if (typeof value !== "string" || !value.trim() || value.length > limit || /[\u0000-\u001f\u007f]/.test(value)) invalid();
  return value;
}
function integer(value: unknown, proto = false): number {
  if (proto && typeof value === "string" && /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value)) value = Number(value);
  if (!Number.isSafeInteger(value) || (value as number) < 0 || proto && (value as number) > 2_147_483_647) invalid();
  return value as number;
}
function invalid(): never { throw new DiscoveryError("invalid_response"); }
