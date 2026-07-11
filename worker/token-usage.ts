export interface UsageTokens {
  input: number | null;
  output: number | null;
  total: number | null;
  cached: number | null;
  cacheWrite: number | null;
  cacheWrite5m: number | null;
  cacheWrite1h: number | null;
}

export function extractUsageTokens(value: unknown): UsageTokens | null {
  if (!value || typeof value !== "object") return null;
  const root = value as Record<string, unknown>;
  const response = root.response && typeof root.response === "object" ? root.response as Record<string, unknown> : null;
  const usage = (root.usage ?? response?.usage ?? root.usageMetadata ?? root.meta) as Record<string, unknown> | undefined;
  if (!usage || typeof usage !== "object") return null;
  const input = pickNumber(usage, "input_tokens", "prompt_tokens", "inputTokens", "promptTokenCount");
  const output = pickNumber(usage, "output_tokens", "completion_tokens", "outputTokens", "candidatesTokenCount");
  const total = pickNumber(usage, "total_tokens", "totalTokens", "totalTokenCount") ?? (input != null || output != null ? (input ?? 0) + (output ?? 0) : null);
  const details = (usage.prompt_tokens_details ?? usage.input_tokens_details) as Record<string, unknown> | undefined;
  const cached = details ? pickNumber(details, "cached_tokens", "cache_read_input_tokens") : pickNumber(usage, "cache_read_input_tokens");
  const cacheWrite = (details ? pickNumber(details, "cache_write_tokens") : null) ?? pickNumber(usage, "cache_creation_input_tokens");
  const cacheCreation = usage.cache_creation as Record<string, unknown> | undefined;
  const cacheWrite5m = cacheCreation ? pickNumber(cacheCreation, "ephemeral_5m_input_tokens") : pickNumber(usage, "cache_creation_ephemeral_5m_input_tokens");
  const cacheWrite1h = cacheCreation ? pickNumber(cacheCreation, "ephemeral_1h_input_tokens") : pickNumber(usage, "cache_creation_ephemeral_1h_input_tokens");
  return { input, output, total, cached, cacheWrite: cacheWrite5m != null || cacheWrite1h != null ? Math.max(0, (cacheWrite ?? 0) - (cacheWrite5m ?? 0) - (cacheWrite1h ?? 0)) : cacheWrite, cacheWrite5m, cacheWrite1h };
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
