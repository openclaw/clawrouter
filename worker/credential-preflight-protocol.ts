import { identityFailure, identitySourceSnapshot, type IdentitySourceBudget } from "./identity-admission.ts";

export const credentialPreflightPath = "/admission/credential-preflight";
export const credentialPreflightNamespace = "policy-bindings";
export const credentialPreflightHeader = "x-clawrouter-credential-preflight";
export const credentialPreflightVersion = "v1";
// Derived from the admitted RAW header, shortest accepted prefix, separator and
// existing eight-character secret minimum. This is NOT a request wire ceiling.
export const credentialPreflightKidUnits = 4096 - "ocpk_live_".length - 1 - 8;
export type CredentialPreflightOutcome = "unknown" | "invalid" | "matched";
export interface CredentialPreflightRequest { credentialId: string; secretSha256: string; source: IdentitySourceBudget }
export interface CredentialPreflightReply { outcome: CredentialPreflightOutcome; source: IdentitySourceBudget }

function fields(value: unknown, names: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw identityFailure("protocol");
  let count = 0;
  for (const key in value) if (Object.hasOwn(value, key)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!names.includes(key) || !Object.hasOwn(descriptor, "value")) throw identityFailure("protocol");
    count++;
  }
  if (count !== names.length) throw identityFailure("protocol");
}
export function checkPreflightIdentity(credentialId: unknown, secretSha256: unknown): asserts credentialId is string {
  if (typeof credentialId !== "string" || credentialId.length < 4 || credentialId.length > credentialPreflightKidUnits
    || !/^[A-Za-z0-9_-]+$/.test(credentialId) || credentialId.includes("_") && credentialId.includes("-")
    || typeof secretSha256 !== "string" || secretSha256.length !== 64 || !/^[0-9a-f]{64}$/.test(secretSha256)) throw identityFailure("protocol");
}
export function closePreflightRequest(value: unknown): CredentialPreflightRequest {
  fields(value, ["credentialId", "secretSha256", "source"]);
  checkPreflightIdentity(value.credentialId, value.secretSha256);
  return { credentialId: value.credentialId, secretSha256: value.secretSha256 as string, source: identitySourceSnapshot(value.source) };
}
export function closePreflightReply(value: unknown): CredentialPreflightReply {
  fields(value, ["outcome", "source"]);
  if (value.outcome !== "unknown" && value.outcome !== "invalid" && value.outcome !== "matched") throw identityFailure("protocol");
  return { outcome: value.outcome, source: identitySourceSnapshot(value.source) };
}
