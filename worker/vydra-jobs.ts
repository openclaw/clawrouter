import { createJobEnvelopeParser, isJobRecord as record } from "./job-envelope.ts";

export const VYDRA_JOB_ORIGIN = "https://www.vydra.ai";
export const VYDRA_CREATE_JOB_PATH = "/api/v1/jobs";
export const VYDRA_MAX_ENVELOPE_BYTES = 1024 * 1024;

const parseEnvelope = createJobEnvelopeParser(VYDRA_MAX_ENVELOPE_BYTES, "vydra_envelope_too_large", "invalid_vydra_envelope");

function envelope(text: string, httpStatus: number): Record<string, unknown> {
  if (!Number.isInteger(httpStatus) || httpStatus < 200 || httpStatus >= 300) throw new Error("vydra_request_rejected");
  return parseEnvelope(text);
}

export function validateVydraJobId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw new Error("invalid_vydra_job_id");
  return value;
}

export function vydraJobPath(id: string): string {
  return `${VYDRA_CREATE_JOB_PATH}/${validateVydraJobId(id)}`;
}

export function prepareVydraJob(body: unknown): { body: Record<string, unknown>; workflow: string } {
  if (!record(body) || !record(body.input) || typeof body.workflow !== "string"
    || !["generate_video", "generate_image", "generate_speech", "lipsync_video", "transfer_motion", "edit_image"].includes(body.workflow)) {
    throw new Error("unsupported_vydra_workflow");
  }
  if (Object.hasOwn(body, "webhookUrl")) throw new Error("vydra_polling_only");
  return { body, workflow: body.workflow };
}

function ledgerUnits(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("invalid_vydra_credit_units");
  return value;
}

export interface VydraJobObservation {
  id: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  terminal: boolean;
  chargedLedgerUnits: number | null;
  refundedLedgerUnits: number | null;
  refundStatus: string | null;
}

function observation(body: Record<string, unknown>, expectedId?: string): VydraJobObservation {
  const id = validateVydraJobId(body.id);
  if (expectedId !== undefined && id !== validateVydraJobId(expectedId)) throw new Error("vydra_job_id_mismatch");
  const status = body.status;
  if (status !== "pending" && status !== "running" && status !== "completed" && status !== "failed" && status !== "cancelled") {
    throw new Error("unsupported_vydra_job_status");
  }
  const refundStatus = body.refundStatus ?? null;
  if (refundStatus !== null && (typeof refundStatus !== "string" || !/^[a-z_]{1,64}$/.test(refundStatus))) {
    throw new Error("invalid_vydra_refund_status");
  }
  return {
    id, status, terminal: status === "completed" || status === "failed" || status === "cancelled",
    chargedLedgerUnits: ledgerUnits(body.creditsCharged),
    refundedLedgerUnits: ledgerUnits(body.creditsRefunded),
    refundStatus,
  };
}

export function parseVydraSubmission(text: string, httpStatus: number): { observation: VydraJobObservation; retrieveResult: true } {
  // Canonical /jobs is top-level and not the Studio data envelope. Even immediate
  // completion needs a scoped GET for output; POST retries can create new charges.
  return { observation: observation(envelope(text, httpStatus)), retrieveResult: true };
}

export function parseVydraJob(text: string, httpStatus: number, expectedId: string): VydraJobObservation {
  return observation(envelope(text, httpStatus), expectedId);
}

export function parseVydraResult(text: string, httpStatus: number, expectedId: string): Record<string, unknown> {
  const body = envelope(text, httpStatus);
  if (observation(body, expectedId).status !== "completed") throw new Error("vydra_result_not_completed");
  if (body.output !== undefined && body.result !== undefined) throw new Error("ambiguous_vydra_result");
  const output = body.output ?? body.result;
  if (!record(output)) throw new Error("invalid_vydra_result");
  // Opaque transient media fields. The consumer owns schema, URL and download
  // qualification; this helper never follows _links or forwards credentials.
  return output;
}

export function parseVydraCancelAcknowledgement(text: string, httpStatus: number): {
  observeJob: true; refundApplied: boolean | null; refundedLedgerUnits: number | null;
} {
  const body = envelope(text, httpStatus);
  if (body.success !== true) throw new Error("vydra_cancel_not_acknowledged");
  if (body.refund !== undefined && body.refund !== null && !record(body.refund)) throw new Error("invalid_vydra_refund");
  const refund = record(body.refund) ? body.refund : null;
  const applied = refund?.applied ?? null;
  if (applied !== null && typeof applied !== "boolean") throw new Error("invalid_vydra_refund");
  // A bound DELETE acknowledgement has no ID or terminal status. Observe the
  // original job; refund evidence is not proof that provider compute stopped.
  return { observeJob: true, refundApplied: applied, refundedLedgerUnits: ledgerUnits(refund?.creditsRefunded) };
}
