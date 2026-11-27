import type { NativeDecisionCapabilities } from "../../shared/native-capabilities.ts";

export const systemOneDecision = {
  protocol: "baseten-systemone", reasoning: { modes: ["auto"] }, confidence: "provider-specific", outputTokensPerQuestion: 1,
  questions: {
    boolean: { probabilities: "boolean", abstention: false },
    choice: { probabilities: "provider-defined", abstention: false, minOptions: 2, maxOptions: 255 },
    score: { probabilities: "provider-defined", abstention: false, minOptions: 2, maxOptions: 10 },
  }, limits: { maxTotalOptions: 512, maxStateAndQuestionTokens: 16384 },
} satisfies NativeDecisionCapabilities;
