export interface UsageTokens {
  serviceTier?: string;
  input: number | null;
  output: number | null;
  total: number | null;
  cached: number | null;
  cacheWrite: number | null; // Total writes, including the duration-specific buckets below.
  cacheWrite5m: number | null;
  cacheWrite1h: number | null;
  billable?: false;
}

export function extractUsageTokens(value: unknown): UsageTokens | null {
  const root = record(value);
  const usage = usageRecord(root);
  if (!usage) return null;
  const reportedInput = pickNumber(usage, "input_tokens", "prompt_tokens", "inputTokens", "promptTokenCount");
  const output = pickNumber(usage, "output_tokens", "completion_tokens", "outputTokens", "candidatesTokenCount");
  const details = record(usage.prompt_tokens_details ?? usage.input_tokens_details);
  const cached = details ? pickNumber(details, "cached_tokens", "cache_read_input_tokens") : pickNumber(usage, "cache_read_input_tokens");
  const cacheCreation = record(usage.cache_creation);
  const cacheWrite5m = cacheCreation ? pickNumber(cacheCreation, "ephemeral_5m_input_tokens") : pickNumber(usage, "cache_creation_ephemeral_5m_input_tokens");
  const cacheWrite1h = cacheCreation ? pickNumber(cacheCreation, "ephemeral_1h_input_tokens") : pickNumber(usage, "cache_creation_ephemeral_1h_input_tokens");
  const cacheWrite = (details ? pickNumber(details, "cache_write_tokens") : null) ?? pickNumber(usage, "cache_creation_input_tokens")
    ?? (cacheWrite5m != null || cacheWrite1h != null ? (cacheWrite5m ?? 0) + (cacheWrite1h ?? 0) : null);
  // Anthropic's top-level cache buckets exclude ordinary input; OpenAI's details
  // are already included. Pricing and usage ledgers both consume inclusive input.
  const input = reportedInput == null ? null : reportedInput + (details ? 0 : (cached ?? 0) + (cacheWrite ?? 0));
  const total = pickNumber(usage, "total_tokens", "totalTokens", "totalTokenCount") ?? (input != null || output != null ? (input ?? 0) + (output ?? 0) : null);
  // Anthropic reports usage for classifier refusals before any output, but does
  // not bill it. Keep observed counts separate from the settlement decision.
  const unbilled = root?.type === "message" && root.stop_reason === "refusal"
    && Array.isArray(root.content) && root.content.length === 0 && output === 0;
  const serviceTier = extractServiceTier(record(root?.response) ?? root);
  return { input, output, total, cached, cacheWrite, cacheWrite5m, cacheWrite1h, ...(serviceTier ? { serviceTier } : {}), ...(unbilled ? { billable: false as const } : {}) };
}

export type ResponseOutcome = "success" | "provider_error" | null;
export interface UsageInspection { tokens: UsageTokens | null; outcome: ResponseOutcome }
export const usageInspectionLimit = 2 * 1024 * 1024;

// JSON and SSE Responses share terminal semantics; incomplete output is still a
// successful, billable response. Absence of usage says nothing about outcome.
export function responseOutcome(value: unknown): ResponseOutcome {
  const root = record(value);
  if (!root) return null;
  if (root.error || root.type === "error" || root.type === "response.failed") return "provider_error";
  if (root.type === "response.completed" || root.type === "response.incomplete") return "success";
  const response = record(root.response) ?? (root.object === "response" ? root : null);
  return response?.status === "failed" ? "provider_error" : response?.status === "completed" || response?.status === "incomplete" ? "success" : null;
}

export function extractSseUsageTokens(text: string): UsageTokens | null {
  const inspector = createSseUsageInspector();
  inspector.push(new TextEncoder().encode(text));
  return inspector.result().tokens;
}

export function createSseUsageInspector() {
  let found: UsageTokens | null = null, terminalTokens: UsageTokens | null = null;
  let message: Record<string, unknown> | null = null, messageUsage: Record<string, unknown> | null = null;
  let messageDeltaSeen = false, uncertain = false;
  let protocol: "message" | "response" | "chat" | null = null;
  let outcome: ResponseOutcome = null, chatTier: string | undefined;
  function inspect(frame: string | null) {
    if (frame === null) {
      // Skipped oversized evidence is not proof of provider failure. A later
      // bounded terminal can restore authoritative outcome and usage.
      uncertain = true; found = null; messageUsage = null;
      return;
    }
    const lines = frame.split("\n");
    const data = lines.filter(line => line.startsWith("data:")).map(line => line.slice(5).trim()).join("\n");
    if (lines.some(line => /^event:\s*error\s*$/.test(line))) { outcome = "provider_error"; return; }
    if (!data || outcome !== null) return;
    if (data === "[DONE]") {
      if (protocol === "message" || protocol === "response") { outcome = "provider_error"; return; }
      outcome = "success";
      terminalTokens = found && chatTier ? { ...found, serviceTier: chatTier } : found;
      return;
    }
    let root: Record<string, unknown> | null;
    try { root = record(JSON.parse(data)); } catch { if (protocol) outcome = "provider_error"; found = null; return; }
    if (!root) { if (protocol) outcome = "provider_error"; found = null; return; }
    const terminal = responseOutcome(root);
    if (terminal) { outcome = terminal; terminalTokens = extractUsageTokens(root); return; }
    if (typeof root.type === "string" && root.type.startsWith("response.")) protocol = "response";
    if (root.object === "chat.completion.chunk") {
      protocol = "chat";
      chatTier = extractServiceTier(root) ?? chatTier;
    }
    if (root.type === "message_start") {
      protocol = "message";
      const initial = record(root.message);
      message = { type: "message", stop_reason: initial?.stop_reason, content: Array.isArray(initial?.content) && initial.content.length === 0 ? [] : undefined };
      messageUsage = messageCounters(usageRecord(root));
      messageDeltaSeen = false;
    } else if (root.type === "message_delta") {
      if (!messageUsage) return;
      const messageDelta = record(root.delta);
      if (message && messageDelta && "stop_reason" in messageDelta) message.stop_reason = messageDelta.stop_reason;
      const delta = messageCounters(usageRecord(root));
      messageDeltaSeen = delta != null && pickNumber(delta, "output_tokens") != null;
      if (delta) {
        // Cumulative deltas omit unchanged counters. Merge before normalizing
        // so disjoint cache input is added once, never once per frame.
        const updates = Object.fromEntries(Object.entries(delta).filter(([, value]) => value != null));
        const creation = record(updates.cache_creation);
        if (creation) updates.cache_creation = { ...record(messageUsage.cache_creation), ...creation };
        Object.assign(messageUsage, updates);
      }
    } else if (root.type === "content_block_start" || root.type === "content_block_delta") {
      if (message) message.content = undefined;
    } else if (root.type === "message_stop") {
      outcome = "success";
      terminalTokens = messageUsage && messageDeltaSeen ? extractUsageTokens({ ...message, usage: messageUsage }) : null;
    } else found = extractUsageTokens(root) ?? found;
  }
  const frames = sseFrames(inspect);
  return {
    push: frames.push,
    result(ended = true): UsageInspection {
      return { tokens: outcome ? terminalTokens : protocol || !ended ? null : found, outcome: outcome ?? (ended && protocol && !uncertain && !frames.overflowed() ? "provider_error" : null) };
    },
  };
}

function sseFrames(consume: (frame: string | null) => void) {
  let buffer = new Uint8Array(8192), length = 0, lineLength = 0, overflow = false, skipLf = false;
  const decoder = new TextDecoder();
  function append(bytes: Uint8Array) {
    if (overflow) return;
    if (length + bytes.length > usageInspectionLimit) { overflow = true; length = 0; return; }
    if (length + bytes.length > buffer.length) {
      const next = new Uint8Array(Math.min(usageInspectionLimit, Math.max(buffer.length * 2, length + bytes.length)));
      next.set(buffer.subarray(0, length)); buffer = next;
    }
    buffer.set(bytes, length); length += bytes.length;
  }
  return {
    overflowed: () => overflow,
    push(bytes: Uint8Array) {
      let start = 0;
      for (let index = 0; index < bytes.length; index++) {
        const byte = bytes[index];
        if (skipLf) { skipLf = false; if (byte === 10) { start = index + 1; continue; } }
        if (byte !== 10 && byte !== 13) continue;
        append(bytes.subarray(start, index)); lineLength += index - start;
        if (lineLength === 0) { consume(overflow ? null : decoder.decode(buffer.subarray(0, length))); length = 0; overflow = false; }
        else append(new Uint8Array([10]));
        lineLength = 0; skipLf = byte === 13; start = index + 1;
      }
      append(bytes.subarray(start)); lineLength += bytes.length - start;
    },
  };
}

function messageCounters(usage: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!usage) return null;
  // Stream history is unbounded; retain only the finite cumulative counter set.
  const counters = Object.fromEntries(["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens", "cache_creation_ephemeral_5m_input_tokens", "cache_creation_ephemeral_1h_input_tokens"].filter(key => numeric(usage[key]) != null).map(key => [key, usage[key]]));
  const creation = record(usage.cache_creation);
  if (creation) counters.cache_creation = Object.fromEntries(["ephemeral_5m_input_tokens", "ephemeral_1h_input_tokens"].filter(key => numeric(creation[key]) != null).map(key => [key, creation[key]]));
  return counters;
}

export function extractServiceTier(root: Record<string, unknown> | null): string | undefined {
  const tier = root?.service_tier;
  return typeof tier === "string" && /^[a-z][a-z0-9_-]{0,63}$/.test(tier) ? tier : undefined;
}

function usageRecord(root: Record<string, unknown> | null): Record<string, unknown> | null {
  return root ? record(root.usage ?? record(root.response)?.usage ?? record(root.message)?.usage ?? root.usageMetadata ?? root.meta) : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function pickNumber(value: Record<string, unknown>, ...keys: string[]): number | null {
  for (const key of keys) {
    const number = numeric(value[key]);
    if (number != null) return number;
  }
  return null;
}

function numeric(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}
