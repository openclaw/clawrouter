import type { NativeDecisionCapabilities, NativeEndpointCapabilities, SageDecisionCapabilities } from "../../shared/native-capabilities.ts";

export const sageBatchDecision = {
  protocol: "levanto-sage",
  questions: {
    boolean: { probabilities: "boolean", abstention: true },
    choice: { probabilities: "categorical", abstention: true, minOptions: 2, maxOptions: 120 },
    score: { probabilities: "categorical", abstention: false, minOptions: 2, maxOptions: 26 },
    sort: { probabilities: "none", abstention: false, minOptions: 2, maxOptions: 120 },
    tags: { probabilities: "independent", abstention: true, minOptions: 1, maxOptions: 120 },
  },
  reasoning: { modes: ["auto", "off", "on"], metadata: true },
  confidence: "provider-specific",
} satisfies SageDecisionCapabilities;

export const sageBatchFacts = {
  sources: ["https://docs.levanto.ai/quickstart"], checkedAt: "2026-11-03", input: ["text", "json"],
  inference: { chat: false, decision: sageBatchDecision },
} satisfies NativeEndpointCapabilities;

export const nativeDecision: NativeDecisionCapabilities = sageBatchDecision;
export const invalidSageProtocol: SageDecisionCapabilities = {
  ...sageBatchDecision,
  // @ts-expect-error A transport format is not a new metadata protocol.
  protocol: "levanto.sage_batch",
};
export const invalidSageQuestion: SageDecisionCapabilities = {
  ...sageBatchDecision,
  // @ts-expect-error Sage sorting has no probability or abstention semantics.
  questions: { sort: { probabilities: "categorical", abstention: true, minOptions: 2 } },
};
