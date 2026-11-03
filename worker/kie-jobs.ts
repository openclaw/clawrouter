import { createJobEnvelopeParser, isJobRecord as record } from "./job-envelope.ts";
import { kieKlingModels, prepareKieKlingWire } from "./kie-kling.ts";
import { kieGrokModels, prepareKieGrokWire } from "./kie-grok.ts";

export const KIE_JOB_ORIGIN = "https://api.kie.ai";
export const KIE_CREATE_TASK_PATH = "/api/v1/jobs/createTask";
export const KIE_MAX_ENVELOPE_BYTES = 1024 * 1024;

const jsonObject = createJobEnvelopeParser(KIE_MAX_ENVELOPE_BYTES, "kie_envelope_too_large", "invalid_kie_envelope");

function taskData(text: string, httpStatus: number): Record<string, unknown> {
  const body = jsonObject(text);
  // Market endpoints can report authentication/ownership errors with HTTP 200.
  // Such an observation is not a terminal job failure or proof of a refund.
  if (!Number.isInteger(httpStatus) || httpStatus < 200 || httpStatus >= 300
    || body.code !== 200 || body.success === false) throw new Error("kie_request_rejected");
  if (!record(body.data)) throw new Error("invalid_kie_data");
  return body.data;
}

export function validateKieTaskId(id: unknown): string {
  if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error("invalid_kie_task_id");
  return id;
}

export function kieTaskPath(taskId: string): string {
  return `/api/v1/jobs/recordInfo?taskId=${validateKieTaskId(taskId)}`;
}

export function prepareKieTask(body: unknown): { body: Record<string, unknown>; model: string } {
  // The runtime must bound the request before parsing and pin this model's policy.
  if (!record(body) || !record(body.input) || typeof body.model !== "string"
    || body.model.length > 256 || !/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/.test(body.model)) {
    throw new Error("invalid_kie_create");
  }
  if (Object.hasOwn(body, "callBackUrl")) throw new Error("kie_polling_only");
  if (body.model === kieKlingModels[1]) throw new Error("kie_image_binding_required");
  if (body.model === kieKlingModels[0]) return prepareKieKlingTask(body);
  if (body.model === kieGrokModels[1]) throw new Error("kie_image_binding_required");
  if (body.model === kieGrokModels[0]) {
    const prepared = prepareKieGrokWire(body);
    return { body: prepared.body, model: prepared.model };
  }
  return { body, model: body.model };
}

function prepareKieKlingTask(body: Record<string, unknown>): { body: Record<string, unknown>; model: string } {
  const prepared = prepareKieKlingWire(body);
  return { body: prepared.body, model: prepared.model };
}

export function parseKieSubmission(text: string, httpStatus: number): { id: string } {
  return { id: validateKieTaskId(taskData(text, httpStatus).taskId) };
}

export interface KieTaskObservation {
  id: string;
  state: "waiting" | "queuing" | "generating" | "success" | "fail";
  terminal: boolean;
  creditsConsumed: number | null;
}

export function parseKieTask(text: string, httpStatus: number, expectedId: string): KieTaskObservation {
  return taskObservation(taskData(text, httpStatus), expectedId);
}

function taskObservation(data: Record<string, unknown>, expectedId: string): KieTaskObservation {
  const id = validateKieTaskId(data.taskId);
  if (id !== validateKieTaskId(expectedId)) throw new Error("kie_task_id_mismatch");
  const state = data.state;
  if (state !== "waiting" && state !== "queuing" && state !== "generating" && state !== "success" && state !== "fail") {
    throw new Error("unsupported_kie_task_state");
  }
  let creditsConsumed: number | null = null;
  if (data.creditsConsumed !== undefined && data.creditsConsumed !== null) {
    if (typeof data.creditsConsumed !== "number" || !Number.isFinite(data.creditsConsumed) || data.creditsConsumed < 0) {
      throw new Error("invalid_kie_credits");
    }
    creditsConsumed = data.creditsConsumed;
  }
  return { id, state, terminal: state === "success" || state === "fail", creditsConsumed };
}

export function parseKieResultUrls(text: string, httpStatus: number, expectedId: string): string[] {
  const data = taskData(text, httpStatus);
  const observation = taskObservation(data, expectedId);
  if (observation.state !== "success") throw new Error("kie_result_not_successful");
  if (typeof data.resultJson !== "string") throw new Error("invalid_kie_result");
  const result = jsonObject(data.resultJson);
  if (!Array.isArray(result.resultUrls) || result.resultUrls.length === 0 || result.resultUrls.length > 64) {
    throw new Error("invalid_kie_result");
  }
  return result.resultUrls.map((value: unknown) => {
    if (typeof value !== "string" || value.length > 8192) throw new Error("invalid_kie_result_url");
    let url: URL;
    try { url = new URL(value); } catch { throw new Error("invalid_kie_result_url"); }
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) {
      throw new Error("invalid_kie_result_url");
    }
    // These are opaque transient outputs, not authenticated control URLs. A
    // consumer must apply its own download origin/SSRF/size policy before fetch.
    return value;
  });
}
