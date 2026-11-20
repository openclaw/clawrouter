import { mediaObject } from "./managed-media-json.ts";
import { observeXaiSearch, readXaiSearch, type XaiSearchQualification, type XaiSearchObservation } from "./xai-search.ts";

type Json = Record<string, unknown>;
export interface XaiCodeExecutionRequest {
  path: "/v1/responses"; body: Json; headers: Headers; model: string; servingModels: readonly string[];
}
export function prepareXaiCodeExecution(value: unknown, qualification: XaiSearchQualification): XaiCodeExecutionRequest {
  if (!mediaObject(value) || Object.keys(value).some(key => !["model", "input", "tools", "store", "reasoning", "max_turns"].includes(key))
    || !modelId(qualification.model) || !qualification.servingModels.length || qualification.servingModels.length > 8
    || qualification.servingModels.some(model => !modelId(model)) || value.model !== qualification.model || value.store !== false
    || !Array.isArray(value.input) || value.input.length !== 1 || !Array.isArray(value.tools) || value.tools.length !== 1) fail();
  const input = value.input[0], tool = value.tools[0];
  if (!mediaObject(input) || Object.keys(input).some(key => !["role", "content"].includes(key)) || input.role !== "user"
    || typeof input.content !== "string" || !input.content.trim() || input.content.length > 32768
    || !mediaObject(tool) || Object.keys(tool).some(key => key !== "type") || tool.type !== "code_interpreter") fail();
  for (const character of input.content) { const code = character.codePointAt(0)!; if (code >= 0xd800 && code <= 0xdfff) fail(); }
  if (value.max_turns !== undefined && (!Number.isSafeInteger(value.max_turns) || Number(value.max_turns) < 1 || Number(value.max_turns) > 10)) fail();
  if (value.reasoning !== undefined && (!mediaObject(value.reasoning) || Object.keys(value.reasoning).some(key => key !== "effort")
    || typeof value.reasoning.effort !== "string" || !["none", "minimal", "low", "medium", "high", "xhigh"].includes(value.reasoning.effort)
    || !qualification.reasoningEfforts.includes(value.reasoning.effort))) fail();
  return { path: "/v1/responses", body: structuredClone(value), model: qualification.model,
    servingModels: [...qualification.servingModels], headers: new Headers({ "content-type": "application/json", accept: "application/json" }) };
}
export interface XaiCodeExecutionObservation extends XaiSearchObservation {
  outputTypes: string[];
  // Presence of a native output item means an observed attempt, not success.
  usedCodeExecution: boolean;
  codeInterpreterCalls: number | null;
}
export function observeXaiCodeExecution(value: unknown, request: XaiCodeExecutionRequest, complete: boolean): XaiCodeExecutionObservation {
  return executionEvidence(observeXaiSearch(value, request, complete));
}
export async function readXaiCodeExecution(response: Response, request: XaiCodeExecutionRequest, signal: AbortSignal): Promise<XaiCodeExecutionObservation> {
  return executionEvidence(await readXaiSearch(response, request, signal));
}
function executionEvidence(observation: XaiSearchObservation): XaiCodeExecutionObservation {
  const types = new Set<string>();
  for (const item of (observation.body.output ?? []) as unknown[]) {
    if (!mediaObject(item) || item.type === undefined) continue;
    if (typeof item.type !== "string" || !/^[a-z][a-z0-9_]{0,127}$/.test(item.type)) fail();
    types.add(item.type);
  }
  const details = observation.usage?.server_side_tool_usage_details;
  const count = mediaObject(details) ? details.code_interpreter_calls : undefined;
  if (count != null && (!Number.isSafeInteger(count) || Number(count) < 0)) fail();
  return { ...observation, outputTypes: [...types], usedCodeExecution: types.has("code_interpreter_call"),
    codeInterpreterCalls: count == null ? null : Number(count) };
}
function modelId(value: unknown): value is string { return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value); }
function fail(): never { throw new Error("invalid_xai_code_execution"); }
