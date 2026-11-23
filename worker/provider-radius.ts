import type { UsageInspection, UsageTokens } from "./token-usage.ts";

type JsonRecord = Record<string, unknown>;
const record = (value: unknown): JsonRecord | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const text = (value: unknown): value is string => typeof value === "string";
function requireRadius(condition: unknown, field: string): asserts condition { if (!condition) throw new Error(`invalid_radius_${field}`); }

export interface RadiusRequest { model: string; context: JsonRecord & { messages: JsonRecord[] }; options?: JsonRecord }
export function prepareRadiusRequest(value: unknown, selectedModel: string): RadiusRequest {
  const body = record(value), context = record(body?.context), options = body?.options === undefined ? undefined : record(body.options);
  requireRadius(body && selectedModel.trim() && context && Array.isArray(context.messages), "request");
  requireRadius(body.options === undefined || options, "options");
  requireRadius(!options || Object.keys(options).every(key => ["temperature", "maxTokens", "reasoning", "cacheRetention", "sessionId", "toolChoice"].includes(key)), "option_fields");
  requireRadius(Object.keys(body).every(key => ["model", "context", "options"].includes(key)), "fields");
  for (const value of context.messages) {
    const message = record(value);
    requireRadius(message && ["system", "user", "assistant", "toolResult"].includes(message.role as string) && (text(message.content) || Array.isArray(message.content)), "message");
  }
  if (options?.maxTokens !== undefined) requireRadius(count(options.maxTokens) && options.maxTokens > 0, "max_tokens");
  if (options?.temperature !== undefined) requireRadius(typeof options.temperature === "number" && Number.isFinite(options.temperature), "temperature");
  if (options?.reasoning !== undefined) requireRadius(text(options.reasoning), "reasoning");
  if (options?.sessionId !== undefined) requireRadius(text(options.sessionId), "session_id");
  if (options?.cacheRetention !== undefined) requireRadius(["none", "short", "long"].includes(options.cacheRetention as string), "cache_retention");
  const normalized = options ? { ...options } : undefined;
  if (normalized?.reasoning === "off") delete normalized.reasoning;
  return { model: selectedModel, context: context as RadiusRequest["context"], ...(normalized ? { options: normalized } : {}) };
}

export function extractRadiusUsage(value: unknown): UsageTokens | null {
  const usage = record(value);
  if (!usage || !count(usage.input) || !count(usage.output) || !count(usage.cacheRead) || !count(usage.cacheWrite) || !count(usage.totalTokens)) return null;
  // Pi's input bucket excludes cache reads/writes; router input includes them.
  const input = usage.input + usage.cacheRead + usage.cacheWrite, total = input + usage.output;
  if (!Number.isSafeInteger(total) || total !== usage.totalTokens) return null;
  return { input, output: usage.output, total, cached: usage.cacheRead, cacheWrite: usage.cacheWrite, cacheWrite5m: null, cacheWrite1h: null };
}

interface RadiusBlock { type: "text" | "thinking" | "toolcall"; id?: string; name?: string; closed: boolean }

// The shared SSE framer supplies complete JSON data records. No prompt, output,
// tool argument or signature is accumulated; only bounded block identities live.
export function createRadiusEventInspector() {
  const blocks: RadiusBlock[] = [];
  let invalid = false, terminal = false, closed = false;
  let inspection: UsageInspection = { tokens: null, outcome: null };
  function unavailable() { invalid = true; inspection = { tokens: null, outcome: null }; blocks.length = 0; }
  return {
    unavailable,
    accept(value: unknown) {
      if (closed || invalid) return;
      const event = record(value);
      if (!event || !text(event.type) || terminal) { unavailable(); return; }
      if (event.type === "done" || event.type === "error") {
        const success = event.type === "done", tokens = extractRadiusUsage(event.usage), cost = record(record(event.usage)?.cost);
        if (!tokens || !cost || !["input", "output", "cacheRead", "cacheWrite", "total"].every(key => typeof cost[key] === "number" && Number.isFinite(cost[key]) && (cost[key] as number) >= 0)
          || !(success ? ["stop", "length", "toolUse"] : ["error", "aborted"]).includes(event.reason as string)
          || (success && blocks.some(block => block.type === "toolcall" && !block.closed))) { unavailable(); return; }
        terminal = true; inspection = { tokens, outcome: success ? "success" : "provider_error" }; blocks.length = 0; return;
      }
      if (event.type === "start") return;
      const index = event.contentIndex;
      if (!count(index) || index >= 4096) { unavailable(); return; }
      const match = /^(text|thinking|toolcall)_(start|delta|end)$/.exec(event.type);
      if (!match) { unavailable(); return; }
      const type = match[1] as RadiusBlock["type"], phase = match[2];
      if (phase === "start") {
        if (index !== blocks.length || (type === "toolcall" && (!text(event.id) || !text(event.toolName) || event.id.length > 1024 || event.toolName.length > 1024))) { unavailable(); return; }
        blocks.push({ type, closed: false, ...(type === "toolcall" ? { id: event.id as string, name: event.toolName as string } : {}) }); return;
      }
      const block = blocks[index];
      if (!block || block.type !== type || block.closed) { unavailable(); return; }
      if (phase === "delta") { if (!text(event.delta)) unavailable(); return; }
      if (type === "toolcall") {
        const call = record(event.toolCall);
        if (!call || call.type !== "toolCall" || call.id !== block.id || call.name !== block.name || !record(call.arguments) || (call.thoughtSignature !== undefined && !text(call.thoughtSignature))) { unavailable(); return; }
      } else if (!text(event.content) || (event.contentSignature !== undefined && !text(event.contentSignature)) || (type === "thinking" && event.redacted !== undefined && typeof event.redacted !== "boolean")) { unavailable(); return; }
      block.closed = true;
    },
    result(): UsageInspection { closed = true; blocks.length = 0; return { ...inspection }; },
  };
}

// Only fields consumed by the native Radius catalog may cross this boundary.
// Catalog prices remain metadata; they never become Router billing tariffs.
function radiusCatalogModel(value: unknown): JsonRecord & { id: string } {
  const row = record(value);
  requireRadius(row && text(row.id) && row.id.length > 0 && row.id.length <= 512 && !/[\u0000-\u001f\u007f]/.test(row.id), "catalog_model");
  const out: JsonRecord & { id: string } = { id: row.id };
  for (const field of ["name", "enabled", "reasoning", "contextWindow", "maxTokens"] as const) {
    if (row[field] === undefined) continue;
    requireRadius(field === "name" ? text(row[field]) && row[field].length > 0 && row[field].length <= 1024
      : field === "enabled" || field === "reasoning" ? typeof row[field] === "boolean"
      : count(row[field]) && row[field] > 0, "catalog_" + field);
    out[field] = row[field];
  }
  if (row.input !== undefined) {
    requireRadius(Array.isArray(row.input) && row.input.length > 0 && row.input.length <= 2
      && row.input.every(value => value === "text" || value === "image") && new Set(row.input).size === row.input.length, "catalog_input");
    out.input = [...row.input];
  }
  if (row.thinkingLevelMap !== undefined) {
    const levels = record(row.thinkingLevelMap); requireRadius(levels, "catalog_thinking");
    const projected: JsonRecord = {};
    for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
      const mapped = levels[level]; if (mapped === undefined) continue;
      requireRadius(mapped === null || text(mapped) && mapped.length <= 128, "catalog_thinking");
      projected[level] = mapped;
    }
    out.thinkingLevelMap = projected;
  }
  if (row.cost !== undefined) {
    const cost = record(row.cost); requireRadius(cost, "catalog_cost");
    const rates = (value: unknown): JsonRecord => {
      const source = record(value); requireRadius(source, "catalog_cost");
      const projected: JsonRecord = {};
      for (const field of ["input", "output", "cacheRead", "cacheWrite"]) {
        requireRadius(typeof source[field] === "number" && Number.isFinite(source[field]) && source[field] >= 0, "catalog_cost");
        projected[field] = source[field];
      }
      return projected;
    };
    const projected = rates(cost);
    if (cost.tiers !== undefined) {
      requireRadius(Array.isArray(cost.tiers) && cost.tiers.length <= 1024, "catalog_tiers");
      const thresholds = new Set<number>();
      projected.tiers = cost.tiers.map(value => {
        const tier = record(value), threshold = tier?.inputTokensAbove;
        requireRadius(count(threshold) && Number.isSafeInteger(threshold + 1) && !thresholds.has(threshold), "catalog_tiers");
        thresholds.add(threshold);
        return { inputTokensAbove: threshold, ...rates(tier) };
      });
    }
    out.cost = projected;
  }
  return out;
}

export interface RadiusCatalog { baseUrl: string; models: JsonRecord[] }
export function filterRadiusCatalog(value: unknown, trustedBaseUrl: string, allowed: (model: string) => boolean): RadiusCatalog {
  const root = record(value);
  requireRadius(root && text(root.baseUrl) && root.baseUrl.length <= 8192 && Array.isArray(root.models) && root.models.length <= 8192, "catalog");
  let trusted: URL, endpoint: URL;
  try { trusted = new URL(trustedBaseUrl); endpoint = new URL(root.baseUrl); }
  catch { throw new Error("invalid_radius_catalog_origin"); }
  requireRadius([trusted, endpoint].every(url => url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash) && endpoint.origin === trusted.origin, "catalog_origin");
  const seen = new Set<string>(), models: JsonRecord[] = [];
  for (const value of root.models) {
    const model = radiusCatalogModel(value);
    requireRadius(!seen.has(model.id), "catalog_model"); seen.add(model.id);
    if (model.enabled !== false && allowed(model.id)) models.push(model);
  }
  return { baseUrl: endpoint.href.replace(/\/+$/, ""), models };
}
