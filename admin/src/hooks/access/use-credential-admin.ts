import { type FormEvent, useRef, useState } from "react";
import { generateSecret } from "../../ui-helpers";
import { defaultCredential } from "../../ui-config";
import type { AccessPolicy, CredentialForm, ProxyCredential } from "../../ui-types";
import type { CredentialOperations } from "../use-credential-operations";

export function useCredentialAdmin(owner: CredentialOperations, policies: AccessPolicy[]) {
  const blank = (): CredentialForm => ({ ...defaultCredential });
  const draftRef = useRef({ scope: owner.scopeEpoch, form: blank(), selectedId: "" });
  const [, render] = useState(0);
  if (draftRef.current.scope !== owner.scopeEpoch) draftRef.current = { scope: owner.scopeEpoch, form: blank(), selectedId: "" };
  const draft = draftRef.current;

  function update(form: CredentialForm, selectedId = draftRef.current.selectedId) {
    owner.invalidatePresentation();
    draftRef.current = { scope: owner.scopeEpoch, form, selectedId };
    render((value) => value + 1);
  }

  async function issue(event: FormEvent) {
    event.preventDefault();
    const submitted = draftRef.current;
    const { form } = submitted;
    const credentialId = form.credentialId.trim() || `key_${generateSecret(8)}`;
    if (!/^[A-Za-z0-9_]{4,128}$/.test(credentialId)) return owner.reject("admin", "credential id must use 4-128 letters, numbers, or underscores");
    if (!policies.some((policy) => policy.policyId === form.policyId && policy.enabled)) return owner.reject("admin", "select an enabled policy for this credential");
    const principalId = form.principalId.trim().toLowerCase() || null;
    if (principalId && (principalId.length > 320 || !/^[^\s@]+@[^\s@]+$/.test(principalId))) return owner.reject("admin", "owner must be a valid user email");
    const result = await owner.mutate({ surface: "admin", operation: "create", credentialId, policyId: form.policyId, principalId });
    // An owned completion may reset its own draft without dismissing its new reveal.
    if (result?.presented && draftRef.current === submitted) {
      draftRef.current = { ...submitted, form: { ...form, credentialId: "" }, selectedId: credentialId };
      render((value) => value + 1);
    }
  }

  async function rotate(credential: ProxyCredential) {
    if (!credential.active) return owner.reject("admin", "only an active credential can be rotated");
    await owner.mutate({ surface: "admin", operation: "rotate", ...credential });
  }

  async function revoke(credential: ProxyCredential) {
    await owner.mutate({ surface: "admin", operation: "revoke", ...credential });
  }

  return {
    items: owner.rows.admin,
    selected: owner.rows.admin.find((item) => item.credentialId === draft.selectedId),
    form: draft.form,
    setForm: (form: CredentialForm) => update(form),
    edit: (credential: ProxyCredential) => update(draftRef.current.form, credential.credentialId),
    startNew: () => update(draftRef.current.form, ""),
    issue, rotate, revoke,
  };
}
