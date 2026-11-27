import { generateSecret } from "../ui-helpers";
import type { CredentialOperations } from "./use-credential-operations";

export function useSelfServiceKeys(owner: CredentialOperations) {
  async function issue(policyId: string, credentialId?: string, options?: { days: number; serviceTiers: string[]; name?: string }) {
    if (!owner.rows.policyIds.includes(policyId)) return owner.reject("personal", "This policy is no longer held. Refresh your access before creating or rotating a key.");
    if (credentialId && !owner.rows.personal.find((item) => item.credentialId === credentialId && item.enabled && (item.active || item.expired))) return owner.reject("personal", "only an active credential can be rotated");
    await owner.mutate({ surface: "personal", operation: credentialId ? "rotate" : "create", policyId, credentialId: credentialId ?? `key_${generateSecret(8)}`, ...(!credentialId && options ? { expiresAt: new Date(Date.now() + options.days * 86_400_000).toISOString(), serviceTiers: options.serviceTiers, ...(options.name?.trim() ? { name: options.name.trim() } : {}) } : {}) });
  }

  async function revoke(credentialId: string) {
    const credential = owner.rows.personal.find((item) => item.credentialId === credentialId);
    if (credential) await owner.mutate({ surface: "personal", operation: "revoke", ...credential });
  }

  async function rename(credentialId: string, name: string) {
    const credential = owner.rows.personal.find((item) => item.credentialId === credentialId);
    if (!credential) return false;
    const result = await owner.mutate({ ...credential, surface: "personal", operation: "rename", name: name.trim() || null });
    return Boolean(result?.presented);
  }

  return { items: owner.rows.personal, policyIds: owner.rows.policyIds, issue, revoke, rename };
}
