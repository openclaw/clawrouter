import type { Token } from "stream-json/core/parser.js";
import { hostedToolPricingGap } from "./pricing.ts";

export type ToolKnowledge = "token_only" | "hosted_tool_fee" | "hosted_tool_usage" | "unknown";
export const toolEvidenceLimit = 1024;
export function isToolKnowledge(value: unknown): value is ToolKnowledge { return ["token_only", "hosted_tool_fee", "hosted_tool_usage", "unknown"].includes(value as string); }
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const boundedText = (value: unknown): value is string => typeof value === "string" && value.length > 0 && new TextEncoder().encode(value).length <= 256;
function union(left: ToolKnowledge, right: ToolKnowledge): ToolKnowledge {
  return left === "unknown" || right === "unknown" ? "unknown" : left === "hosted_tool_fee" || right === "hosted_tool_fee" ? "hosted_tool_fee"
    : left === "hosted_tool_usage" || right === "hosted_tool_usage" ? "hosted_tool_usage" : "token_only";
}

// ToolParam discriminants, not schemas or arbitrary message text, define this
// inventory. The pricing classifier proves positive gaps; its null is not proof
// that a new, malformed, or partly observed executable declaration is harmless.
function declarations(value: unknown, namespace = false): ToolKnowledge {
  if (!Array.isArray(value) || value.length > toolEvidenceLimit) return "unknown";
  let knowledge: ToolKnowledge = "token_only", count = value.length;
  for (const tool of value) {
    if (!record(tool) || typeof tool.type !== "string") return "unknown";
    let next: ToolKnowledge = "unknown";
    if (["function", "custom"].includes(tool.type) && boundedText(tool.name)) next = "token_only";
    else if (!namespace) {
      if (tool.type === "tool_search" && tool.execution != null && tool.execution !== "client" && tool.execution !== "server") return "unknown";
      const gap = hostedToolPricingGap([tool], "openai.responses");
      if (gap) next = gap;
      else if (["computer", "local_shell", "apply_patch"].includes(tool.type)
        || tool.type === "computer_use_preview" && ["windows", "mac", "linux", "ubuntu", "browser"].includes(tool.environment as string)
          && Number.isSafeInteger(tool.display_height) && (tool.display_height as number) > 0 && Number.isSafeInteger(tool.display_width) && (tool.display_width as number) > 0
        || tool.type === "shell" && record(tool.environment) && tool.environment.type === "local"
        || tool.type === "tool_search" && tool.execution === "client") next = "token_only";
      else if (tool.type === "namespace" && boundedText(tool.name) && Array.isArray(tool.tools)) {
        count += tool.tools.length;
        if (count > toolEvidenceLimit) return "unknown";
        next = declarations(tool.tools, true);
      }
    }
    knowledge = union(knowledge, next);
  }
  return knowledge;
}

// These item kinds contain results or client actions, not ToolParam inventories.
// Opaque references/compaction and new kinds deliberately have no clean default.
const ordinaryItems = new Set(["message", "reasoning", "function_call", "function_call_output", "custom_tool_call", "custom_tool_call_output", "computer_call", "computer_call_output", "web_search_call", "file_search_call", "code_interpreter_call", "image_generation_call", "local_shell_call", "local_shell_call_output", "shell_call", "shell_call_output", "apply_patch_call", "apply_patch_call_output", "tool_search_call", "mcp_call", "mcp_approval_request", "mcp_approval_response", "configuration_update"]);
const ordinaryEvents = new Set([
  "response.created", "response.in_progress", "response.queued", "response.metadata", "codex.response.metadata", "response.output_text.annotation.added",
  ...["output_text", "refusal", "reasoning_text", "reasoning_summary_text", "audio", "audio_transcript", "function_call_arguments", "custom_tool_call_input", "mcp_call_arguments", "code_interpreter_call_code", "shell_call_output_content"].flatMap(kind => ["delta", "done"].map(state => `response.${kind}.${state}`)),
  ...["content_part", "reasoning_summary_part"].flatMap(kind => ["added", "done"].map(state => `response.${kind}.${state}`)),
  ...["web_search_call", "file_search_call"].flatMap(kind => ["in_progress", "searching", "completed"].map(state => `response.${kind}.${state}`)),
  ...["mcp_call", "mcp_list_tools"].flatMap(kind => ["in_progress", "completed", "failed"].map(state => `response.${kind}.${state}`)),
  ...["in_progress", "generating", "completed", "partial_image"].map(state => `response.image_generation_call.${state}`),
  ...["in_progress", "interpreting", "completed"].map(state => `response.code_interpreter_call.${state}`),
  ...["added", "delta", "done"].map(state => `response.shell_call_command.${state}`),
]);
function itemKnowledge(value: unknown): ToolKnowledge {
  if (!record(value)) return "unknown";
  if (value.type === "additional_tools" || value.type === "tool_search_output") {
    if (value.status != null && value.status !== "completed") return "unknown";
    if (value.type === "tool_search_output" && value.execution != null && value.execution !== "client" && value.execution !== "server") return "unknown";
    return declarations(value.tools);
  }
  if (Object.hasOwn(value, "tools")) return "unknown";
  return typeof value.type === "string" && ordinaryItems.has(value.type)
    || value.type === undefined && ["user", "assistant", "developer", "system"].includes(value.role as string) ? "token_only" : "unknown";
}

export function retainedToolBase(body: Record<string, unknown>, inherited: ToolKnowledge): ToolKnowledge {
  if (body.conversation != null || body.prompt != null || record(body.multi_agent) && body.multi_agent.enabled === true) return "unknown";
  if (body.input == null || typeof body.input === "string") return inherited;
  if (!Array.isArray(body.input) || body.input.length > toolEvidenceLimit) return "unknown";
  // Top-level tools are current-request configuration. Only tagged input tools
  // and retained output declarations attest an inventory inherited by children.
  return body.input.reduce<ToolKnowledge>((knowledge, item) => union(knowledge, itemKnowledge(item)), inherited);
}

type Item = { index?: number; id?: string; done: boolean; type?: unknown; knowledge?: ToolKnowledge; observed?: ToolKnowledge };
export type ToolEvidenceResult = { responseId: string; knowledge: ToolKnowledge };
export function createResponsesToolEvidence(base: ToolKnowledge) {
  const items: Item[] = [], indices = new Map<number, Item>(), ids = new Map<string, Item>();
  let uncertain = false, terminal = false, responseId: string | undefined, result: ToolEvidenceResult | null = null;
  function identity(value: unknown) {
    if (value === undefined) return;
    if (!boundedText(value) || responseId && value !== responseId) uncertain = true;
    else responseId = value;
  }
  function associate(index: unknown, identifier: unknown): Item | undefined {
    if (index !== undefined && (!Number.isSafeInteger(index) || (index as number) < 0)
      || identifier !== undefined && !boundedText(identifier)) { uncertain = true; return; }
    const position = index as number | undefined, id = identifier as string | undefined;
    const byIndex = position === undefined ? undefined : indices.get(position), byId = id === undefined ? undefined : ids.get(id);
    if (byIndex && byId && byIndex !== byId) { uncertain = true; return; }
    let item = byIndex ?? byId;
    if (!item) {
      if (items.length >= toolEvidenceLimit) { uncertain = true; return; }
      item = { done: false }; items.push(item);
    }
    if (item.index !== undefined && position !== undefined && item.index !== position || item.id !== undefined && id !== undefined && item.id !== id) { uncertain = true; return; }
    if (position !== undefined) { item.index = position; indices.set(position, item); }
    if (id !== undefined) { item.id = id; ids.set(id, item); }
    return item;
  }
  function observeItem(value: unknown, index: unknown, done: boolean) {
    if (!record(value)) { uncertain = true; return; }
    const item = associate(index, value.id);
    if (!item) return;
    if (item.type !== undefined && item.type !== value.type) uncertain = true;
    item.type = value.type;
    if (done) {
      const knowledge = itemKnowledge(value);
      if (item.done && item.knowledge !== knowledge || item.observed && union(item.observed, knowledge) !== knowledge) uncertain = true;
      item.done = true; item.knowledge = knowledge;
    } else {
      // Anonymous added events cannot safely be paired by arrival order. Codex
      // done-only anonymous items remain supported under this request owner.
      if (index === undefined && value.id === undefined || item.done) uncertain = true;
      const partial = itemKnowledge(value);
      if (partial === "hosted_tool_fee" || partial === "hosted_tool_usage") item.observed = union(item.observed ?? "token_only", partial);
    }
  }
  return {
    invalid() { if (!terminal) uncertain = true; },
    accept(value: unknown, sse: boolean) {
      if (terminal) return;
      if (!record(value)) { uncertain = true; return; }
      const response = sse ? record(value.response) ? value.response : null : value;
      identity(value.response_id); if (response) identity(response.id);
      if (sse && (value.type === "response.output_item.added" || value.type === "response.output_item.done")) {
        observeItem(value.item, value.output_index, value.type === "response.output_item.done"); return;
      }
      const completed = sse ? value.type === "response.completed" || value.type === "response.incomplete" : ["completed", "incomplete"].includes(value.status as string);
      if (!completed && !(sse && (value.type === "response.failed" || value.type === "error"))) {
        const ordinary = sse && ordinaryEvents.has(value.type as string);
        if (sse && !ordinary || response?.output != null && (!Array.isArray(response.output) || response.output.length > 0)) uncertain = true;
        // A selector proves an item exists, not its type or completion. Only a
        // matching item.done can complete this same bounded association.
        if (ordinary && (value.output_index !== undefined || value.item_id !== undefined)) associate(value.output_index, value.item_id);
        return;
      }
      terminal = true;
      let knowledge = base;
      if (!completed || !response || !boundedText(response.id) || !responseId || !sse && response.object !== "response") uncertain = true;
      for (const item of items) {
        if (!item.done) uncertain = true;
        else knowledge = union(knowledge, item.knowledge!);
      }
      if (response && Object.hasOwn(response, "output")) {
        const output = response.output;
        if (!Array.isArray(output) || output.length > toolEvidenceLimit) uncertain = true;
        else for (const [index, value] of output.entries()) {
          const item = indices.get(index), named = record(value) && typeof value.id === "string" ? ids.get(value.id) : undefined;
          const next = itemKnowledge(value);
          if (item && named && item !== named || item && (item.type !== (record(value) ? value.type : undefined) || item.knowledge !== next || item.id !== undefined && record(value) && value.id !== undefined && item.id !== value.id)
            || named && (named.index !== undefined && named.index !== index || named.knowledge !== next)) uncertain = true;
          knowledge = union(knowledge, next);
        }
        if (Array.isArray(output) && (items.length > output.length || items.some(item => item.index !== undefined && item.index >= output.length))) uncertain = true;
      } else {
        // Anonymous items cannot fill a known position gap. Full terminal output
        // can supply entirely unobserved items, but never complete a pending one.
        if (!sse || [...indices.keys()].some(index => index >= indices.size)) uncertain = true;
      }
      result = responseId ? { responseId, knowledge: uncertain ? "unknown" : knowledge } : null;
      items.length = 0; indices.clear(); ids.clear();
    },
    result: () => result,
  };
}

type Context = "root" | "response" | "items" | "item" | "tools" | "tool" | "environment";
type Field = Context | "text" | "number" | null;
type Frame = { context: Context | null; value: Record<string, unknown> | unknown[] | null; key: string | null };

// A second semantic projection on the existing parser's tokens, not another
// parser or size-triggered output buffer. Limits invalidate only qualification.
export function createToolEvidenceProjection() {
  const frames: Frame[] = [];
  let value: unknown, scalar = "", capture: "key" | "text" | "number" | null = null, failed = false, entries = 0;
  const current = () => frames[frames.length - 1];
  function fail() { failed = true; value = undefined; frames.length = 0; scalar = ""; capture = null; }
  function field(): Field {
    if (!frames.length) return "root";
    const frame = current(), key = frame.key;
    if (frame.context === "items") return "item";
    if (frame.context === "tools") return "tool";
    if (!key || !frame.context) return null;
    if (frame.context === "root" || frame.context === "response") {
      if (["type", "id", "response_id", "status", "object"].includes(key)) return "text";
      if (key === "output") return "items";
      if (frame.context === "root") return key === "response" ? "response" : key === "item" ? "item" : key === "output_index" ? "number" : key === "item_id" ? "text" : null;
    }
    if (frame.context === "item" || frame.context === "tool") {
      if (["type", "id", "name", "role", "execution", "status"].includes(key)) return "text";
      if (key === "tools") return "tools";
      if (frame.context === "tool" && key === "environment") return "environment";
      if (frame.context === "tool" && (key === "display_height" || key === "display_width")) return "number";
    }
    return frame.context === "environment" && key === "type" ? "text" : null;
  }
  function assign(next: unknown) {
    // Charge every selected entry once, including malformed scalars and arrays.
    // Per-array limits would multiply retained children across namespaces.
    const selected = field();
    if ((selected === "item" || selected === "tool") && ++entries > toolEvidenceLimit) { fail(); return; }
    if (!frames.length) value = next;
    else if (Array.isArray(current().value)) (current().value as unknown[]).push(next);
    else if (selected) (current().value as Record<string, unknown>)[current().key!] = next;
  }
  return {
    value: () => failed ? undefined : value,
    accept(token: Token) {
      if (failed) return;
      const selected = field();
      switch (token.name) {
        case "startObject":
        case "startArray": {
          if (frames.length >= 128) { fail(); return; }
          const object = token.name === "startObject", next = selected ? object ? {} : [] : undefined;
          assign(next); if (failed) return;
          const context = selected && (object ? !["items", "tools", "text", "number"].includes(selected) : selected === "items" || selected === "tools") ? selected as Context : null;
          frames.push({ context, value: context ? next as Frame["value"] : null, key: null }); break;
        }
        case "endObject":
        case "endArray": frames.pop(); break;
        case "startKey": current().key = null; scalar = ""; capture = current().context ? "key" : null; break;
        case "endKey": if (capture === "key") current().key = scalar; scalar = ""; capture = null; break;
        case "startString": scalar = ""; capture = selected === "text" || selected === "environment" ? "text" : null; break;
        case "stringChunk":
          if (capture) {
            if (scalar.length + token.value.length > (capture === "key" ? 64 : 256)) { if (capture !== "key") fail(); else { capture = null; scalar = ""; } }
            else scalar += token.value;
          }
          break;
        case "endString": assign(capture === "text" ? scalar : ""); scalar = ""; capture = null; break;
        case "startNumber": scalar = ""; capture = selected === "number" ? "number" : null; break;
        case "numberChunk": if (capture === "number") { scalar += token.value; if (scalar.length > 64) fail(); } break;
        case "endNumber": assign(capture === "number" ? Number(scalar) : 0); scalar = ""; capture = null; break;
        case "nullValue":
        case "trueValue":
        case "falseValue": assign(token.value); break;
      }
    },
  };
}
