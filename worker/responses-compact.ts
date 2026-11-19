export { assertSingleOpenAiAccount as assertCompactAccount } from "./openai-public-account.ts";
import { extractUsageTokens, type UsageTokens } from "./token-usage.ts";
import type { CompiledModel } from "./types.ts";
import { HttpError } from "./utils.ts";

export function validateCompactRequest(body: Record<string, unknown>, model: CompiledModel | null): void {
  const pricing = model?.pricing;
  if (!model || !pricing || pricing.unit != null || !Number.isSafeInteger(pricing.defaultMaxOutputTokens) || pricing.defaultMaxOutputTokens <= 0) throw new HttpError(400, "compact_model_unqualified", "a registered token-priced compaction model with an authoritative output bound is required");
  if (body.stream !== undefined && body.stream !== false) throw new HttpError(400, "unsupported_compact_stream", "Responses compaction is unary; streaming is unsupported");
  if (body.background !== undefined && body.background !== false) throw new HttpError(400, "unsupported_compact_background", "Responses compaction does not support background jobs");
  if (body.previous_response_id != null && (typeof body.previous_response_id !== "string" || !body.previous_response_id.length || body.previous_response_id.length > 256)) throw new HttpError(400, "invalid_compact_parent", "previous_response_id must be a bounded nonempty response identifier");
  if (body.input != null && typeof body.input !== "string" && !Array.isArray(body.input) || body.input == null && body.previous_response_id == null) throw new HttpError(400, "invalid_compact_input", "compaction requires input or an owned previous_response_id");
}

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
