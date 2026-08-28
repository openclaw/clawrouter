export interface UsageTokens {
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
  return { input, output, total, cached, cacheWrite, cacheWrite5m, cacheWrite1h, ...(unbilled ? { billable: false as const } : {}) };
}

export function extractSseUsageTokens(text: string): UsageTokens | null {
  let found: UsageTokens | null = null;
  let message: Record<string, unknown> | null = null;
  let messageUsage: Record<string, unknown> | null = null;
  let messageDeltaSeen = false;
  let terminal: "message" | "response" | "chat" | null = null;
  const events = text.replace(/\r\n|\r/g, "\n").split("\n\n");
  events.pop(); // An unterminated SSE frame is not a complete usage report.
  for (const event of events) {
    const data = event.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
    if (!data) continue;
    if (data === "[DONE]") return terminal === "message" || terminal === "response" ? null : found;
    let root: Record<string, unknown> | null;
    try { root = record(JSON.parse(data)); } catch { return null; }
    if (!root) return null;
    if (root.error || root.type === "error" || root.type === "response.failed" || root.type === "response.incomplete") return null;
    if (root.type === "response.completed") return extractUsageTokens(root);
    if (typeof root.type === "string" && root.type.startsWith("response.")) terminal = "response";
    if (root.object === "chat.completion.chunk") terminal = "chat";
    if (root.type === "message_start") {
      terminal = "message";
      message = record(root.message);
      messageUsage = usageRecord(root);
      messageDeltaSeen = false;
    } else if (root.type === "message_delta") {
      if (!messageUsage) return null;
      if (message) Object.assign(message, record(root.delta));
      const delta = usageRecord(root);
      messageDeltaSeen = delta != null && pickNumber(delta, "output_tokens") != null;
      if (delta) {
        // Message deltas are cumulative, but omit unchanged input/cache fields.
        // Merge the raw counters before normalizing so cached input is added once.
        const updates = Object.fromEntries(Object.entries(delta).filter(([, value]) => value != null));
        const creation = record(updates.cache_creation);
        if (creation) updates.cache_creation = { ...record(messageUsage.cache_creation), ...creation };
        Object.assign(messageUsage, updates);
      }
    } else if (root.type === "content_block_start" || root.type === "content_block_delta") {
      if (message) message.content = undefined; // Output began; a later refusal remains billable.
    } else if (root.type === "message_stop") {
      return messageUsage && messageDeltaSeen ? extractUsageTokens({ ...message, usage: messageUsage }) : null;
    } else {
      found = extractUsageTokens(root) ?? found;
    }
  }
  return terminal ? null : found;
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
