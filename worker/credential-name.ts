import { HttpError } from "./utils.ts";

// One validator for creation, metadata writes and the serialized rename path.
export function normalizeCredentialName(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || /[\u0000-\u001f\u007f-\u009f]/.test(value)) {
    throw new HttpError(400, "invalid_credential", "name must be a string or null without control characters");
  }
  const name = value.trim();
  if (name.length > 80) throw new HttpError(400, "invalid_credential", "name must be at most 80 characters");
  return name || null;
}

// Legacy metadata must not block importing an otherwise valid credential.
export function storedCredentialName(value: unknown): string | null {
  try { return normalizeCredentialName(value); }
  catch { return null; }
}
