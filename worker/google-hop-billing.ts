import { googleField, googleInt32 } from "./google-protocol.ts";
import { extractUsageTokens, type SseUsageEvidence, type UsageInspection, type UsageTokenContext, type UsageTokens } from "./token-usage.ts";

// https://aistudio.google.com/docs/long-decode?generate-content=true#understand-billing
// Select from the routed model and price card, never a response's modelVersion.
export function gemini4Hop(context?: Readonly<UsageTokenContext>): boolean {
  return context?.providerId === "google-gemini" && context.requestFormat === "google.generate_content"
    && ["google.generate_content", "google.stream_generate_content"].includes(context.responseFormat)
    && /^gemini-4-(neon|hydrogen|carbon)$/.test(context.pricedModel ?? "");
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export function googleCandidateCount(body: unknown): number | null {
  const config = googleField(body, "generationConfig", "generation_config");
  return googleInt32(googleField(config, "candidateCount", "candidate_count") ?? 1);
}
function receipt(root: Record<string, unknown>): UsageTokens | null {
  const usage = googleField(root, "usageMetadata", "usage_metadata");
  if (!object(usage) || googleInt32(googleField(usage, "totalTokenCount", "total_token_count")) === null) return null;
  const tokens = extractUsageTokens({ usageMetadata: usage });
  return tokens && tokens.input !== null && tokens.output !== null && tokens.total === tokens.input + tokens.output
    && (tokens.cached ?? 0) <= tokens.input ? tokens : null;
}
// Keep only cumulative receipts and one bit per requested candidate, never text
// or replay tokens. A delivered terminal receipt commits the hop without EOF.
export function googleStreamBilling(count: number | null = 1) {
  const all = count && count <= 8 ? (1 << count) - 1 : 0;
  let finished = 0, checkpoint: UsageTokens | null | undefined, terminal: UsageTokens | null | undefined;
  return {
    accept(frame: SseUsageEvidence) {
      if (frame.kind === "invalid" || frame.kind === "unavailable" || frame.kind === "data" && !object(frame.value)) {
        checkpoint = null; terminal = undefined; finished = 0; return;
      }
      if (frame.kind !== "data" || !object(frame.value) || frame.value.error != null) return;
      const root = frame.value;
      if (!Array.isArray(root.candidates) || !root.candidates.length) {
        const feedback = googleField(root, "promptFeedback", "prompt_feedback");
        if (googleField(feedback, "blockReason", "block_reason") || terminal !== undefined && googleField(root, "usageMetadata", "usage_metadata") != null) terminal = receipt(root);
        return;
      }
      const counters = receipt(root);
      for (const candidate of root.candidates) {
        const token = googleField(candidate, "continuationToken", "continuation_token");
        if (typeof token === "string" && token.length) {
          checkpoint = counters?.output ? counters : null;
        }
        const reason = googleField(candidate, "finishReason", "finish_reason");
        const index = object(candidate) ? googleInt32(candidate.index ?? 0) : null;
        if (index === null || index >= (count ?? 0) || index >= 8) continue;
        if (typeof reason === "string" && reason && reason !== "FINISH_REASON_UNSPECIFIED") finished |= 1 << index;
        else finished &= ~(1 << index);
      }
      terminal = all && finished === all ? counters : undefined;
    },
    finish(inspection: UsageInspection): UsageInspection & { nonbillable?: true } {
      if (terminal !== undefined) return { outcome: inspection.outcome, tokens: terminal };
      // With an unsupported candidate count we cannot certify a missing receipt.
      return { outcome: "provider_error", tokens: checkpoint ?? null, ...(all && checkpoint === undefined ? { nonbillable: true as const } : {}) };
    },
  };
}
