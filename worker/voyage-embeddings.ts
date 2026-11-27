import type { UsageTokens } from "./token-usage.ts";

export function extractVoyageEmbeddingUsage(value: unknown): UsageTokens | null {
  // Apply only to a complete, successful voyage.embeddings response. A generic
  // total-only chat response cannot establish an input/output split.
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const root = value as Record<string, unknown>;
  if (root.error || !Array.isArray(root.data)) return null;
  if (!root.usage || typeof root.usage !== "object" || Array.isArray(root.usage)) return null;
  const total = (root.usage as Record<string, unknown>).total_tokens;
  if (typeof total !== "number" || !Number.isSafeInteger(total) || total < 0) return null;
  return {
    input: total, output: 0, total,
    cached: null, cacheWrite: null, cacheWrite5m: null, cacheWrite1h: null,
  };
}
