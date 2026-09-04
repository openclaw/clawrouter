import { containsPrivate, record } from "./private-codex-config";

// Wire contracts: codex core/client.rs, core/responses_metadata.rs and codex-api.
const forwardedHeaders = new Set([
  // Codex stamps its actual CLI version; dropping it changes backend model compatibility.
  "version", "session-id", "thread-id", "session_id", "x-client-request-id", "user-agent", "originator", "openai-beta",
  "x-openai-internal-codex-responses-lite", "x-codex-beta-features", "x-codex-turn-state", "x-codex-turn-metadata",
  "x-codex-parent-thread-id", "x-codex-window-id", "x-oai-attestation", "x-openai-subagent", "x-openai-memgen-request",
  "x-responsesapi-include-timing-metrics", "traceparent", "tracestate",
]);
const metadataKeys = new Set([
  "x-codex-installation-id", "session_id", "thread_id", "turn_id", "parent_turn_id", "root_turn_id",
  "x-codex-window-id", "x-codex-parent-thread-id", "x-openai-subagent", "x-codex-turn-metadata",
]);
const routingHint = "x-codex-routing-hint";
const booleanHeaders = new Set(["x-openai-internal-codex-responses-lite", "x-openai-memgen-request", "x-responsesapi-include-timing-metrics"]);
const selectorKeys = new Set(["model", "retry_model", "faster_model", "auto_review_model_override"]);
const encoder = new TextEncoder();

export type PrivateProtocolPredicate =
  | "headers.content_encoding" | "headers.transfer_encoding" | "headers.value_limit"
  | "headers.total_limit" | "headers.routing_hint" | "headers.routing_tier"
  | "headers.selector" | "headers.namespace" | "headers.boolean"
  | "headers.turn_metadata" | "headers.characters"
  | "protocol.metadata_object" | "protocol.metadata_count" | "protocol.metadata_key"
  | "protocol.metadata_value_type" | "protocol.metadata_value_limit" | "protocol.turn_metadata"
  | "protocol.stream_options_object" | "protocol.stream_options_keys"
  | "protocol.stream_options_delivery" | "protocol.stream_options_stream"
  | "protocol.access_programs_object" | "protocol.access_programs_keys"
  | "protocol.access_programs_type" | "protocol.access_programs_value"
  | "protocol.opaque_limit" | "protocol.opaque_identity" | "protocol.opaque_size"
  | "protocol.opaque_selector" | "protocol.opaque_json" | "protocol.opaque_encoding";

export class PrivateProtocolError extends Error {
  readonly predicate: PrivateProtocolPredicate;

  constructor(predicate: PrivateProtocolPredicate) {
    super("private protocol rejected");
    this.predicate = predicate;
  }
}

function boundedMetadata(value: unknown, depth = 0, budget = { nodes: 0 }): void {
  if (++budget.nodes > 10_000 || depth > 32) throw new Error("private metadata limit");
  if (Array.isArray(value)) for (const item of value) boundedMetadata(item, depth + 1, budget);
  else if (record(value)) for (const item of Object.values(value)) boundedMetadata(item, depth + 1, budget);
}

function metadataObject(value: string): boolean {
  try { const parsed: unknown = JSON.parse(value); boundedMetadata(parsed); return record(parsed); } catch { return false; }
}

export function privateProtocolBodyRejection(body: Record<string, unknown>): PrivateProtocolPredicate | null {
  const metadata = body.client_metadata;
  if (metadata != null) {
    if (!record(metadata)) return "protocol.metadata_object";
    if (Object.keys(metadata).length > 32) return "protocol.metadata_count";
    for (const [key, value] of Object.entries(metadata)) {
      if (!metadataKeys.has(key)) return "protocol.metadata_key";
      if (typeof value !== "string") return "protocol.metadata_value_type";
      if (value.length > (key === "x-codex-turn-metadata" ? 256 * 1024 : 8192)) return "protocol.metadata_value_limit";
      if (key === "x-codex-turn-metadata" && !metadataObject(value)) return "protocol.turn_metadata";
    }
  }
  const options = body.stream_options;
  if (options != null) {
    if (!record(options)) return "protocol.stream_options_object";
    if (Object.keys(options).length !== 1) return "protocol.stream_options_keys";
    if (options.reasoning_summary_delivery !== "sequential_cutoff") return "protocol.stream_options_delivery";
    if (body.stream !== true) return "protocol.stream_options_stream";
  }
  // This is an upstream access selection, not permission granted by the facade.
  // Preserve the supplied wire token; never manufacture entitlement or a program fallback.
  const programs = body.access_programs;
  if (programs != null) {
    if (!record(programs)) return "protocol.access_programs_object";
    if (Object.keys(programs).length !== 1) return "protocol.access_programs_keys";
    if (typeof programs.cyber !== "string") return "protocol.access_programs_type";
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(programs.cyber)) return "protocol.access_programs_value";
  }
  return null;
}

function parseRoutingHint(value: string, alias: string): { tier?: string } | null {
  const match = /^model=([a-z][a-z0-9-]{2,63})(?:;tier=([a-z][a-z0-9_-]{0,63}))?$/.exec(value);
  return match && match[1] === alias ? { tier: match[2] } : null;
}

export function privateHeadersRejection(headers: Headers, alias: string, body?: Record<string, unknown>): PrivateProtocolPredicate | null {
  if (headers.has("content-encoding")) return "headers.content_encoding";
  if (headers.has("transfer-encoding")) return "headers.transfer_encoding";
  let bytes = 0;
  for (const [key, value] of headers) {
    bytes += encoder.encode(key + value).byteLength;
    if (value.length > 8192) return "headers.value_limit";
    if (bytes > 64 * 1024) return "headers.total_limit";
    if (key === routingHint) {
      const hint = parseRoutingHint(value, alias);
      if (!hint) return "headers.routing_hint";
      if (body && hint.tier !== (body.service_tier ?? undefined)) return "headers.routing_tier";
      continue;
    }
    if (/(?:model|provider|base[-_]?url|upstream|account|organization|project)/i.test(key)) return "headers.selector";
    if ((key.startsWith("x-codex-") || key.startsWith("x-openai-internal-") || /(?:approval|review|attestation|safety|routing)/i.test(key)) && !forwardedHeaders.has(key)) return "headers.namespace";
    if (booleanHeaders.has(key) && value !== "true" && value !== "false") return "headers.boolean";
    if (key === "x-codex-turn-metadata" && !metadataObject(value)) return "headers.turn_metadata";
    if (forwardedHeaders.has(key) && !/^[\x20-\x7e]+$/.test(value)) return "headers.characters";
  }
  return null;
}

export function forwardPrivateHeaders(incoming: Headers, outgoing: Headers, alias: string, target: string): void {
  for (const [key, value] of incoming) if (forwardedHeaders.has(key)) outgoing.set(key, value);
  const hint = incoming.get(routingHint);
  if (hint !== null) {
    const parsed = parseRoutingHint(hint, alias);
    if (!parsed) throw new Error("private routing hint invalid");
    outgoing.set(routingHint, `model=${target}${parsed.tier ? `;tier=${parsed.tier}` : ""}`);
  }
}

// Opaque affinity is never rewritten. Inspect literal, JSON, percent and base64/JWT
// representations before returning it; this is not cryptographic attestation verification.
export function inspectPrivateOpaque(value: unknown, alias: string, secrets: readonly string[], depth = 0, budget = { nodes: 0 }): void {
  if (++budget.nodes > 10_000 || depth > 12) throw new PrivateProtocolError("protocol.opaque_limit");
  if (typeof value === "string") {
    if (containsPrivate(value, secrets)) throw new PrivateProtocolError("protocol.opaque_identity");
    if (value.length > 8192) throw new PrivateProtocolError("protocol.opaque_size");
    for (const match of value.matchAll(/(?:^|[;,&\s])(?:model|retry_model|faster_model)=([^;,&\s]+)/g)) {
      if (match[1] !== alias) throw new PrivateProtocolError("protocol.opaque_selector");
    }
    if (/^\s*[\[{]/.test(value)) {
      let decoded: unknown;
      try { decoded = JSON.parse(value); } catch { throw new PrivateProtocolError("protocol.opaque_json"); }
      inspectPrivateOpaque(decoded, alias, secrets, depth + 1, budget);
    } else if (/%[0-9a-f]{2}/i.test(value)) {
      let decoded: string;
      try { decoded = decodeURIComponent(value); } catch { throw new PrivateProtocolError("protocol.opaque_encoding"); }
      if (decoded !== value) inspectPrivateOpaque(decoded, alias, secrets, depth + 1, budget);
    } else {
      for (const part of value.split(".")) {
        if (!/^[A-Za-z0-9+/_-]{8,}={0,2}$/.test(part)) continue;
        let decoded: string;
        try { decoded = atob(part.replaceAll("-", "+").replaceAll("_", "/")); } catch { continue; }
        if (containsPrivate(decoded, secrets)) throw new PrivateProtocolError("protocol.opaque_identity");
        if (/^[\x20-\x7e\r\n\t]+$/.test(decoded) && decoded !== value) inspectPrivateOpaque(decoded, alias, secrets, depth + 1, budget);
      }
    }
  } else if (Array.isArray(value)) for (const item of value) inspectPrivateOpaque(item, alias, secrets, depth + 1, budget);
  else if (record(value)) for (const [key, item] of Object.entries(value)) {
    inspectPrivateOpaque(key, alias, secrets, depth + 1, budget);
    if (selectorKeys.has(key) && item != null && item !== alias) throw new PrivateProtocolError("protocol.opaque_selector");
    inspectPrivateOpaque(item, alias, secrets, depth + 1, budget);
  }
}

function quotaHeader(name: string): boolean {
  return /^x-codex(?:-[a-z0-9]+)*-(?:(?:primary|secondary)-(?:used-percent|window-minutes|reset-at|reset-after-seconds)|limit-name)$/.test(name)
    || ["x-codex-plan-type", "x-codex-primary-over-secondary-limit-percent", "x-codex-active-limit", "x-codex-promo-message", "x-codex-rate-limit-reached-type", "x-codex-credits-has-credits", "x-codex-credits-unlimited", "x-codex-credits-balance"].includes(name);
}

export function privateResponseHeaders(entries: Iterable<[string, unknown]>, alias: string, target: string, secrets: readonly string[]): Record<string, unknown> {
  const result: Record<string, unknown> = Object.create(null);
  const seen = new Set<string>();
  let bytes = 0;
  for (const [key, original] of entries) {
    const name = key.toLowerCase();
    const value = Array.isArray(original) && original.length === 1 ? original[0] : original;
    // Repeated Set-Cookie is legal upstream and is always discarded below.
    if (typeof value !== "string" || value.length > 8192 || (seen.has(name) && name !== "set-cookie")) throw new Error("private header invalid");
    seen.add(name);
    bytes += encoder.encode(key + value).byteLength;
    if (bytes > 64 * 1024 || seen.size > 128) throw new Error("private headers limit");
    // Quota labels can contain private model names. Strip the entire observation.
    if (quotaHeader(name) || name === "x-models-etag") continue;
    let projected: string;
    if (["openai-model", "x-openai-model", "x-codex-safety-buffering-faster-model"].includes(name)) {
      if (value !== target && value !== alias) throw new Error("private reported model mismatch");
      projected = alias;
    } else if (name === "x-codex-turn-state") {
      inspectPrivateOpaque(value, alias, secrets);
      projected = value;
    } else if (name === "x-reasoning-included") {
      // Codex consumes presence, not a parsed boolean; an empty header is meaningful.
      inspectPrivateOpaque(value, alias, secrets);
      projected = value;
    } else if (name === "x-codex-safety-buffering-enabled") {
      if (!["true", "false", "1", "0"].includes(value)) throw new Error("private protocol boolean");
      projected = value;
    } else {
      if (name.startsWith("x-codex-") || /(?:approval|review|attestation|reroute|model|provider|safety)/i.test(name)) throw new Error("private header unsupported");
      continue;
    }
    result[key] = Array.isArray(original) ? [projected] : projected;
  }
  return result;
}
