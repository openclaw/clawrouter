import { mediaObject, readMediaJson } from "./managed-media-json.ts";

// Evidence for the native public Search API, never Chat or a hosted tool call.
// Runtime must pin the qualified endpoint/credential and pricing witness.
export const deepSeekSearchTariff = {
  source: "https://api-docs.deepseek.com/guides/search/",
  checkedAt: "2026-11-03",
  effectiveAt: "2026-11-01T00:00:00+08:00",
  currency: "USD",
  successfulNonemptyRequestMicros: 750,
  emptyRequestMicros: 0,
} as const;

export interface DeepSeekSearchRequest {
  path: "/v1/tools/search";
  body: { query: string; count: number; need_content: false };
  headers: Headers;
}

export function prepareDeepSeekSearch(value: unknown): DeepSeekSearchRequest {
  if (!mediaObject(value) || Object.keys(value).some(key => !["query", "count", "need_content"].includes(key))
    || typeof value.query !== "string" || !value.query.trim()) throw new Error("invalid_deepseek_search_request");
  const characters = [...value.query];
  if (characters.length > 128 || characters.some(character => {
    const code = character.codePointAt(0)!; return code >= 0xd800 && code <= 0xdfff;
  })) throw new Error("invalid_deepseek_search_query");
  const count = value.count === undefined ? 5 : value.count;
  if (!Number.isInteger(count) || Number(count) < 1 || Number(count) > 10
    || value.need_content !== undefined && value.need_content !== false) throw new Error("unsupported_deepseek_search_options");
  return { path: "/v1/tools/search", body: { query: value.query, count: Number(count), need_content: false },
    headers: new Headers({ "content-type": "application/json", accept: "application/json" }) };
}

export interface DeepSeekSearchResult { title: string; url: string; snippet?: string; published?: string; siteName?: string }
export interface DeepSeekSearchObservation {
  body: Record<string, unknown>;
  results: DeepSeekSearchResult[];
  nativeResultCount: number;
  omittedResults: boolean;
  // Apply the captured native Search tariff only after qualified full delivery.
  // Client filtering does not turn a nonempty native response into free work.
  billableRequests: 0 | 1;
}

export function observeDeepSeekSearch(body: unknown, request: DeepSeekSearchRequest, complete: boolean): DeepSeekSearchObservation {
  if (!complete || !mediaObject(body) || body.error !== undefined || !Array.isArray(body.results) || body.results.length > 50) throw new Error("invalid_deepseek_search_response");
  const results: DeepSeekSearchResult[] = [];
  let omittedResults = body.results.length > request.body.count;
  for (const row of body.results.slice(0, request.body.count)) {
    if (!mediaObject(row)) throw new Error("invalid_deepseek_search_result");
    const candidate = optionalText(row.url, 2048);
    let url: URL | null = null;
    try { if (candidate) url = new URL(candidate); } catch { /* Invalid destinations are omitted, never fetched. */ }
    if (!url || !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.href.length > 2048) {
      omittedResults = true; continue;
    }
    const published = optionalText(row.date, 128);
    results.push({ title: optionalText(row.title, 65536) ?? "", url: url.href,
      snippet: optionalText(row.summary, 131072) ?? optionalText(row.snippet, 131072),
      published: published && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(published)
        && Number.isFinite(Date.parse(published)) ? published : undefined,
      siteName: optionalText(row.site_name, 4096) });
  }
  return { body, results, nativeResultCount: body.results.length, omittedResults,
    billableRequests: body.results.length ? 1 : 0 };
}

// The original upstream fetch must carry the runtime deadline/caller signal.
// Status, JSON MIME, byte bound and complete UTF-8 EOF precede billing evidence.
export async function readDeepSeekSearch(response: Response, request: DeepSeekSearchRequest): Promise<DeepSeekSearchObservation> {
  const { body } = await readMediaJson(response, status => status === 200);
  return observeDeepSeekSearch(body, request, true);
}

function optionalText(value: unknown, limit: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length > limit) throw new Error("invalid_deepseek_search_text");
  return value.trim() || undefined;
}
