import { createJobEnvelopeParser, isJobRecord as record } from "./job-envelope.ts";

// Concrete queue protocol only; scoped jobs and tariff settlement belong to the runtime.
export const FAL_QUEUE_ORIGIN = "https://queue.fal.run";
export const FAL_MAX_ENVELOPE_BYTES = 1024 * 1024;

const envelope = createJobEnvelopeParser(FAL_MAX_ENVELOPE_BYTES, "fal_envelope_too_large", "invalid_fal_envelope");

export function validateFalRequestId(id: unknown): string {
  if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) {
    throw new Error("invalid_fal_request_id");
  }
  return id;
}

export function falQueuePaths(endpointId: string, requestId?: string): {
  submit: string; status: string | null; result: string | null; cancel: string | null;
} {
  // Pinned model identity, not an arbitrary URL or a path from the upstream body.
  const parts = endpointId.split("/");
  if (endpointId.length > 256 || parts.length < 2 || parts.length > 8
    || parts.some((part) => !/^[a-zA-Z0-9_-]{1,64}$/.test(part))) {
    throw new Error("invalid_fal_endpoint_id");
  }
  const root = requestId === undefined ? null
    : `/${parts[0]}/${parts[1]}/requests/${validateFalRequestId(requestId)}`;
  return {
    submit: `/${endpointId}`,
    status: root === null ? null : `${root}/status`,
    result: root,
    cancel: root === null ? null : `${root}/cancel`,
  };
}

export function prepareFalQueueSubmit(endpointId: string, query = new URLSearchParams()): {
  path: string; method: "POST"; headers: Headers;
} {
  // This slice has no webhook receiver or caller-controlled retry/retention policy.
  if (query.size !== 0) throw new Error("unsupported_fal_queue_query");
  return {
    path: falQueuePaths(endpointId).submit,
    method: "POST",
    headers: new Headers({
      "Content-Type": "application/json",
      "X-Fal-No-Retry": "1",
      "X-Fal-Request-Start-Timeout": "600",
    }),
  };
}

export interface FalQueueObservation {
  id: string;
  status: "IN_QUEUE" | "IN_PROGRESS" | "COMPLETED";
  queueTerminal: boolean;
  resultRequired: boolean;
  failed: boolean;
  inferenceTimeSeconds: number | null;
}

export function parseFalSubmission(text: string): { id: string } {
  // Older submit envelopes omit status. Bind the ID, then observe the status
  // endpoint; do not invent a queue state or discard a valid submitted job.
  return { id: validateFalRequestId(envelope(text).request_id) };
}

export function parseFalQueueObservation(text: string, expectedId?: string): FalQueueObservation {
  const body = envelope(text);
  const id = validateFalRequestId(body.request_id);
  if (expectedId !== undefined && id !== validateFalRequestId(expectedId)) throw new Error("fal_request_id_mismatch");
  const status = body.status;
  if (status !== "IN_QUEUE" && status !== "IN_PROGRESS" && status !== "COMPLETED") {
    throw new Error("unsupported_fal_queue_status");
  }
  let inferenceTimeSeconds: number | null = null;
  if (body.metrics !== undefined && body.metrics !== null) {
    if (!record(body.metrics)) throw new Error("invalid_fal_metrics");
    const seconds = body.metrics.inference_time;
    if (seconds !== undefined && seconds !== null) {
      if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) throw new Error("invalid_fal_metrics");
      inferenceTimeSeconds = seconds;
    }
  }
  for (const key of ["error", "error_type"]) {
    if (body[key] !== undefined && body[key] !== null && typeof body[key] !== "string") throw new Error("invalid_fal_error");
  }
  const failed = !!body.error || !!body.error_type;
  if (failed && status !== "COMPLETED") throw new Error("invalid_fal_error");
  return {
    id, status, queueTerminal: status === "COMPLETED", resultRequired: status === "COMPLETED",
    failed, inferenceTimeSeconds,
  };
}

export function parseFalCancelAcknowledgement(httpStatus: number, text: string): {
  disposition: "removed_from_queue" | "cancellation_requested" | "already_completed" | "not_found";
  queueTerminal: boolean;
  observeStatus: boolean;
} {
  // The response has no request ID. Only consume it on an already bound control
  // request using the original credential, fixed origin and no-redirect transport.
  const { status } = envelope(text);
  if (httpStatus === 200 && status === "OK") {
    return { disposition: "removed_from_queue", queueTerminal: true, observeStatus: false };
  }
  if (httpStatus === 202 && status === "CANCELLATION_REQUESTED") {
    return { disposition: "cancellation_requested", queueTerminal: false, observeStatus: true };
  }
  if (httpStatus === 400 && status === "ALREADY_COMPLETED") {
    return { disposition: "already_completed", queueTerminal: false, observeStatus: true };
  }
  if (httpStatus === 404 && status === "NOT_FOUND") {
    return { disposition: "not_found", queueTerminal: false, observeStatus: true };
  }
  throw new Error("invalid_fal_cancel_acknowledgement");
}

export function parseFalResult(text: string, httpStatus: number): {
  body: Record<string, unknown>; httpSucceeded: boolean;
} {
  // Model-specific content is transient. The runtime must qualify the model's
  // result schema/tariff before billing or downloading any media.
  const body = envelope(text);
  if (!Number.isInteger(httpStatus) || httpStatus < 200 || httpStatus > 599
    || (httpStatus >= 300 && httpStatus < 400)) throw new Error("invalid_fal_result_status");
  return { body, httpSucceeded: httpStatus >= 200 && httpStatus < 300 && !body.error && !body.error_type };
}
