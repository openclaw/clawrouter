import { toolEvidenceLimit } from "./responses-tool-evidence.ts";

export interface HostedSearchUsage { webSearch: number; complete: boolean }
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
// A count is an observed search item, not a per-query invoice or an upper bound.
// The protocol does not qualify failed actions or expose search content tokens.
function call(value: unknown): number | null {
  if (!record(value) || typeof value.type !== "string") return null;
  if (value.type !== "web_search_call") return 0;
  return record(value.action) && ["open_page", "find_in_page"].includes(value.action.type as string) ? 0 : 1;
}
type Item = { id?: string; index?: number; count: number; done: boolean };

// Consumes only the existing bounded tool-evidence projection. No JSON/SSE
// parser, response content, queries, URLs or raw action objects are retained.
export function createHostedSearchUsage() {
  const items = new Set<Item>(), ids = new Map<string, Item>(), indices = new Map<number, Item>();
  let uncertain = false, terminal = false, complete = false, total = 0, observed = false, anonymousSearch = false;
  function observe(value: unknown, position: unknown, done: boolean) {
    if (!record(value)) { uncertain = true; return; }
    observed ||= value.type === "web_search_call";
    const count = call(value);
    if (count === null) { uncertain = true; return; }
    const id = value.id, index = position;
    if (id !== undefined && (typeof id !== "string" || !id.length || id.length > 256)
      || index !== undefined && (!Number.isSafeInteger(index) || (index as number) < 0)) { uncertain = true; return; }
    const byId = typeof id === "string" ? ids.get(id) : undefined, byIndex = typeof index === "number" ? indices.get(index) : undefined;
    if (byId && byIndex && byId !== byIndex) { uncertain = true; return; }
    // Done-only anonymous items cannot be safely deduplicated in the stream.
    // Defer their count to the terminal snapshot, never infer stream positions.
    if (id === undefined && index === undefined) { if (!done) uncertain = true; else anonymousSearch ||= count > 0; return; }
    let item = byId ?? byIndex;
    if (!item) {
      if (items.size >= toolEvidenceLimit) { uncertain = true; return; }
      item = { count, done: false }; items.add(item);
    }
    if (item.id !== undefined && id !== undefined && item.id !== id || item.index !== undefined && index !== undefined && item.index !== index) { uncertain = true; return; }
    if (typeof id === "string") { item.id = id; ids.set(id, item); }
    if (typeof index === "number") { item.index = index; indices.set(index, item); }
    if (item.done && done && item.count !== count) uncertain = true;
    if (done) { item.count = count; item.done = true; }
  }
  return {
    invalid() { uncertain = true; complete = false; },
    accept(value: unknown, sse: boolean) {
      if (terminal) return;
      if (!record(value)) { uncertain = true; return; }
      if (sse && ["response.output_item.added", "response.output_item.done"].includes(value.type as string)) {
        observe(value.item, value.output_index, value.type === "response.output_item.done"); return;
      }
      const response = sse ? record(value.response) ? value.response : null : value;
      const ended = sse ? ["response.completed", "response.incomplete", "response.failed", "response.cancelled"].includes(value.type as string)
        : response && ["completed", "incomplete", "failed", "cancelled"].includes(response.status as string);
      if (!ended) return;
      terminal = true;
      if (!response || !Array.isArray(response.output) || response.output.length > toolEvidenceLimit) { uncertain = true; return; }
      const seen = new Set<string>();
      let count = 0;
      for (const [index, value] of response.output.entries()) {
        observed ||= record(value) && value.type === "web_search_call";
        const next = call(value);
        if (next === null || !record(value)) { uncertain = true; continue; }
        if (typeof value.id === "string") {
          if (seen.has(value.id)) { uncertain = true; continue; }
          seen.add(value.id);
        }
        const item = indices.get(index) ?? (typeof value.id === "string" ? ids.get(value.id) : undefined);
        if (item && (item.id !== undefined && value.id !== item.id || item.index !== undefined && item.index !== index || item.done && item.count !== next)) uncertain = true;
        count += next;
      }
      for (const item of items) if (item.index !== undefined ? item.index >= response.output.length : item.id !== undefined && !seen.has(item.id)) uncertain = true;
      if (anonymousSearch && count === 0) uncertain = true;
      total = count;
      complete = !uncertain && typeof response.id === "string" && response.id.length > 0 && response.id.length <= 256
        && (sse || response.object === "response") && ["completed", "incomplete"].includes(response.status as string)
        && (!sse || value.type === "response.completed" || value.type === "response.incomplete");
    },
    result(ended: boolean): HostedSearchUsage | undefined {
      if (!observed) return undefined;
      return { webSearch: terminal ? total || [...items].reduce((sum, item) => sum + (item.done ? item.count : 0), 0)
        : [...items].reduce((sum, item) => sum + (item.done ? item.count : 0), 0), complete: ended && complete && !uncertain };
    },
  };
}
