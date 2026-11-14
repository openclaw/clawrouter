import { readSearchJson, searchJsonBytes, type MiniMaxSearchOperation } from "./minimax-search-operation.ts";
import type { InputRetirement } from "./input-retirement.ts";
import { mediaObject } from "./managed-media-json.ts";

export const miniMaxSearchPath = "/v1/coding_plan/search";
export const miniMaxSearchOrigins = { global: "https://api.minimax.io", cn: "https://api.minimaxi.com" } as const;
const maxEnvelope = 1024 * 1024, encoder = new TextEncoder();
type Json = Record<string, unknown>;
export interface MiniMaxSearchRequest {
  origin: string; path: typeof miniMaxSearchPath; body: { q: string }; headers: Headers;
}
export interface MiniMaxSearchResult { title: string; url: string; description: string; published?: string }
export interface MiniMaxSearchObservation {
  body: Json; results: MiniMaxSearchResult[]; relatedSearches: string[];
  nativeResultCount: number; omittedResults: boolean;
  // Plan quota, returned rows and an HTTP success are not a USD debit witness.
  upstreamCostMicros: null;
}
export function prepareMiniMaxSearch(region: keyof typeof miniMaxSearchOrigins, value: unknown): MiniMaxSearchRequest {
  if (region !== "global" && region !== "cn") fail("region");
  if (!mediaObject(value) || Object.keys(value).some(key => key !== "q")
    || typeof value.q !== "string" || !value.q.trim() || encoder.encode(value.q).length > 4096
    || /[\x00-\x1f\x7f]/.test(value.q) || !wellFormed(value.q)) fail("request");
  return { origin: miniMaxSearchOrigins[region], path: miniMaxSearchPath, body: { q: value.q },
    headers: new Headers({ "content-type": "application/json", accept: "application/json" }) };
}
export function observeMiniMaxSearch(value: unknown, count: number, complete: boolean): MiniMaxSearchObservation {
  if (!Number.isSafeInteger(count) || count < 1 || count > 10) fail("count");
  if (!complete || !mediaObject(value) || searchJsonBytes(value, "native") > maxEnvelope
    || value.error !== undefined || !mediaObject(value.base_resp) || value.base_resp.status_code !== 0
    || !Array.isArray(value.organic) || value.organic.length > 100
    || value.related_searches !== undefined && (!Array.isArray(value.related_searches) || value.related_searches.length > 50)) fail("response");
  const results: MiniMaxSearchResult[] = [];
  let omittedResults = value.organic.length > count;
  // Validate all rows before exposing any result. Consumer filtering does not
  // alter the native response or invent billing for omitted/empty output.
  for (const [index, raw] of value.organic.entries()) {
    if (!mediaObject(raw)) fail("result");
    const title = text(raw.title, 16384) ?? "", link = text(raw.link, 8192);
    const description = text(raw.snippet, 65536) ?? "", published = text(raw.date, 128);
    let url: URL | undefined;
    try { if (link) url = new URL(link); } catch { /* Omit invalid destinations; never fetch them. */ }
    if (!url || !["https:", "http:"].includes(url.protocol) || url.username || url.password) {
      omittedResults = true; continue;
    }
    if (index < count) results.push({ title, url: url.href, description, ...(published ? { published } : {}) });
  }
  const relatedSearches: string[] = [];
  for (const raw of value.related_searches as unknown[] | undefined ?? []) {
    if (!mediaObject(raw)) fail("related");
    const query = text(raw.query, 4096); if (query) relatedSearches.push(query);
  }
  return { body: value, results, relatedSearches, nativeResultCount: value.organic.length,
    omittedResults, upstreamCostMicros: null };
}
export async function readMiniMaxSearch(response: Response, count: number, signal: AbortSignal, operation?: MiniMaxSearchOperation): Promise<MiniMaxSearchObservation> {
  let input: InputRetirement | undefined;
  try {
    const body = await readSearchJson(response, signal, "native", (owner, source) => {
      input = owner; operation?.registerInput(owner, source);
    });
    // Bound aggregate URL work before URL canonicalization. This is an
    // operational native-reader limit, not a vendor result-size fact.
    if (!mediaObject(body) || !Array.isArray(body.organic) || body.organic.length > 100) fail("response");
    let urlUnits = 0;
    for (const row of body.organic) {
      if (!mediaObject(row) || typeof row.link !== "string" || row.link.length > 8192
        || (urlUnits += row.link.length) > 16 * 1024) fail("response");
    }
    return observeMiniMaxSearch(body, count, true);
  } catch {
    // The production operation retains physical cleanup separately from prompt failure.
    if (!operation && input) await input.retired.catch(() => undefined);
    return fail("response");
  }
}
function text(value: unknown, limit: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length > limit || !wellFormed(value)) fail("text");
  return value || undefined;
}
function wellFormed(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++i); if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}
function fail(reason: string): never { throw new Error(`invalid_minimax_search_${reason}`); }

