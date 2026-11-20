import { googleField } from "./google-protocol.ts";
import { extractUsageTokens, type SseUsageEvidence, type UsageInspection, type UsageTokenContext, type UsageTokens } from "./token-usage.ts";

// https://aistudio.google.com/docs/long-decode?generate-content=true#understand-billing
// Select from the routed model and price card, never a response's modelVersion.
export function gemini4Hop(context?: Readonly<UsageTokenContext>): boolean {
  return context?.providerId === "google-gemini" && context.requestFormat === "google.generate_content"
    && ["google.generate_content", "google.stream_generate_content"].includes(context.responseFormat)
    && /^gemini-4-(neon|hydrogen|carbon)$/.test(context.pricedModel ?? "");
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

// The existing bounded SSE parser feeds complete frames. Do not retain text,
// a checkpoint token, or one entry per checkpoint. Each receipt is cumulative.
export function googleStreamBilling() {
  let checkpoint: UsageTokens | null | undefined, uncertain = false, terminal = false;
  return {
    accept(frame: SseUsageEvidence) {
      if (frame.kind === "invalid" || frame.kind === "unavailable") { uncertain = true; return; }
      if (frame.kind !== "data") return;
      const root = frame.value;
      if (!object(root)) { uncertain = true; return; }
      if (root.error != null) return;
      if (object(googleField(root, "promptFeedback", "prompt_feedback")) && !root.candidates) terminal = true;
      if (!Array.isArray(root.candidates) || !root.candidates.length) return;
      // Multiple candidates share cumulative usage; one candidate's finish
      // cannot certify completion of the others.
      terminal = root.candidates.every(c => {
        const reason = googleField(c, "finishReason", "finish_reason");
        return typeof reason === "string" && !!reason && reason !== "FINISH_REASON_UNSPECIFIED";
      });
      if (root.candidates.some(c => {
        const token = googleField(c, "continuationToken", "continuation_token");
        return typeof token === "string" && token.length > 0;
      })) {
        const usage = googleField(root, "usageMetadata", "usage_metadata");
        const tokens = object(usage) ? extractUsageTokens({ usageMetadata: usage }) : null;
        checkpoint = tokens && tokens.input !== null && tokens.output !== null && tokens.output > 0
          && tokens.total === tokens.input + tokens.output && (tokens.cached ?? 0) <= tokens.input ? tokens : null;
        uncertain = checkpoint === null;
      }
    },
    finish(inspection: UsageInspection, ended: boolean): (UsageInspection & { nonbillable?: true }) | undefined {
      if (ended && terminal && inspection.outcome !== "provider_error" && !uncertain) return;
      if (uncertain) return { outcome: "provider_error", tokens: null }; // no qualified receipt
      return { outcome: "provider_error", tokens: checkpoint ?? null, ...(checkpoint === undefined ? { nonbillable: true as const } : {}) };
    },
  };
}
