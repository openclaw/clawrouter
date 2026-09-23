import parser, { type Token } from "stream-json/core/parser.js";
import { fun, none } from "stream-chain/core";
import { createSseUsageAccumulator, extractUsageTokens, responseOutcome, type SseUsageEvidence, type UsageInspection } from "./token-usage.ts";
import { createToolEvidenceProjection, type createResponsesToolEvidence } from "./responses-tool-evidence.ts";

const feedLimit = 4096, depthLimit = 128, scalarLimit = 64;
const empty = (): UsageInspection => ({ tokens: null, outcome: null });

// Observe the declared Responses format without assembling output. Identity
// publication and complete output/tool-history evidence have different owners.
export function createResponsesUsageInspector(sse: boolean, tools?: Pick<ReturnType<typeof createResponsesToolEvidence>, "accept" | "invalid">) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const accumulator = createSseUsageAccumulator();
  let document = metadataParser(!!tools), json = empty(), stopped = false;
  let prefix = "", mode: "prefix" | "data" | "event" | "ignored" = "prefix";
  let lineNonempty = false, optionalSpace = false, skipLf = false;
  let hasData = false, hasContent = false, eventError = false;
  let eventName = literal("error"), done = literal("[DONE]", true);

  async function data(text: string) {
    done.push(text);
    hasContent ||= text.trim().length > 0;
    await document.push(text);
  }
  async function beginData() {
    if (hasData) await data("\n");
    hasData = true;
  }
  async function line(text: string) {
    lineNonempty ||= text.length > 0;
    let offset = 0;
    while (mode === "prefix" && offset < text.length) {
      const char = text[offset++];
      if (char === ":") {
        mode = prefix === "data" ? "data" : prefix === "event" ? "event" : "ignored";
        optionalSpace = true;
        if (mode === "data") { await beginData(); if (stopped) return; }
        else if (mode === "event") eventName = literal("error");
      } else if (prefix.length < 5) prefix += char;
      else mode = "ignored";
    }
    if (optionalSpace && offset < text.length) {
      optionalSpace = false;
      if (text[offset] === " ") offset++;
    }
    if (mode === "data") await data(text.slice(offset));
    else if (mode === "event") eventName.push(text.slice(offset));
  }
  async function endLine() {
    if (!lineNonempty) {
      if (eventError) { accumulator.accept({ kind: "error" }); tools?.invalid(); }
      else if (hasData && hasContent) {
        const evidence = done.matches() ? { kind: "done" } as const : await document.end();
        if (stopped) return;
        accumulator.accept(evidence);
        if (evidence.kind === "data") {
          if (responseOutcome(evidence.value) === "provider_error") tools?.invalid();
          tools?.accept(document.tools(), true);
        }
        else if (evidence.kind !== "done") tools?.invalid();
      }
      document.stop();
      document = metadataParser(!!tools); hasData = false; hasContent = false; eventError = false; done = literal("[DONE]", true);
    } else if (mode === "prefix" && prefix === "data") await beginData();
    else if (mode === "event" || mode === "prefix" && prefix === "event") eventError = mode === "event" && eventName.matches();
    prefix = ""; mode = "prefix"; lineNonempty = false; optionalSpace = false;
  }
  async function text(value: string) {
    if (!sse) { await document.push(value); return; }
    let offset = 0;
    while (offset < value.length && !stopped) {
      if (skipLf) { skipLf = false; if (value[offset] === "\n") { offset++; continue; } }
      let end = offset;
      while (end < value.length && value[end] !== "\r" && value[end] !== "\n") end++;
      await line(value.slice(offset, end));
      if (stopped || end === value.length) return;
      await endLine();
      if (stopped) return;
      skipLf = value[end] === "\r"; offset = end + 1;
    }
  }
  function invalidUtf8() {
    tools?.invalid();
    document.stop();
    if (sse) accumulator.accept({ kind: "invalid" });
    else json = { tokens: null, outcome: "provider_error" };
    stopped = true;
  }
  return {
    async push(bytes: Uint8Array) {
      // The parser may materialize one feed's tokens before the selector runs.
      // Bound that allocation even when the upstream supplies a giant chunk.
      for (let offset = 0; offset < bytes.length && !stopped; offset += feedLimit) {
        let decoded: string;
        try { decoded = decoder.decode(bytes.subarray(offset, offset + feedLimit), { stream: true }); }
        catch { invalidUtf8(); return; }
        await text(decoded);
      }
    },
    async end() {
      if (stopped) return;
      let tail: string;
      try { tail = decoder.decode(); } catch { invalidUtf8(); return; }
      await text(tail);
      if (stopped || sse) return; // An undelimited SSE event is never dispatched.
      const evidence = await document.end();
      if (stopped) return;
      if (evidence.kind === "data") {
        if (responseOutcome(evidence.value) === "provider_error") tools?.invalid();
        tools?.accept(document.tools(), false);
      }
      else tools?.invalid();
      json = evidence.kind === "data" ? { tokens: extractUsageTokens(evidence.value), outcome: responseOutcome(evidence.value) }
        : { tokens: null, outcome: evidence.kind === "invalid" ? "provider_error" : null };
    },
    result(ended: boolean): UsageInspection {
      return sse ? accumulator.result(ended, document.unavailable()) : ended ? json : empty();
    },
    stop() { stopped = true; document.stop(); },
  };
}

function literal(expected: string, trim = false) {
  let offset = 0, valid = true;
  return {
    push(text: string) {
      if (!valid) return;
      for (const char of text) {
        if (trim && /\s/.test(char) && (offset === 0 || offset === expected.length)) continue;
        if (char !== expected[offset]) { valid = false; return; }
        offset++;
      }
    },
    matches: () => valid && offset === expected.length,
  };
}

class InspectionLimit extends Error {}
type MetadataEvidence = Extract<SseUsageEvidence, { kind: "data" }> | { kind: "invalid" | "unavailable" };

function metadataParser(inspectTools: boolean) {
  const projection = metadataProjection();
  const tools = inspectTools ? createToolEvidenceProjection() : null;
  let failure: "invalid" | "unavailable" | null = null;
  const compose = () => fun(
    (input: string | typeof none): string | typeof none => input,
    parser({ packValues: false, jsonStreaming: false }),
    (token: Token): typeof none => { projection.accept(token); tools?.accept(token); return none; },
  );
  let consume: ReturnType<typeof compose> | undefined = compose();
  function failed(error: unknown) {
    failure = error instanceof InspectionLimit ? "unavailable" : "invalid";
    consume = undefined; projection.clear();
  }
  return {
    async push(text: string) {
      if (!consume || !text) return;
      try { await consume(text); } catch (error) { failed(error); }
    },
    async end(): Promise<MetadataEvidence> {
      if (consume) {
        try { await consume(none); } catch (error) { failed(error); }
        consume = undefined;
      }
      return failure ? { kind: failure } : { kind: "data", value: projection.value() };
    },
    unavailable: () => failure === "unavailable",
    tools: () => failure ? undefined : tools?.value(),
    stop() { consume = undefined; projection.clear(); },
  };
}

type Context = "root" | "response" | "usage" | "details" | "creation";
type Field = Context | "text" | "number" | "error" | null;
type Frame = { context: Context | null; value: Record<string, unknown> | null; key: string | null };
const counters = new Set(["input_tokens", "prompt_tokens", "inputTokens", "output_tokens", "completion_tokens", "outputTokens", "total_tokens", "totalTokens", "cache_read_input_tokens", "cache_creation_input_tokens", "cache_creation_ephemeral_5m_input_tokens", "cache_creation_ephemeral_1h_input_tokens"]);
const detailCounters = new Set(["cached_tokens", "cache_read_input_tokens", "cache_write_tokens"]);
const creationCounters = new Set(["ephemeral_5m_input_tokens", "ephemeral_1h_input_tokens"]);

function metadataProjection() {
  const frames: Frame[] = [];
  let value: unknown, capture: "key" | "text" | "number" | "error" | null = null, scalar = "";
  const current = () => frames[frames.length - 1];
  function field(): Field {
    if (!frames.length) return "root";
    const frame = current(), key = frame.key;
    if (!key || !frame.context) return null;
    if (frame.context === "root" || frame.context === "response") {
      if (["type", "object", "status", "service_tier"].includes(key)) return "text";
      if (frame.context === "root" && key === "error") return "error";
      if (frame.context === "root" && key === "response") return "response";
      return key === "usage" ? "usage" : null;
    }
    if (frame.context === "usage") {
      if (key === "input_tokens_details" || key === "prompt_tokens_details") return "details";
      if (key === "cache_creation") return "creation";
      return counters.has(key) ? "number" : null;
    }
    return (frame.context === "details" ? detailCounters : creationCounters).has(key) ? "number" : null;
  }
  function assign(next: unknown) {
    if (!frames.length) value = next;
    else if (field()) current().value![current().key!] = next;
  }
  return {
    value: () => value,
    clear() { value = undefined; frames.length = 0; scalar = ""; capture = null; },
    accept(token: Token) {
      const selected = field();
      switch (token.name) {
        case "startObject":
        case "startArray": {
          if (frames.length >= depthLimit) throw new InspectionLimit();
          const object = token.name === "startObject";
          // Replacing an ancestor discards all earlier descendants. A non-null
          // primitive/array must still block the normalizer's nullish fallback.
          const next = selected ? object ? {} : [] : undefined;
          assign(next);
          const context = object && selected && !["text", "number", "error"].includes(selected) ? selected as Context : null;
          frames.push({ context, value: context ? next as Record<string, unknown> : null, key: null });
          break;
        }
        case "endObject":
        case "endArray": frames.pop(); break;
        case "startKey": current().key = null; scalar = ""; capture = current().context ? "key" : null; break;
        case "endKey": if (capture === "key") current().key = scalar; scalar = ""; capture = null; break;
        case "startString":
          assign(""); scalar = "";
          capture = selected === "text" ? "text" : selected === "error" ? "error" : null;
          break;
        case "stringChunk":
          if (capture === "error") { if (token.value.length) assign(true); }
          else if (capture === "key" || capture === "text") {
            if (scalar.length + token.value.length > scalarLimit) {
              if (capture === "text") throw new InspectionLimit();
              capture = null; scalar = ""; // An overlong key cannot name a selected field.
            } else scalar += token.value;
          }
          break;
        case "endString": if (capture === "text") assign(scalar); scalar = ""; capture = null; break;
        case "startNumber": assign(0); scalar = ""; capture = selected === "number" || selected === "error" ? "number" : null; break;
        case "numberChunk":
          if (capture === "number") {
            if (scalar.length + token.value.length > scalarLimit) throw new InspectionLimit();
            scalar += token.value;
          }
          break;
        case "endNumber": if (capture === "number") assign(Number(scalar)); scalar = ""; capture = null; break;
        case "nullValue":
        case "trueValue":
        case "falseValue": assign(token.value); break;
      }
    },
  };
}
