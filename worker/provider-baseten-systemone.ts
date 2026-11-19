import { readNativeJson } from "./native-json.ts";
import { decisionBody, decisionKeys, decisionProbability, decisionRecord, decisionUsage, requireDecision } from "./provider-decision-wire.ts";
import type { UsageInspection } from "./token-usage.ts";
import { HttpError } from "./utils.ts";

export const BASETEN_SYSTEMONE_FORMAT = "baseten.systemone" as const;
export const BASETEN_SYSTEMONE_MODELS = Object.freeze([
  "decision-models/baseten-elephant-9b-latest",
  "decision-models/baseten-mammoth-27b-latest",
  "decision-models/baseten-joey-2b-latest",
] as const);
export type BasetenSystemOneModel = typeof BASETEN_SYSTEMONE_MODELS[number];
export type BasetenSystemOneQuestion =
  | { type: "noul"; instructions?: string }
  | { type: "choice"; instructions?: string; criteria: Record<string, string> }
  | { type: "score"; instructions?: string; criteria: string[] };
export interface BasetenSystemOneRequest {
  model: BasetenSystemOneModel;
  state: string;
  questions: Record<string, BasetenSystemOneQuestion>;
}
export type BasetenSystemOneAnswer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> }
  | { type: "score"; score: number; confidence: number; probabilities: Record<string, number>; legend: Record<string, string> };
export interface BasetenSystemOneResponse {
  model: string;
  answers: Record<string, BasetenSystemOneAnswer>;
  usage: { input_tokens: number; output_tokens: number };
}
export interface BasetenSystemOneResult { body: BasetenSystemOneResponse; usage: UsageInspection }

const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
function identifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\p{Cc}]/u.test(value);
}

// Frozen DecisionV2 encoding serializes JSON state/criteria as text and folds
// boolean criteria into instructions before reaching this native wire boundary.
export function prepareBasetenSystemOneRequest(value: unknown, upstreamModel: string): BasetenSystemOneRequest {
  const body = decisionBody(value, MAX_REQUEST_BYTES);
  requireDecision(BASETEN_SYSTEMONE_MODELS.some(model => model === upstreamModel), "baseten_model");
  requireDecision(Object.keys(body).every(key => ["model", "state", "questions"].includes(key)), "baseten_fields");
  requireDecision(body.model === undefined || identifier(body.model), "baseten_model");
  requireDecision(typeof body.state === "string", "baseten_encoded_state");
  const questions = decisionRecord(body.questions);
  requireDecision(questions && Object.keys(questions).length > 0, "baseten_questions");
  let options = 0;
  for (const [name, value] of Object.entries(questions)) {
    const question = decisionRecord(value);
    requireDecision(identifier(name) && question, "baseten_question");
    requireDecision(question.instructions === undefined || typeof question.instructions === "string", "baseten_encoded_instructions");
    const fields = question.type === "noul" ? ["type", "instructions"] : ["type", "instructions", "criteria"];
    requireDecision(Object.keys(question).every(key => fields.includes(key)), "baseten_question_fields");
    if (question.type === "noul") options += 2;
    else if (question.type === "choice") {
      const criteria = decisionRecord(question.criteria);
      requireDecision(criteria && Object.keys(criteria).length >= 2 && Object.keys(criteria).length <= 255
        && Object.keys(criteria).every(identifier) && Object.values(criteria).every(entry => typeof entry === "string"), "baseten_choice_criteria");
      options += Object.keys(criteria).length;
    } else if (question.type === "score") {
      requireDecision(Array.isArray(question.criteria) && question.criteria.length >= 2 && question.criteria.length <= 10
        && question.criteria.every(entry => typeof entry === "string"), "baseten_score_criteria");
      options += question.criteria.length;
    } else requireDecision(false, "baseten_question_type");
    requireDecision(options <= 512, "baseten_option_budget");
  }
  const selected = { ...body, model: upstreamModel };
  decisionBody(selected, MAX_REQUEST_BYTES);
  return selected as unknown as BasetenSystemOneRequest;
}

function probabilities(value: unknown, keys: string[]): Record<string, number> | null {
  const values = decisionRecord(value);
  return values && decisionKeys(values, keys) && Object.values(values).every(decisionProbability)
    ? Object.fromEntries(keys.map(key => [key, values[key] as number])) : null;
}

export function decodeBasetenSystemOneResponse(value: unknown, request: BasetenSystemOneRequest): BasetenSystemOneResult | null {
  const root = decisionRecord(value), nativeAnswers = decisionRecord(root?.answers), tokens = decisionUsage(root?.usage);
  if (!root || !identifier(root.model) || !nativeAnswers || !tokens || tokens.input === null || tokens.output === null || tokens.output !== Object.keys(request.questions).length
    || !decisionKeys(nativeAnswers, Object.keys(request.questions))) return null;
  const answers: [string, BasetenSystemOneAnswer][] = [];
  for (const [name, question] of Object.entries(request.questions)) {
    const answer = decisionRecord(nativeAnswers[name]);
    if (!answer || answer.type !== question.type) return null;
    if (question.type === "noul") {
      if (!decisionProbability(answer.noul)) return null;
      answers.push([name, { type: "noul", noul: answer.noul }]);
      continue;
    }
    if (!decisionProbability(answer.confidence)) return null;
    if (question.type === "choice") {
      const values = probabilities(answer.probabilities, Object.keys(question.criteria));
      if (typeof answer.choice !== "string" || !Object.hasOwn(question.criteria, answer.choice) || !values) return null;
      answers.push([name, { type: "choice", choice: answer.choice, confidence: answer.confidence, probabilities: values }]);
    } else {
      const keys = question.criteria.map((_, index) => String(index)), legend = decisionRecord(answer.legend);
      const values = probabilities(answer.probabilities, keys);
      if (typeof answer.score !== "number" || !Number.isFinite(answer.score) || answer.score < 0 || answer.score > question.criteria.length - 1
        || !values || !legend || !decisionKeys(legend, keys) || !question.criteria.every((entry, index) => legend[String(index)] === entry)) return null;
      answers.push([name, { type: "score", score: answer.score, confidence: answer.confidence, probabilities: values,
        legend: Object.fromEntries(question.criteria.map((entry, index) => [String(index), entry])) }]);
    }
  }
  return {
    body: { model: root.model, answers: Object.fromEntries(answers), usage: { input_tokens: tokens.input, output_tokens: tokens.output } },
    usage: { tokens, outcome: "success" },
  };
}

function invalid(): never {
  throw new HttpError(502, "invalid_baseten_systemone_response", "Baseten SystemOne response is invalid or incomplete");
}

export function readBasetenSystemOneResponse(response: Response, request: BasetenSystemOneRequest, signal: AbortSignal): Promise<BasetenSystemOneResult> {
  return readNativeJson(response, signal, MAX_RESPONSE_BYTES, body => decodeBasetenSystemOneResponse(body, request) ?? invalid(), invalid);
}
