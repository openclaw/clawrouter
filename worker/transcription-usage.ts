import type { UsageTokens } from "./token-usage.ts";

// Audio transcription is not chat usage: type discriminator and singular
// input_token_details are mandatory evidence when present. Never coerce strings,
// accept partial JSON, or turn missing counters into a free transcription.
export function transcriptionUsage(value: unknown): UsageTokens | null {
  const root = record(value), usage = record(root?.usage);
  if (!usage || usage.type !== "tokens") return null;
  const input = counter(usage.input_tokens), output = counter(usage.output_tokens), total = counter(usage.total_tokens);
  if (input === null || output === null || total === null || input + output !== total || !Number.isSafeInteger(input + output)) return null;
  // Protect micro-USD arithmetic too; no published context limit is asserted here.
  if (total > Math.floor(Number.MAX_SAFE_INTEGER / 10)) return null;
  if (usage.input_token_details !== undefined) {
    const details = record(usage.input_token_details);
    if (!details) return null;
    const audio = details.audio_tokens === undefined ? undefined : counter(details.audio_tokens);
    const text = details.text_tokens === undefined ? undefined : counter(details.text_tokens);
    if (audio === null || text === null || audio !== undefined && audio > input || text !== undefined && text > input) return null;
    if (audio !== undefined && text !== undefined && audio + text !== input) return null;
  }
  return { input, output, total, cached: null, cacheWrite: null, cacheWrite5m: null, cacheWrite1h: null };
}
function record(value: unknown): Record<string, unknown> | null { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function counter(value: unknown): number | null { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null; }
