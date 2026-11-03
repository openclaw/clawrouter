import { createJobEnvelopeParser, isJobRecord as record } from "./job-envelope.ts";

// Protocol helpers only. The runtime owns admission, scoped binding and settlement.
export const REPLICATE_MAX_PREDICTION_BYTES = 1024 * 1024;
const parseEnvelope = createJobEnvelopeParser(REPLICATE_MAX_PREDICTION_BYTES, "replicate_prediction_too_large", "invalid_replicate_prediction");
export const REPLICATE_MAX_CANCEL_AFTER_SECONDS = 600;
export const REPLICATE_OBSERVATION_WINDOW_SECONDS = 3600;

export type ReplicatePredictionStatus =
  | "starting"
  | "processing"
  | "succeeded"
  | "failed"
  | "canceled"
  | "aborted";

export interface ReplicateObservation {
  id: string;
  status: ReplicatePredictionStatus;
  terminal: boolean;
  version: string | null;
  predictTimeSeconds: number | null;
}

export interface ReplicatePrediction {
  // Transient response content: never persist this in the job or receipt.
  body: Record<string, unknown>;
  observation: ReplicateObservation;
}

export function validateReplicatePredictionId(value: unknown): string {
  // Router acceptance limit, not a claim about every future vendor ID format.
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) {
    throw new Error("invalid_replicate_prediction_id");
  }
  return value;
}

export function replicateControlPath(manifestPath: string, predictionId: string): string {
  if (manifestPath !== "/v1/predictions/${prediction_id}"
    && manifestPath !== "/v1/predictions/${prediction_id}/cancel") {
    throw new Error("invalid_replicate_control_path");
  }
  return manifestPath.replace("${prediction_id}", validateReplicatePredictionId(predictionId));
}

export function replicateCancelAfter(value: string | null): string {
  if (value === null) return `${REPLICATE_MAX_CANCEL_AFTER_SECONDS}s`;
  // Accept the documented integer seconds and compound h/m/s notation.
  if (value.length > 32 || !/^(?:\d+|(?:(?:\d+h)?(?:\d+m)?(?:\d+s)?))$/.test(value) || !value) {
    throw new Error("invalid_replicate_cancel_after");
  }
  let seconds = 0;
  if (/^\d+$/.test(value)) {
    seconds = Number(value);
  } else {
    for (const match of value.matchAll(/(\d+)([hms])/g)) {
      seconds += Number(match[1]) * (match[2] === "h" ? 3600 : match[2] === "m" ? 60 : 1);
    }
  }
  if (!Number.isSafeInteger(seconds) || seconds < 5) {
    throw new Error("invalid_replicate_cancel_after");
  }
  return `${Math.min(seconds, REPLICATE_MAX_CANCEL_AFTER_SECONDS)}s`;
}

export function prepareReplicateCreate(body: unknown, callerHeaders = new Headers()): {
  body: Record<string, unknown>;
  headers: Headers;
  requestedVersion: string;
} {
  // The common request parser must enforce its byte limit before calling this.
  if (!record(body) || !record(body.input) || typeof body.version !== "string"
    || body.version.length > 256
    || !/^(?:[a-f0-9]{64}|[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+(?::[a-f0-9]{64})?)$/.test(body.version)) {
    throw new Error("invalid_replicate_create");
  }
  if (["webhook", "webhook_events_filter", "stream"].some((key) => Object.hasOwn(body, key))) {
    throw new Error("replicate_polling_only");
  }
  // Deliberately do not copy credentials, Prefer: wait, or Idempotency-Key.
  // Scoped idempotency is local: uncertain upstream POSTs must never be replayed.
  const headers = new Headers({
    "Content-Type": "application/json",
    "Cancel-After": replicateCancelAfter(callerHeaders.get("Cancel-After")),
  });
  return { body, headers, requestedVersion: body.version };
}

export function parseReplicatePrediction(text: string, expectedId?: string): ReplicatePrediction {
  const body = parseEnvelope(text);
  const id = validateReplicatePredictionId(body.id);
  if (expectedId !== undefined && id !== validateReplicatePredictionId(expectedId)) {
    throw new Error("replicate_prediction_id_mismatch");
  }
  const status = body.status;
  if (status !== "starting" && status !== "processing" && status !== "succeeded"
    && status !== "failed" && status !== "canceled" && status !== "aborted") {
    throw new Error("unsupported_replicate_prediction_status");
  }
  let version: string | null = null;
  if (body.version !== undefined && body.version !== null) {
    if (typeof body.version !== "string" || !/^[a-zA-Z0-9_./:-]{1,256}$/.test(body.version)) {
      throw new Error("invalid_replicate_prediction_version");
    }
    version = body.version;
  }
  let predictTimeSeconds: number | null = null;
  if (body.metrics !== undefined && body.metrics !== null) {
    if (!record(body.metrics)) throw new Error("invalid_replicate_prediction_metrics");
    const seconds = body.metrics.predict_time;
    if (seconds !== undefined && seconds !== null) {
      if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) {
        throw new Error("invalid_replicate_prediction_metrics");
      }
      predictTimeSeconds = seconds;
    }
  }
  return {
    body,
    observation: {
      id, status, version, predictTimeSeconds,
      terminal: status === "succeeded" || status === "failed" || status === "canceled" || status === "aborted",
    },
  };
}

export async function readReplicatePrediction(response: Response, expectedId?: string): Promise<ReplicatePrediction> {
  // A successful cancel HTTP status alone is not terminal evidence.
  const mime = response.headers.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase();
  if (!response.ok || mime !== "application/json" || !response.body) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("invalid_replicate_prediction_response");
  }
  const length = response.headers.get("Content-Length");
  if (length !== null && /^\d+$/.test(length) && Number(length) > REPLICATE_MAX_PREDICTION_BYTES) {
    await response.body.cancel().catch(() => undefined);
    throw new Error("replicate_prediction_too_large");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > REPLICATE_MAX_PREDICTION_BYTES) throw new Error("replicate_prediction_too_large");
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } catch {
    await reader.cancel().catch(() => undefined);
    throw new Error("incomplete_replicate_prediction_response");
  } finally {
    reader.releaseLock();
  }
  return parseReplicatePrediction(text, expectedId);
}

export function rewriteReplicatePredictionUrls(
  prediction: ReplicatePrediction,
  routerPaths: { get: string; cancel: string },
): Record<string, unknown> {
  // Called only after the runtime commits the ID/owner binding. These are trusted
  // router routes, never a caller Host header or upstream response URLs.
  for (const path of [routerPaths.get, routerPaths.cancel]) {
    if (!/^\/(?!\/)[a-zA-Z0-9_/-]+$/.test(path)) {
      throw new Error("invalid_replicate_router_path");
    }
  }
  // Drop upstream stream/web URLs too: this slice exposes only scoped polling.
  return { ...prediction.body, urls: { get: routerPaths.get, cancel: routerPaths.cancel } };
}
