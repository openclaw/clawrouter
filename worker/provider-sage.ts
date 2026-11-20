import { decisionImageUri } from "./provider-decision-images.ts";
import { decisionBody, decisionProbability, decisionRecord, decisionUsage, requireDecision } from "./provider-decision-wire.ts";
import type { UsageInspection } from "./token-usage.ts";

export type SageContent = string | { kind: "image"; media: string; text?: string } | { kind: "list"; value: Array<{ id: string; content: string }> };
export type SageQuestion = { id: string } & (
  | { kind: "yesno"; instructions: string }
  | { kind: "choice"; instructions: string; options: Array<{ option: string; description?: string | null }> }
  | { kind: "scale"; instructions: string; levels: Array<{ level: number; description?: string | null }> }
  | { kind: "sort"; instructions: string }
  | { kind: "tags"; instructions?: string | null; tags: Array<{ id: string; name?: string | null }> }
);
export type SageReasoning = "auto" | "off" | "on";
export interface SageRequest { content: SageContent; question: SageQuestion; reasoning?: SageReasoning }
export interface SageBatchRequest { requests: Array<{ content: SageContent; questions: SageQuestion[] }>; reasoning?: SageReasoning }
export type SageAnswer = { id: string; meta: Record<string, unknown> } & (
  | { kind: "yesno"; result: { answer: "yes" | "no" | null; probability: number } }
  | { kind: "choice"; result: { chosen: string | null; probability: number | null; probabilities: Array<{ option: string; probability: number }> } }
  | { kind: "scale"; result: { expectation: number; confidence: number; probabilities: Array<{ level: number; probability: number }> } }
  | { kind: "sort"; result: { sorted: string[]; confidence?: number | null } }
  | { kind: "tags"; result: { tags: Array<{ id: string; probability: number; applies: boolean | null }> } }
);
export interface SageBatchResponse { results: Array<{ answers: Array<{ ok: true; result: SageAnswer } | { ok: false; error: string }> }>; meta: Record<string, unknown> }

const nullableString = (value: unknown) => value == null || typeof value === "string";
function validateContent(value: unknown): asserts value is SageContent {
  if (typeof value === "string") return;
  const content = decisionRecord(value);
  if (content?.kind === "image") {
    requireDecision(Object.keys(content).every(key => ["kind", "media", "text"].includes(key)) && (content.text === undefined || typeof content.text === "string"), "sage_image");
    decisionImageUri(content.media, ["image/png", "image/jpeg", "image/webp"]);
    return;
  }
  requireDecision(content?.kind === "list" && Array.isArray(content.value) && content.value.length >= 2 && content.value.length <= 120, "sage_content");
  const ids = content.value.map(value => {
    const item = decisionRecord(value);
    requireDecision(item && typeof item.id === "string" && item.id.length && typeof item.content === "string", "sage_list_item");
    return item.id;
  });
  requireDecision(new Set(ids).size === ids.length, "sage_list_ids");
}
function validateQuestion(value: unknown, content: SageContent): asserts value is SageQuestion {
  const question = decisionRecord(value);
  requireDecision(question && typeof question.id === "string" && question.id.length, "sage_question");
  requireDecision(question.kind === "tags" ? nullableString(question.instructions) : typeof question.instructions === "string", "sage_instructions");
  if (question.kind === "yesno") return;
  if (question.kind === "sort") { requireDecision(typeof content !== "string" && content.kind === "list", "sage_sort_content"); return; }
  const field = question.kind === "choice" ? "options" : question.kind === "scale" ? "levels" : question.kind === "tags" ? "tags" : "";
  requireDecision(field, "sage_question_type");
  const list = question[field];
  requireDecision(Array.isArray(list) && list.length >= (field === "tags" ? 1 : 2) && list.length <= (field === "levels" ? 26 : field === "options" && typeof content !== "string" && content.kind === "image" ? 20 : 120), "sage_criteria");
  const ids = list.map(value => {
    const item = decisionRecord(value), id = item?.[field === "options" ? "option" : field === "levels" ? "level" : "id"];
    requireDecision(item && (field === "levels" ? Number.isSafeInteger(id) : typeof id === "string" && id.length) && nullableString(item[field === "tags" ? "name" : "description"]), "sage_criterion");
    return id;
  });
  requireDecision(new Set(ids).size === ids.length, "sage_criteria_ids");
}
export function prepareSageRequest(value: unknown, batch = false): SageRequest | SageBatchRequest {
  const body = decisionBody(value);
  requireDecision(body.reasoning === undefined || ["auto", "off", "on"].includes(body.reasoning as string), "sage_reasoning");
  // No model field is added: Sage selects its model on the service side.
  requireDecision(Object.keys(body).every(key => (batch ? ["requests", "reasoning"] : ["content", "question", "reasoning"]).includes(key)), "sage_fields");
  const groups = batch ? body.requests : [{ content: body.content, questions: [body.question] }];
  requireDecision(Array.isArray(groups) && groups.length, "sage_requests");
  for (const value of groups) {
    const group = decisionRecord(value);
    requireDecision(group, "sage_group"); validateContent(group.content);
    requireDecision(Array.isArray(group.questions) && group.questions.length, "sage_questions");
    for (const question of group.questions) validateQuestion(question, group.content);
    requireDecision(new Set(group.questions.map(question => (question as SageQuestion).id)).size === group.questions.length, "sage_question_ids");
  }
  return body as unknown as SageRequest | SageBatchRequest;
}

function validateAnswer(value: unknown, question: SageQuestion, content: SageContent): boolean {
  const answer = decisionRecord(value), result = decisionRecord(answer?.result);
  if (!answer || answer.id !== question.id || answer.kind !== question.kind || !decisionRecord(answer.meta) || !result) return false;
  if (question.kind === "yesno") return ["yes", "no", null].includes(result.answer as string | null) && decisionProbability(result.probability);
  if (question.kind === "sort") {
    if (typeof content === "string" || content.kind !== "list" || !Array.isArray(result.sorted)) return false;
    const ids = content.value.map(item => item.id);
    return result.sorted.length === ids.length && new Set(result.sorted).size === ids.length && result.sorted.every(id => ids.includes(id)) && (result.confidence == null || decisionProbability(result.confidence));
  }
  if (question.kind === "tags") {
    if (!Array.isArray(result.tags) || result.tags.length !== question.tags.length) return false;
    return result.tags.every((value, index) => {
      const tag = decisionRecord(value);
      return tag?.id === question.tags[index].id && decisionProbability(tag.probability) && (typeof tag.applies === "boolean" || (tag.applies === null && !(typeof content !== "string" && content.kind === "image")));
    });
  }
  const probabilities = result.probabilities;
  const ids = question.kind === "choice" ? question.options.map(option => option.option) : question.levels.map(level => level.level);
  if (!Array.isArray(probabilities) || probabilities.length !== ids.length || !probabilities.every((value, index) => {
    const item = decisionRecord(value); return item?.[question.kind === "choice" ? "option" : "level"] === ids[index] && decisionProbability(item?.probability);
  })) return false;
  if (question.kind === "choice") return result.chosen === null ? result.probability === null : typeof result.chosen === "string" && question.options.some(option => option.option === result.chosen) && decisionProbability(result.probability);
  return typeof result.expectation === "number" && Number.isFinite(result.expectation) && result.expectation >= Math.min(...question.levels.map(level => level.level)) && result.expectation <= Math.max(...question.levels.map(level => level.level)) && decisionProbability(result.confidence);
}

export function decodeSageResponse(value: unknown, request: SageRequest | SageBatchRequest): { response: SageAnswer | SageBatchResponse; inspection: UsageInspection } | null {
  const root = decisionRecord(value), meta = decisionRecord(root?.meta);
  if (!root || !meta) return null;
  if ("requests" in request) {
    if (!Array.isArray(root.results) || root.results.length !== request.requests.length) return null;
    for (let index = 0; index < request.requests.length; index++) {
      const group = request.requests[index], result = decisionRecord(root.results[index]);
      if (!result || !Array.isArray(result.answers) || result.answers.length !== group.questions.length) return null;
      for (let item = 0; item < group.questions.length; item++) {
        const answer = decisionRecord(result.answers[item]);
        if (!answer || (answer.ok === true ? !validateAnswer(answer.result, group.questions[item], group.content) : answer.ok !== false || typeof answer.error !== "string" || !answer.error || answer.result != null)) return null;
      }
    }
  } else if (!validateAnswer(value, request.question, request.content)) return null;
  const tokens = decisionUsage(meta.usage);
  if (meta.usage != null && !tokens) return null;
  const imageTokens = decisionRecord(meta.usage)?.image_tokens;
  if (imageTokens != null && (!Number.isSafeInteger(imageTokens) || (imageTokens as number) < 0)) return null;
  const contents = "requests" in request ? request.requests.map(group => group.content) : [request.content];
  // The native image counter is preserved in the response. Its relationship to
  // input_tokens is not qualified; never derive a token tariff from a partial sum.
  const imageUsage = contents.some(content => typeof content !== "string" && content.kind === "image") || (typeof imageTokens === "number" && imageTokens > 0);
  return { response: value as unknown as SageAnswer | SageBatchResponse, inspection: { tokens: imageUsage ? null : tokens, outcome: "success" } };
}
