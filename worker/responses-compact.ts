export { assertSingleOpenAiAccount as assertCompactAccount } from "./openai-public-account.ts";
import { extractUsageTokens, type UsageTokens } from "./token-usage.ts";

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const counter = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

// Only complete, internally consistent compaction-pass usage discounts the
// reservation. The bounded parser projects these scalars, never the output window.
export function extractCompactUsageTokens(value: unknown): UsageTokens | null {
  if (!object(value) || value.object !== "response.compaction" || !object(value.usage)) return null;
  const usage = value.usage, input = usage.input_tokens_details, output = usage.output_tokens_details;
  if (!counter(usage.input_tokens) || !counter(usage.output_tokens) || !counter(usage.total_tokens)
    || usage.input_tokens + usage.output_tokens !== usage.total_tokens || !object(input) || !object(output)
    || !counter(input.cached_tokens) || !counter(input.cache_write_tokens) || input.cached_tokens + input.cache_write_tokens > usage.input_tokens
    || !counter(output.reasoning_tokens) || output.reasoning_tokens > usage.output_tokens) return null;
  return extractUsageTokens(value);
}
