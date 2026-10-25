import { HttpError } from "./utils.ts";

export type ResponseIdentity = { kind: "response" | "turn"; value: string };
const limits = { response: 256, turn: 8192 };

export function responseIdentity(kind: ResponseIdentity["kind"], value: unknown): ResponseIdentity | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || new TextEncoder().encode(value).length > limits[kind]) {
    throw new HttpError(409, "continuation_restart_required", "continuation identity is unsupported; restart with full input and no continuation state");
  }
  return { kind, value };
}

// WebSockets already own a parsed frame. Inspect the same protocol fields as
// the HTTP scanner without reparsing output or treating metadata as execution.
export function responseEventIdentities(event: Record<string, unknown>): ResponseIdentity[] {
  if (typeof event.type !== "string" || !event.type.startsWith("response.") && event.type !== "error") return [];
  const response = event.response && typeof event.response === "object" && !Array.isArray(event.response) ? event.response as Record<string, unknown> : null;
  const identities = [responseIdentity("response", response?.id), responseIdentity("response", event.response_id)].filter((value): value is ResponseIdentity => !!value);
  if (event.type === "response.metadata" && event.headers && typeof event.headers === "object" && !Array.isArray(event.headers)) {
    for (const [name, value] of Object.entries(event.headers)) {
      if (name.toLowerCase() !== "x-codex-turn-state") continue;
      let first = value;
      while (Array.isArray(first)) first = first[0];
      if (typeof first !== "string") continue;
      const identity = responseIdentity("turn", first);
      if (identity) identities.push(identity);
      break;
    }
  }
  return identities;
}

// Observe only protocol paths, never reconstruct output/tool content. Unlike a
// full JSON/SSE parser, skipped strings, frames and nesting consume no storage.
export function createResponseIdentityInspector(sse: boolean, emit: (identity: ResponseIdentity) => void) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let fields: Partial<Record<"type" | "id" | "response_id" | "turn", string>> = {};
  const consume = (field: keyof typeof fields, value: string) => {
    if (!sse && field === "id") { const identity = responseIdentity("response", value); if (identity) emit(identity); }
    else fields[field] = value;
  };
  let scanner = identityJson(sse, consume);
  let prefix = "", lineHasBytes = false, data = false, optionalSpace = false, skipLf = false, dataLines = 0;
  function endLine() {
    if (!lineHasBytes) {
      if (fields.type?.startsWith("response.")) {
        for (const value of [fields.id, fields.response_id]) { const identity = responseIdentity("response", value); if (identity) emit(identity); }
        if (fields.type === "response.metadata") { const identity = responseIdentity("turn", fields.turn); if (identity) emit(identity); }
      }
      fields = {}; scanner = identityJson(true, consume); dataLines = 0;
    } else if (data || prefix === "data") dataLines++;
    prefix = ""; lineHasBytes = false; data = false; optionalSpace = false;
  }
  function line(text: string) {
    lineHasBytes ||= text.length > 0;
    let offset = 0;
    while (!data && prefix.length <= 4 && offset < text.length) {
      const char = text[offset++];
      if (char === ":") {
        data = prefix === "data"; optionalSpace = data;
        if (data && dataLines) scanner("\n");
        prefix = "ignored";
      } else prefix += char;
    }
    if (!data) return;
    if (optionalSpace && offset < text.length) { optionalSpace = false; if (text[offset] === " ") offset++; }
    scanner(text.slice(offset));
  }
  const newline = /[\r\n]/g;
  function push(text: string) {
    if (!sse) { scanner(text); return; }
    for (let offset = 0; offset < text.length;) {
      if (skipLf) { skipLf = false; if (text[offset] === "\n") { offset++; continue; } }
      newline.lastIndex = offset;
      const boundary = newline.exec(text), end = boundary?.index ?? text.length;
      line(text.slice(offset, end));
      if (!boundary) return;
      endLine(); skipLf = text[end] === "\r"; offset = end + 1;
    }
  }
  return { push(bytes: Uint8Array) { push(decoder.decode(bytes, { stream: true })); }, end() { push(decoder.decode()); } };
}

type Field = "type" | "id" | "response_id" | "turn";
type Frame = { context: "root" | "response" | "headers" | "ignored"; object: boolean; key: string | null; expectingKey: boolean };

function identityJson(sse: boolean, emit: (field: Field, value: string) => void): (text: string) => void {
  // Only root fields and one protocol object below them can name identities.
  // A scalar depth skips arbitrarily deep model output without a nesting stack.
  const frames: Frame[] = [];
  let depth = 0, string = false, escaped = false, raw = "", capture: Field | "key" | null = null;
  let firstTurnValue = false, closed = false;
  const stringBoundary = /["\\]/g;
  function field(frame: Frame | undefined): Field | null {
    if (!frame || frame.expectingKey) return null;
    if (frame.context === "root") {
      if (frame.key === "type") return sse ? "type" : null;
      if (frame.key === "id") return sse ? null : "id";
      if (frame.key === "response_id") return sse ? "response_id" : null;
    }
    if (frame.context === "response" && frame.key === "id") return "id";
    return frame.context === "headers" && frame.key?.toLowerCase() === "x-codex-turn-state" ? "turn" : null;
  }
  return text => {
    if (closed) return;
    for (let index = 0; index < text.length; index++) {
      const char = text[index];
      const frame = depth <= 2 ? frames[depth - 1] : undefined;
      if (string) {
        if (!capture) {
          // Most bytes are output text or arguments, never identity evidence.
          // Skip whole spans while retaining escape state across chunk boundaries.
          let offset = index + (escaped ? 1 : 0); escaped = false;
          while (offset < text.length) {
            stringBoundary.lastIndex = offset;
            const boundary = stringBoundary.exec(text);
            if (!boundary) return;
            if (boundary[0] === '"') { string = false; index = boundary.index; break; }
            offset = boundary.index + 2;
            escaped = offset > text.length;
          }
          if (string) return;
          continue;
        }
        if (char === '"' && !escaped) {
          string = false;
          if (capture) {
            const value: string = JSON.parse(`"${raw}"`);
            if (capture === "key") { if (frame) frame.key = value; }
            else emit(capture, value);
          }
          capture = null; raw = ""; continue;
        }
        if (capture) {
          raw += char;
          const limit = capture === "turn" ? limits.turn : capture === "key" || capture === "type" ? 64 : limits.response;
          if (raw.length > limit * 6) {
            if (capture === "key") { capture = null; raw = ""; }
            else throw new HttpError(502, "continuation_identity_invalid", "upstream continuation identity exceeds its limit");
          }
        }
        escaped = !escaped && char === "\\";
        continue;
      }
      if (/\s/.test(char)) continue;
      if (char === '"') {
        string = true; escaped = false; raw = "";
        capture = firstTurnValue ? "turn" : frame?.object && frame.expectingKey && frame.context !== "ignored" ? "key" : field(frame);
        firstTurnValue = false;
        continue;
      }
      if (char === "{" || char === "[") {
        firstTurnValue = char === "[" && (firstTurnValue || field(frame) === "turn");
        const context = depth === 0 && char === "{" ? "root"
          : depth === 1 && char === "{" && frame?.context === "root" && sse
            ? frame.key === "response" ? "response" : frame.key === "headers" ? "headers" : "ignored" : "ignored";
        depth++;
        if (depth <= 2) frames[depth - 1] = { context, object: char === "{", key: null, expectingKey: char === "{" };
        continue;
      }
      firstTurnValue = false;
      if (char === "}" || char === "]") { depth--; if (depth <= 0) { closed = true; return; } }
      else if (char === ":" && frame) frame.expectingKey = false;
      else if (char === "," && frame) { frame.expectingKey = frame.object; frame.key = null; }
    }
  };
}
