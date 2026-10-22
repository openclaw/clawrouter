import { HttpError } from "./utils.ts";

// Counts share a pool, not custody. Only self-contained input is safe to send to
// any API-key account. Extend these structural allowlists with source evidence;
// never recursively inspect user text, JSON schemas, or tool argument strings.
const fields = ["model", "input", "instructions", "parallel_tool_calls", "personality", "reasoning", "text", "tool_choice", "tools", "truncation", "previous_response_id", "conversation"];
function stateless(): never {
  throw new HttpError(400, "input_tokens_stateless_required", "input token counting requires self-contained input without account-bound references; resend full inline input and omit stateful selectors");
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return stateless();
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) stateless();
}
function content(value: unknown): void {
  if (typeof value === "string") return;
  if (!Array.isArray(value)) return stateless();
  for (const entry of value) {
    const part = object(entry);
    switch (part.type) {
      case "input_text": keys(part, ["type", "text"]); break;
      case "input_image":
        keys(part, ["type", "image_url", "detail"]);
        if (typeof part.image_url !== "string") stateless();
        break;
      case "input_file":
        keys(part, ["type", "file_data", "file_url", "filename"]);
        if (typeof part.file_data !== "string" && typeof part.file_url !== "string") stateless();
        break;
      case "output_text":
        keys(part, ["type", "text", "annotations", "logprobs"]);
        // File/container citations can reference another account too.
        if (part.annotations != null && (!Array.isArray(part.annotations) || part.annotations.length)) stateless();
        break;
      case "refusal": keys(part, ["type", "refusal"]); break;
      default: stateless();
    }
  }
}
function input(value: unknown): void {
  if (value == null || typeof value === "string") return;
  if (!Array.isArray(value)) return stateless();
  for (const entry of value) {
    const item = object(entry);
    switch (item.type) {
      case undefined:
      case "message":
        keys(item, ["type", "role", "content", "status", "phase"]);
        content(item.content);
        break;
      case "function_call": keys(item, ["type", "name", "arguments", "call_id", "status", "namespace"]); break;
      case "custom_tool_call": keys(item, ["type", "name", "input", "call_id", "status", "namespace"]); break;
      case "function_call_output":
      case "custom_tool_call_output":
        keys(item, ["type", "call_id", "output", "status"]);
        content(item.output);
        break;
      default: stateless();
    }
  }
}
function tool(value: unknown, depth = 0): void {
  const entry = object(value);
  if (entry.type === "function") keys(entry, ["type", "name", "description", "parameters", "strict", "defer_loading"]);
  else if (entry.type === "custom") keys(entry, ["type", "name", "description", "format", "defer_loading"]);
  else if (entry.type === "namespace" && depth === 0) {
    keys(entry, ["type", "name", "description", "tools"]);
    if (!Array.isArray(entry.tools)) return stateless();
    entry.tools.forEach(child => tool(child, depth + 1));
  } else stateless();
}
function choice(value: unknown): void {
  if (value == null || typeof value === "string") return;
  const entry = object(value);
  if (entry.type === "function" || entry.type === "custom") keys(entry, ["type", "name", "namespace"]);
  else if (entry.type === "allowed_tools") {
    keys(entry, ["type", "mode", "tools"]);
    if (!Array.isArray(entry.tools)) return stateless();
    entry.tools.forEach(child => {
      const selected = object(child);
      if (selected.type !== "function" && selected.type !== "custom") return stateless();
      keys(selected, ["type", "name", "namespace"]);
    });
  } else stateless();
}

export function validateResponsesInputTokens(body: Record<string, unknown>): void {
  keys(body, fields);
  if (body.previous_response_id != null || body.conversation != null) stateless();
  if (typeof body.model !== "string" || !body.model) throw new HttpError(400, "model_required", "a registered Responses model is required for input token counting");
  input(body.input);
  if (body.tools != null) {
    if (!Array.isArray(body.tools)) return stateless();
    body.tools.forEach(entry => tool(entry));
  }
  choice(body.tool_choice);
  if (body.reasoning != null) keys(object(body.reasoning), ["effort", "summary", "generate_summary", "context", "mode"]);
  if (body.text != null) {
    const text = object(body.text);
    keys(text, ["format", "verbosity"]);
    if (text.format != null) keys(object(text.format), ["type", "name", "description", "schema", "strict"]);
  }
}

export function assertInputTokensRequest(request: Request, query: Record<string, unknown>): void {
  if (request.headers.has("x-codex-turn-state") || Object.keys(query).length || new URL(request.url).search) stateless();
}
