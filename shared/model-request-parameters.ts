export type ProviderReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type ParameterSupport = "supported" | "unsupported" | "requires_reasoning_none";

export interface ModelRequestParameters {
  sources: string[];
  checkedAt: string;
  defaultReasoningEffort?: ProviderReasoningEffort;
  temperature?: ParameterSupport;
  topP?: ParameterSupport;
  logprobs?: ParameterSupport;
  toolCalling?: ParameterSupport;
}

interface ParameterModel {
  supportedReasoningEfforts?: ProviderReasoningEffort[];
  requestParameters?: Record<string, ModelRequestParameters>;
}
interface ParameterEndpoint { id: string; request_format: string }
export interface RequestParameterIssue { field: string; message: string }
export interface RequestParameterAssessment { conflicts: RequestParameterIssue[]; unknown: RequestParameterIssue[] }

// These are finite constructor facts, not an upstream request schema or an
// eligibility check. Missing facts and inactive fields never certify wire validity.
export function assessModelRequest(model: ParameterModel | null, endpoint: ParameterEndpoint, body: Record<string, unknown>): RequestParameterAssessment {
  const result: RequestParameterAssessment = { conflicts: [], unknown: [] };
  const chat = endpoint.request_format === "openai.chat_completions";
  if (!chat && endpoint.request_format !== "openai.responses") return result;
  const rules = model?.requestParameters?.[endpoint.id];
  const reasoning = chat ? body : record(body.reasoning);
  const effortField = chat ? "reasoning_effort" : "reasoning.effort";
  const effortKey = chat ? "reasoning_effort" : "effort";
  const unknownReasoning = !chat && Object.hasOwn(body, "reasoning") && !reasoning;
  const suppliedEffort = unknownReasoning || (reasoning && Object.hasOwn(reasoning, effortKey));
  const effort = suppliedEffort ? reasoning?.[effortKey] : rules?.defaultReasoningEffort;
  if (suppliedEffort) {
    if (typeof effort !== "string" || !model?.supportedReasoningEfforts) unknown(effortField);
    else if (!model.supportedReasoningEfforts.includes(effort as ProviderReasoningEffort)) result.conflicts.push({ field: effortField, message: `${effortField} is outside this model's documented effort values.` });
  }

  for (const [field, rule] of [["temperature", rules?.temperature], ["top_p", rules?.topP], ["top_logprobs", rules?.logprobs]] as const) {
    if (Object.hasOwn(body, field)) assess(field, rule, typeof body[field] === "number" && (field !== "top_logprobs" || (body[field] as number) > 0), true);
  }
  if (chat && Object.hasOwn(body, "logprobs")) assess("logprobs", rules?.logprobs, body.logprobs === true, true);
  if (!chat && Array.isArray(body.include) && body.include.includes("message.output_text.logprobs")) assess("include", rules?.logprobs, true, true);

  for (const [definitions, choice] of chat ? [["tools", "tool_choice"], ["functions", "function_call"]] : [["tools", "tool_choice"]]) {
    const tools = body[definitions];
    const choiceEnabled = toolChoiceEnabled(body[choice], tools, choice === "function_call");
    if (Object.hasOwn(body, definitions)) assess(definitions, rules?.toolCalling, Array.isArray(tools) && tools.length > 0 && (!Object.hasOwn(body, choice) || choiceEnabled), false);
    if (Object.hasOwn(body, choice)) assess(choice, rules?.toolCalling, choiceEnabled, false);
  }
  return result;

  function unknown(field: string): void {
    result.unknown.push({ field, message: `${field} acceptance requires upstream validation.` });
  }
  function assess(field: string, rule: ParameterSupport | undefined, enabled: boolean, presenceRestricted: boolean): void {
    // Sampling/logprob restrictions in model guides apply to field presence,
    // including false/null. Tool-calling restrictions describe enabled intent.
    if (!enabled && !presenceRestricted) { unknown(field); return; }
    if (rule === "unsupported") result.conflicts.push({ field, message: `${field}${presenceRestricted ? " field presence" : " tool calling"} is not supported for this model and endpoint.` });
    else if (rule === "requires_reasoning_none" && typeof effort === "string" && effort !== "none") result.conflicts.push({ field, message: `${field} requires ${effortField}: none for this model and endpoint.` });
    else if (!rule || (rule === "requires_reasoning_none" && effort !== "none") || !enabled) unknown(field);
  }
}

function toolChoiceEnabled(value: unknown, tools: unknown, legacy: boolean): boolean {
  if (value === "required") return true;
  if (value === "auto") return Array.isArray(tools) && tools.length > 0;
  const choice = record(value);
  if (!choice) return false;
  if (legacy) return typeof choice.name === "string" && choice.name.length > 0;
  if (choice.type === "function" || choice.type === "custom") {
    const name = choice.name ?? record(choice[choice.type])?.name;
    return typeof name === "string" && name.length > 0;
  }
  const allowed = choice.type === "allowed_tools" ? record(choice.allowed_tools) ?? choice : null;
  return !!allowed && (allowed.mode === "required" || (allowed.mode === "auto" && Array.isArray(allowed.tools) && allowed.tools.length > 0));
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
