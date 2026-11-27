import { validateLiquidImages, validateTypeSafeImages, type LiquidImage, type TypeSafeImage } from "./provider-decision-images.ts";
import { decisionBody, decisionEntry, decisionKeys, decisionProbability, decisionRecord, decisionUsage, requireDecision, sameDecisionJson, type DecisionEntry } from "./provider-decision-wire.ts";
import type { UsageInspection } from "./token-usage.ts";

export type SystemOneProduct = "liquid-ai" | "typesafe";
export type SystemOneQuestion =
  | { type: "noul"; instructions?: DecisionEntry; criteria?: { true?: DecisionEntry; false?: DecisionEntry } | null }
  | { type: "choice"; instructions?: DecisionEntry; criteria: Record<string, DecisionEntry> }
  | { type: "score"; instructions?: DecisionEntry; criteria: DecisionEntry[] };
export interface SystemOneRequest { model: string; state: Exclude<DecisionEntry, null>; questions: Record<string, SystemOneQuestion>; images?: LiquidImage[]; assets?: Record<string, TypeSafeImage> }
export type SystemOneAnswer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> }
  | { type: "score"; score: number; confidence: number; probabilities: Record<string, number>; legend: Record<string, DecisionEntry> };
export interface SystemOneResponse { model: string; answers: Record<string, SystemOneAnswer>; usage: { input_tokens: number; output_tokens: number } }

export function prepareSystemOneRequest(value: unknown, upstreamModel: string, product: SystemOneProduct): SystemOneRequest {
  const body = decisionBody(value, product === "liquid-ai" ? 4_500_000 : 4 * 1024 * 1024);
  requireDecision(Object.keys(body).every(key => ["model", "state", "questions", product === "liquid-ai" ? "images" : "assets"].includes(key)), "systemone_fields");
  requireDecision(upstreamModel.trim() && body.state !== null && decisionEntry(body.state), "systemone_state");
  const questions = decisionRecord(body.questions);
  requireDecision(questions && Object.keys(questions).length, "systemone_questions");
  for (const [id, value] of Object.entries(questions)) {
    const question = decisionRecord(value);
    requireDecision(id.length && question && Object.keys(question).every(key => ["type", "instructions", "criteria"].includes(key)), "systemone_question");
    requireDecision(question.instructions === undefined || decisionEntry(question.instructions), "systemone_instructions");
    if (question.type === "noul") {
      const criteria = question.criteria == null ? null : decisionRecord(question.criteria);
      requireDecision(question.criteria == null || (criteria && Object.keys(criteria).every(key => ["true", "false"].includes(key)) && Object.values(criteria).every(decisionEntry)), "noul_criteria");
      requireDecision(question.instructions != null || (criteria && Object.values(criteria).some(value => value != null)), "noul_instructions");
    } else if (question.type === "choice") {
      const criteria = decisionRecord(question.criteria);
      requireDecision(criteria && Object.keys(criteria).length >= 2 && Object.keys(criteria).length <= 255 && Object.keys(criteria).every(key => key.length) && Object.values(criteria).every(decisionEntry), "choice_criteria");
    } else if (question.type === "score") {
      requireDecision(Array.isArray(question.criteria) && question.criteria.length >= 2 && question.criteria.length <= 10 && question.criteria.every(decisionEntry), "score_criteria");
    } else requireDecision(false, "systemone_question_type");
  }
  if (body.images !== undefined) validateLiquidImages(body.images);
  if (body.assets !== undefined) validateTypeSafeImages(body.assets, body.state, body.questions);
  // Revalidate the encoded size because the selected model can exceed the alias.
  const selected = { ...body, model: upstreamModel };
  decisionBody(selected, product === "liquid-ai" ? 4_500_000 : 4 * 1024 * 1024);
  return selected as unknown as SystemOneRequest;
}

// The runtime must inject this only after preparing the selected native body.
export function systemOneRequestHeaders(request: SystemOneRequest, product: SystemOneProduct): Record<string, string> {
  return product === "typesafe" && request.assets ? { "TypeSafe-Danger-Zone-Images": "true" } : {};
}

function distribution(value: unknown, keys: string[]): boolean {
  const probabilities = decisionRecord(value);
  return !!probabilities && decisionKeys(probabilities, keys) && Object.values(probabilities).every(decisionProbability);
}

// No thresholds, renormalization or synthetic booleans: native estimates survive.
export function decodeSystemOneResponse(value: unknown, request: SystemOneRequest, product: SystemOneProduct): { response: SystemOneResponse; inspection: UsageInspection } | null {
  const root = decisionRecord(value), answers = decisionRecord(root?.answers), tokens = decisionUsage(root?.usage);
  if (!root || typeof root.model !== "string" || !root.model || !answers || !tokens || !decisionKeys(answers, Object.keys(request.questions)) || (product === "liquid-ai" && tokens.output !== 0)) return null;
  for (const [id, question] of Object.entries(request.questions)) {
    const answer = decisionRecord(answers[id]);
    if (!answer || answer.type !== question.type) return null;
    if (question.type === "noul") { if (!decisionProbability(answer.noul)) return null; continue; }
    if (!decisionProbability(answer.confidence)) return null;
    if (question.type === "choice") {
      if (typeof answer.choice !== "string" || !Object.hasOwn(question.criteria, answer.choice) || !distribution(answer.probabilities, Object.keys(question.criteria))) return null;
    } else {
      const keys = question.criteria.map((_, index) => String(index)), legend = decisionRecord(answer.legend);
      if (typeof answer.score !== "number" || !Number.isFinite(answer.score) || answer.score < 0 || answer.score > question.criteria.length - 1 || !distribution(answer.probabilities, keys) || !legend || !decisionKeys(legend, keys)) return null;
      if (!question.criteria.every((entry, index) => sameDecisionJson(legend[String(index)], entry))) return null;
    }
  }
  return { response: value as SystemOneResponse, inspection: { tokens, outcome: "success" } };
}
