import { HttpError, sha256Hex } from "./utils.ts";

// Separate namespace even when a provider reuses an OpenAI response-looking ID.
export function managedPredictionKey(value: string): Promise<string> {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) {
    throw new HttpError(400, "prediction_id_invalid", "prediction ID exceeds the supported scalar bounds");
  }
  return sha256Hex(JSON.stringify(["replicate.predictions", value]));
}

// Preserve the original Replicate namespace while separating every additional
// protocol and configured provider inside the caller's existing scope.
export function managedJobKey(protocol: string, providerId: string, value: string): Promise<string> {
  if (protocol === "replicate.predictions" && providerId === "replicate") return managedPredictionKey(value);
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw new HttpError(400, "prediction_id_invalid", "invalid managed job ID");
  return sha256Hex(JSON.stringify([protocol, providerId, value]));
}
