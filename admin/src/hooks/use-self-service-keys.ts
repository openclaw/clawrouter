import { generateSecret } from "../ui-helpers";
import type { CredentialOperations } from "./use-credential-operations";

export function useSelfServiceKeys(owner: CredentialOperations) {
  async function issue(policyId: string, credentialId?: string) {
    if (!owner.rows.policyIds.includes(policyId)) return owner.reject("personal", "This policy is no longer held. Refresh your access before creating or rotating a key.");
    if (credentialId && !owner.rows.personal.find((item) => item.credentialId === credentialId)?.active) return owner.reject("personal", "only an active credential can be rotated");
    await owner.mutate({ surface: "personal", operation: credentialId ? "rotate" : "create", policyId, credentialId: credentialId ?? `key_${generateSecret(8)}` });
  }

  async function revoke(credentialId: string) {
    const credential = owner.rows.personal.find((item) => item.credentialId === credentialId);
    if (credential) await owner.mutate({ surface: "personal", operation: "revoke", ...credential });
  }

  return { items: owner.rows.personal, policyIds: owner.rows.policyIds, issue, revoke };
}
