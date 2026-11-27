import type { SystemOneRequest, SystemOneResponse } from "../provider-systemone.ts";
import type { SageQuestion, SageRequest, SageAnswer } from "../provider-sage.ts";

const questions: SystemOneRequest["questions"] = {
  gate: { type: "noul", instructions: "synthetic gate" },
  route: { type: "choice", criteria: { left: "one", right: "two" } },
  grade: { type: "score", criteria: ["low", "high"] },
};
export const systemRequest = { model: "alias", state: { text: "synthetic evidence" }, questions } satisfies SystemOneRequest;
export const systemResponse = {
  model: "concrete-model", usage: { input_tokens: 17, output_tokens: 0 },
  answers: {
    gate: { type: "noul", noul: 0.49 },
    route: { type: "choice", choice: "left", confidence: 0.23, probabilities: { left: 0.6, right: 0.4 } },
    grade: { type: "score", score: 0.7, confidence: 0.28, probabilities: { 1: 0.7, 0: 0.3 }, legend: { 0: "low", 1: "high" } },
  },
} satisfies SystemOneResponse;
export const sageQuestion = { id: "gate", kind: "yesno", instructions: "synthetic gate" } satisfies SageQuestion;
export const sageRequest = { content: "synthetic evidence", question: sageQuestion, reasoning: "auto" } satisfies SageRequest;
export const sageResponse = { id: "gate", kind: "yesno", result: { answer: null, probability: 0.49 }, meta: { model: "levanto-sage-2", usage: { input_tokens: 17, output_tokens: 3 }, reasoning: { ran: true, finished: true, tokens: 3 } } } satisfies SageAnswer;
