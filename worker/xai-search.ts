import { mediaObject } from "./managed-media-json.ts";
import { readNativeJson } from "./native-json.ts";

const maxEnvelope = 1024 * 1024, maxAnswer = 20000;
const encoder = new TextEncoder();
type Json = Record<string, unknown>;
type SearchKind = "web_search" | "x_search";

// Supplied by the admitted catalog/route, never extracted from caller authority.
export interface XaiSearchQualification {
  model: string;
  servingModels: readonly string[];
  reasoningEfforts: readonly string[];
}
export interface XaiSearchRequest {
  path: "/v1/responses"; body: Json; headers: Headers;
  model: string; servingModels: readonly string[]; kind: SearchKind;
}
export function prepareXaiSearch(value: unknown, qualification: XaiSearchQualification): XaiSearchRequest {
  const body = object(value);
  keys(body, ["model", "input", "tools", "store", "reasoning", "max_turns"]);
  if (!modelId(qualification.model) || !qualification.servingModels.length || qualification.servingModels.length > 8
    || qualification.servingModels.some(model => !modelId(model)) || body.model !== qualification.model || body.store !== false
    || !Array.isArray(body.input) || body.input.length !== 1 || !Array.isArray(body.tools) || body.tools.length !== 1) fail("request");
  const input = object(body.input[0]); keys(input, ["role", "content"]);
  if (input.role !== "user" || !validText(input.content, 32768) || !input.content.trim()) fail("input");
  const tool = object(body.tools[0]);
  if (tool.type !== "web_search" && tool.type !== "x_search") fail("tool");
  const kind = tool.type;
  if (kind === "web_search") keys(tool, ["type"]); // The frozen client sends no web filters.
  else {
    keys(tool, ["type", "allowed_x_handles", "excluded_x_handles", "from_date", "to_date", "enable_image_understanding", "enable_video_understanding"]);
    if (tool.allowed_x_handles !== undefined && tool.excluded_x_handles !== undefined) fail("handles");
    for (const key of ["allowed_x_handles", "excluded_x_handles"]) {
      const handles = tool[key];
      if (handles !== undefined && (!Array.isArray(handles) || !handles.length || handles.length > 20
        || handles.some(handle => typeof handle !== "string" || !/^[a-zA-Z0-9_]{1,15}$/.test(handle))
        || new Set(handles.map(handle => String(handle).toLowerCase())).size !== handles.length)) fail("handles");
    }
    for (const key of ["from_date", "to_date"]) {
      const date = tool[key];
      if (date !== undefined && (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)
        || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date)) fail("date");
    }
    if (typeof tool.from_date === "string" && typeof tool.to_date === "string" && tool.from_date >= tool.to_date) fail("date_range");
    for (const key of ["enable_image_understanding", "enable_video_understanding"]) {
      if (tool[key] !== undefined && typeof tool[key] !== "boolean") fail("understanding");
    }
  }
  if (body.max_turns !== undefined && (!Number.isSafeInteger(body.max_turns) || Number(body.max_turns) < 1 || Number(body.max_turns) > 10)) fail("turns");
  if (body.reasoning !== undefined) {
    const reasoning = object(body.reasoning); keys(reasoning, ["effort"]);
    if (typeof reasoning.effort !== "string" || !["none", "minimal", "low", "medium", "high", "xhigh"].includes(reasoning.effort)
      || !qualification.reasoningEfforts.includes(reasoning.effort)) fail("reasoning");
  }
  // Snapshot the validated request so later caller mutation cannot add tools.
  return { path: "/v1/responses", body: structuredClone(body), model: qualification.model,
    servingModels: [...qualification.servingModels], kind,
    headers: new Headers({ "content-type": "application/json", accept: "application/json" }) };
}

export interface XaiSearchObservation {
  body: Json; status: "completed" | "incomplete" | "failed";
  answer: string; truncated: boolean; citations: string[]; selectedModel: string; servingModel: string;
  usage: Json | null;
  counts: { inputTokens: number | null; outputTokens: number | null; webSearchCalls: number | null;
    xSearchCalls: number | null; xPostsFetched: number | null; xUsersFetched: number | null };
  upstreamCostMicros: null;
}
export function observeXaiSearch(value: unknown, request: Pick<XaiSearchRequest, "model" | "servingModels">, complete: boolean): XaiSearchObservation {
  if (!complete) fail("incomplete_transport");
  const body = object(value);
  if (encoder.encode(JSON.stringify(body)).length > maxEnvelope || typeof body.model !== "string"
    || !request.servingModels.includes(body.model) || !["completed", "incomplete", "failed"].includes(String(body.status))) fail("response");
  const status = body.status as XaiSearchObservation["status"];
  if (status === "completed" && (body.error != null || body.incomplete_details != null)) fail("contradictory_status");
  if (body.output !== undefined && (!Array.isArray(body.output) || body.output.length > 1000)) fail("output");
  let raw = "";
  const annotations: unknown[] = [];
  for (const item of (body.output ?? []) as unknown[]) {
    if (!mediaObject(item)) continue;
    const blocks = item.type === "message" ? item.content : item.type === "output_text" ? [item] : [];
    if (!Array.isArray(blocks) || blocks.length > 1000) fail("content");
    for (const block of blocks) {
      if (!mediaObject(block) || block.type !== "output_text") continue;
      if (!validText(block.text, maxEnvelope)) fail("text");
      const start = raw.length;
      raw += block.text;
      if (start < maxAnswer && Array.isArray(block.annotations)) annotations.push(...block.annotations.slice(0, 1000 - annotations.length));
    }
  }
  if (!raw && body.output_text !== undefined) {
    if (!validText(body.output_text, maxEnvelope)) fail("text");
    raw = body.output_text;
  }
  const answer = utf16Prefix(raw, maxAnswer);
  if (status === "completed" && !answer.trim()) fail("missing_answer");
  const citations = new Set<string>();
  const add = (value: unknown) => { const url = citationUrl(value); if (url && citations.size < 20) citations.add(url); };
  if (Array.isArray(body.citations)) for (const url of body.citations.slice(0, 1000)) add(url);
  if (!citations.size) for (const annotation of annotations) {
    if (mediaObject(annotation) && annotation.type === "url_citation") add(annotation.url);
  }
  if (body.usage != null && !mediaObject(body.usage)) fail("usage");
  const usage = mediaObject(body.usage) ? body.usage : null;
  const details = usage?.server_side_tool_usage_details;
  if (details != null && !mediaObject(details)) fail("usage");
  const tools = mediaObject(details) ? details : null;
  return { body, status, answer, truncated: answer.length < raw.length, citations: [...citations],
    selectedModel: request.model, servingModel: body.model, usage,
    counts: { inputTokens: count(usage?.input_tokens), outputTokens: count(usage?.output_tokens),
      webSearchCalls: count(tools?.web_search_calls), xSearchCalls: count(tools?.x_search_calls),
      xPostsFetched: count(tools?.x_posts_fetched), xUsersFetched: count(tools?.x_users_fetched) },
    upstreamCostMicros: null };
}

// Pass the original admission deadline/caller signal; no paid POST retry here.
export async function readXaiSearch(response: Response, request: Pick<XaiSearchRequest, "model" | "servingModels">, signal: AbortSignal): Promise<XaiSearchObservation> {
  return readNativeJson(response, signal, maxEnvelope, body => observeXaiSearch(body, request, true), fail);
}
function count(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || Number(value) < 0) fail("usage_count");
  return Number(value);
}
function modelId(value: unknown): value is string { return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value); }
function validText(value: unknown, max: number): value is string {
  if (typeof value !== "string" || value.length > max) return false;
  for (const character of value) { const code = character.codePointAt(0)!; if (code >= 0xd800 && code <= 0xdfff) return false; }
  return true;
}
function utf16Prefix(text: string, limit: number): string {
  const cut = text.slice(0, limit), last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}
function citationUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password && url.href.length <= 2048 ? url.href : null;
  } catch { return null; }
}
function object(value: unknown): Json { if (!mediaObject(value)) fail("object"); return value; }
function keys(value: Json, allowed: string[]): void { if (Object.keys(value).some(key => !allowed.includes(key))) fail("fields"); }
function fail(reason: string): never { throw new Error(`invalid_xai_search_${reason}`); }
