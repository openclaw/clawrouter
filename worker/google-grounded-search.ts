import { mediaObject } from "./managed-media-json.ts";

export const googleGroundedSearchModel = "gemini-3.6-flash";
const encoder = new TextEncoder(), requestLimit = 128 * 1024, responseLimit = 1024 * 1024;

export function prepareGoogleGroundedSearch(model: string, body: unknown): {
  model: string; body: Record<string, unknown>; path: string; headers: Headers;
} {
  if (model !== googleGroundedSearchModel || !mediaObject(body) || encoder.encode(JSON.stringify(body)).byteLength > requestLimit) fail();
  keys(body, ["contents", "tools"]);
  const content = object(list(body.contents, 1, 1)[0]); keys(content, ["role", "parts"]);
  if (content.role !== undefined && content.role !== "user") fail();
  const part = object(list(content.parts, 1, 1)[0]); keys(part, ["text"]); text(part.text, 65536);
  const tool = object(list(body.tools, 1, 1)[0]); keys(tool, ["google_search"]);
  const search = object(tool.google_search); keys(search, ["timeRangeFilter"]);
  if (search.timeRangeFilter !== undefined) {
    const range = object(search.timeRangeFilter); keys(range, ["startTime", "endTime"]);
    if (timestamp(range.startTime) >= timestamp(range.endTime)) fail();
  }
  return { model, body, path: "/v1beta/models/" + model + ":generateContent",
    headers: new Headers({ "content-type": "application/json", accept: "application/json" }) };
}

export interface GoogleGroundedSearchResult {
  body: Record<string, unknown>;
  content: string;
  citations: Array<{ url: string; title?: string }>;
  // Informational query-list length, never a tariff/charge or zero-cost witness.
  observedQueryCount: number | null;
  filteredCitations: number;
}

export function observeGoogleGroundedSearch(body: unknown, complete: boolean): GoogleGroundedSearchResult {
  if (!complete || !mediaObject(body) || body.error !== undefined) fail();
  if (body.promptFeedback !== undefined) {
    const prompt = object(body.promptFeedback);
    if (prompt.blockReason !== undefined && prompt.blockReason !== "BLOCK_REASON_UNSPECIFIED") fail();
  }
  const candidate = object(list(body.candidates, 1, 1)[0]);
  if (candidate.finishReason !== "STOP") fail();
  const texts: string[] = [];
  let length = 0;
  for (const value of list(object(candidate.content).parts, 1, 64)) {
    const part = object(value);
    if (part.thought !== undefined && typeof part.thought !== "boolean") fail();
    if (part.thought === true) continue;
    if (part.inlineData !== undefined || part.inline_data !== undefined || part.functionCall !== undefined || part.fileData !== undefined) fail();
    if (typeof part.text !== "string" || (length += part.text.length) > 65536) fail();
    if (part.text) texts.push(part.text);
  }
  const content = texts.join("\n");
  // No final answer is not evidence of zero matches or zero charged queries.
  if (!content.trim()) fail();
  const metadata = candidate.groundingMetadata === undefined ? {} : object(candidate.groundingMetadata);
  let observedQueryCount: number | null = null;
  if (metadata.webSearchQueries !== undefined) {
    const queries = list(metadata.webSearchQueries, 0, 64);
    for (const query of queries) text(query, 4096);
    observedQueryCount = queries.length;
  }
  const citations: GoogleGroundedSearchResult["citations"] = [];
  let filteredCitations = 0;
  for (const value of metadata.groundingChunks === undefined ? [] : list(metadata.groundingChunks, 0, 256)) {
    const chunk = object(value);
    if (chunk.web === undefined) { filteredCitations++; continue; }
    const web = object(chunk.web);
    if (web.title !== undefined && (typeof web.title !== "string" || web.title.length > 4096)) fail();
    const url = citationUrl(web.uri);
    if (url === null) { filteredCitations++; continue; }
    citations.push({ url, ...(typeof web.title === "string" ? { title: web.title } : {}) });
  }
  // Keep groundingSupports/searchEntryPoint/native usage unchanged in body.
  // Never execute provider HTML or resolve redirects with upstream credentials.
  return { body, content, citations, observedQueryCount, filteredCitations };
}

export async function readGoogleGroundedSearch(response: Response, signal: AbortSignal): Promise<GoogleGroundedSearchResult> {
  if (signal.aborted || response.redirected || response.status !== 200 || !response.body
    || response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json"
    || Number(response.headers.get("content-length")) > responseLimit) {
    void response.body?.cancel().catch(() => undefined); fail();
  }
  const reader = response.body.getReader(), decoder = new TextDecoder("utf-8", { fatal: true });
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", abort, { once: true });
  let text = "", bytes = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (signal.aborted) fail();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > responseLimit) fail();
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode(); return observeGoogleGroundedSearch(JSON.parse(text), true);
  } catch { void reader.cancel().catch(() => undefined); fail(); }
  finally { signal.removeEventListener("abort", abort); reader.releaseLock(); }
}

function citationUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 8192) return null;
  try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : null; }
  catch { return null; }
}
function timestamp(value: unknown): number {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(value)) fail();
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString().replace(".000Z", "Z") !== value) fail();
  return time;
}
function object(value: unknown): Record<string, unknown> { if (!mediaObject(value)) fail(); return value; }
function list(value: unknown, min: number, max: number): unknown[] { if (!Array.isArray(value) || value.length < min || value.length > max) fail(); return value; }
function keys(value: Record<string, unknown>, allowed: string[]): void { if (Object.keys(value).some(key => !allowed.includes(key))) fail(); }
function text(value: unknown, max: number): void { if (typeof value !== "string" || !value.trim() || value.length > max) fail(); }
function fail(): never { throw new Error("invalid_google_grounded_search"); }
