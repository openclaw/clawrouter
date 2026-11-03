import type { BasetenSystemOneRequest, BasetenSystemOneResponse } from "../provider-baseten-systemone.ts";

// Encoded by the frozen Baseten DecisionV2 adapter, with synthetic state only.
export const basetenSystemOneRequest = {
  model: "decision-models/baseten-elephant-9b-latest",
  state: '{"ticket":"synthetic duplicate charge"}',
  questions: {
    refund: { type: "noul", instructions: 'Refund?\nTrue criterion: {"requested":true}\nFalse criterion: no refund' },
    route: { type: "choice", instructions: "Choose a team", criteria: { billing: '{"scope":"payments"}', support: "Technical" } },
    urgency: { type: "score", instructions: "Rate urgency", criteria: ['{"level":"routine"}', "Emergency"] },
  },
} satisfies BasetenSystemOneRequest;
export const basetenSystemOneResponse = {
  model: "elephant-1",
  answers: {
    refund: { type: "noul", noul: 0.49 },
    route: { type: "choice", choice: "billing", confidence: 0.2, probabilities: { billing: 0.8, support: 0.2 } },
    urgency: { type: "score", score: 0.7, confidence: 0.3, probabilities: { 1: 0.7, 0: 0.3 }, legend: { 0: '{"level":"routine"}', 1: "Emergency" } },
  },
  usage: { input_tokens: 42, output_tokens: 3 },
} satisfies BasetenSystemOneResponse;
