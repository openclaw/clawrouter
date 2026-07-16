import type { AccessPolicyEntry, ProxyCredential, ProxyCredentialEntry } from "./types";
import { cleanId, HttpError, normalizeEmail } from "./utils";

export function credentialResponsesFrom(policyEntries: AccessPolicyEntry[], credentialEntries: ProxyCredentialEntry[]) {
  const policies = new Map(policyEntries.map((entry) => [entry.policyId, entry.policy]));
  return credentialEntries.map((entry) => {
    const policy = policies.get(entry.credential.policyId), generationMatches = !!policy && entry.credential.policyGeneration === policy.generation;
    return { credentialId: entry.credentialId, policyId: entry.credential.policyId, enabled: entry.credential.enabled, policyEnabled: policy?.enabled ?? false, generationMatches, active: entry.credential.enabled && !!policy?.enabled && generationMatches, principalId: entry.credential.principalId ?? null };
  });
}

export function normalizeCredential(value: unknown): Omit<ProxyCredential, "policyGeneration"> {
  const body = mutationObject(value);
  if (typeof body.policyId !== "string") throw new HttpError(400, "invalid_credential", "policyId must be a string");
  const policyId = cleanId(body.policyId);
  if (!policyId) throw new HttpError(400, "invalid_credential", "policyId is invalid");
  if (typeof body.secretSha256 !== "string" || !/^[0-9a-f]{64}$/i.test(body.secretSha256)) throw new HttpError(400, "invalid_credential", "secretSha256 must be a SHA-256 hex digest");
  const enabled = body.enabled === undefined ? true : body.enabled;
  if (typeof enabled !== "boolean") throw new HttpError(400, "invalid_credential", "enabled must be a boolean");
  let principalId: string | null = null;
  if (body.principalId !== undefined && body.principalId !== null) {
    if (typeof body.principalId !== "string") throw new HttpError(400, "invalid_credential", "principalId must be an email or null");
    const candidate = body.principalId.trim();
    if (candidate) {
      principalId = normalizeEmail(candidate);
      if (!principalId) throw new HttpError(400, "invalid_credential", "principalId must be a valid email");
    }
  }
  return { enabled, secretSha256: body.secretSha256.toLowerCase(), policyId, principalId };
}

export function selfServiceCredentialId(value: string): string | null {
  const id = cleanId(value);
  return id && id.length >= 4 ? id : null;
}

function mutationObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "invalid_credential", "credential must be a JSON object");
  return value as Record<string, unknown>;
}
