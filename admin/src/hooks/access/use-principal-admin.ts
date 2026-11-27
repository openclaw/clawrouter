import { type FormEvent, useRef, useState } from "react";
import { accessFormFromUser, bindingFormFromBinding, bindingKey, errorMessage, optionalNumber, parseGroups, reconcileDirectUserBindings } from "../../domain";
import { defaultAccess, defaultBinding, demo } from "../../ui-config";
import type { ConsoleRequest } from "../../dashboard-fetch";
import type { AccessForm, AccessPolicy, AccessUser, BindingForm, PolicyBinding, SessionResponse } from "../../ui-types";

interface Dependencies {
  request: ConsoleRequest;
  allowDemo: boolean;
  gatewayOrigin: string;
  session: SessionResponse;
  demoMode: boolean;
  policies: AccessPolicy[];
  selectedPolicyId: string;
  setPolicyError: (message: string) => void;
  setStatus: (status: string) => void;
  refresh: () => Promise<void>;
}

function sameUserForm(left: AccessForm, right: AccessForm) {
  return left.email === right.email && left.tenantId === right.tenantId && left.enabled === right.enabled &&
    left.groups === right.groups && left.contentRetentionDisabled === right.contentRetentionDisabled &&
    left.policyIds.length === right.policyIds.length && left.policyIds.every((id, i) => id === right.policyIds[i]);
}

function sameBindingForm(left: BindingForm, right: BindingForm) {
  return left.policyId === right.policyId && left.principalType === right.principalType &&
    left.principalId === right.principalId && left.enabled === right.enabled && left.priority === right.priority;
}

// A stale policy list must not prevent disabling the exact binding we loaded.
export function isBindingDisableOnly(form: BindingForm, selected: PolicyBinding | undefined) {
  return selected?.enabled === true && !form.enabled && form.policyId === selected.policyId &&
    form.principalType === selected.principalType && form.principalId === selected.principalId &&
    form.priority === String(selected.priority);
}

export function usePrincipalAdmin({ request, allowDemo, gatewayOrigin, session, demoMode, policies, selectedPolicyId, setPolicyError, setStatus, refresh }: Dependencies) {
  const [users, setUsers] = useState<AccessUser[]>(allowDemo ? demo.users : []);
  const [bindings, setBindings] = useState<PolicyBinding[]>(allowDemo ? demo.bindings : []);
  const [accessForm, setAccessForm] = useState(allowDemo && demo.users[0] ? accessFormFromUser(demo.users[0], demo.bindings) : defaultAccess);
  const [bindingForm, setBindingForm] = useState<BindingForm>(allowDemo && demo.keys[0] ? { ...defaultBinding, policyId: demo.keys[0].policyId } : defaultBinding);
  const [selectedUserEmail, setSelectedUserEmail] = useState(demo.users[0]?.email ?? "");
  const [selectedBindingKey, setSelectedBindingKey] = useState(allowDemo ? bindingKey(demo.bindings[0]) : "");
  const [userError, setUserError] = useState("");
  const bindingPending = useRef(false);
  const selectedUser = selectedUserEmail ? users.find((user) => user.email === selectedUserEmail) : undefined;
  const selectedBinding = bindings.find((binding) => bindingKey(binding) === selectedBindingKey);
  const editor = useRef({ email: selectedUserEmail, revision: 0, form: accessForm, baseline: accessForm });
  const bindingEditor = useRef({ key: selectedBindingKey || null, revision: 0, form: bindingForm, baseline: bindingForm });
  const pendingUser = useRef(false);

  function showBinding(key: string | null, form: BindingForm) {
    bindingEditor.current = { key, revision: bindingEditor.current.revision + 1, form, baseline: form };
    setSelectedBindingKey(key ?? "");
    setBindingForm(form);
  }

  function editBindingForm(form: BindingForm) {
    bindingEditor.current.form = form;
    bindingEditor.current.revision++;
    setBindingForm(form);
  }

  function showUser(email: string, form: AccessForm) {
    editor.current = { email, revision: editor.current.revision + 1, form, baseline: form };
    setSelectedUserEmail(email);
    setAccessForm(form);
  }

  function selectUser(email: string) {
    const user = users.find(item => item.email === email);
    if (user) showUser(email, accessFormFromUser(user, bindings));
    setUserError("");
  }

  function editUserForm(form: AccessForm) {
    editor.current.form = form;
    editor.current.revision++;
    setAccessForm(form);
  }

  function hydrate(nextUsers: AccessUser[], nextBindings: PolicyBinding[], background: boolean, policyId: string) {
    setUsers(nextUsers);
    setBindings(nextBindings);
    if (background) return;
    const currentBinding = bindingEditor.current;
    if (!bindingPending.current && currentBinding.key !== "" && sameBindingForm(currentBinding.form, currentBinding.baseline)) {
      const refreshedBinding = nextBindings.find((binding) => bindingKey(binding) === currentBinding.key) ?? nextBindings[0];
      showBinding(refreshedBinding ? bindingKey(refreshedBinding) : null, refreshedBinding ? bindingFormFromBinding(refreshedBinding) : { ...defaultBinding, policyId });
    }
    // Hydrate the list, not a draft owned by a save, a newly selected identity or unsaved edits.
    const current = editor.current;
    if (pendingUser.current || (!current.email && current.revision > 0)) return;
    const currentUser = nextUsers.find((user) => user.email === current.email);
    if (currentUser && !sameUserForm(current.form, current.baseline)) return;
    const refreshedUser = currentUser ?? nextUsers[0];
    showUser(refreshedUser?.email ?? "", refreshedUser ? accessFormFromUser(refreshedUser, nextBindings) : defaultAccess);
  }

  function hydrateUser(user: AccessUser) {
    setUsers([user]);
    setBindings([]);
    showUser(user.email, accessFormFromUser(user, []));
  }

  async function saveBinding(event: FormEvent) {
    event.preventDefault();
    if (bindingPending.current) return;
    const { form, revision } = bindingEditor.current;
    const ownsDraft = () => bindingEditor.current.revision === revision;
    bindingPending.current = true;
    try {
      setPolicyError("");
      const principalId = form.principalId.trim().toLowerCase();
      if (!principalId) throw new Error("principal is required");
      if (!policies.some((policy) => policy.policyId === form.policyId) && !isBindingDisableOnly(form, selectedBinding)) throw new Error("Select an available policy before saving this binding.");
      const next: PolicyBinding = { policyId: form.policyId, principalType: form.principalType, principalId, enabled: form.enabled, priority: optionalNumber(form.priority) ?? 100 };
      setStatus("saving binding");
      const saved = demoMode ? next : await request<PolicyBinding>(gatewayOrigin, "/v1/admin/policy-bindings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(next) });
      // Reconcile first so a read started before the PUT cannot replace its receipt.
      let refreshError = "";
      if (!demoMode) await refresh().catch(error => { refreshError = errorMessage(error); });
      setBindings((current) => [saved, ...current.filter((binding) => bindingKey(binding) !== bindingKey(saved))]);
      const canonical = bindingFormFromBinding(saved);
      if (ownsDraft()) {
        showBinding(bindingKey(saved), canonical);
        if (refreshError) setPolicyError("saved binding, but refresh failed: " + refreshError);
      } else if (bindingEditor.current.key === bindingKey(saved)) bindingEditor.current.baseline = canonical;
      setStatus(refreshError ? "saved binding; refresh failed" : "saved binding");
    } catch (caught) {
      const message = errorMessage(caught);
      if (ownsDraft()) setPolicyError(message);
      setStatus(ownsDraft() ? message : "Binding save failed: " + message);
    } finally {
      bindingPending.current = false;
    }
  }

  async function saveUser(event: FormEvent) {
    event.preventDefault();
    if (pendingUser.current) return;
    const { form, revision } = editor.current;
    const email = form.email.trim().toLowerCase();
    const ownsDraft = () => editor.current.revision === revision;
    const direct = (binding: PolicyBinding) => binding.principalType === "user" && binding.principalId === email;
    pendingUser.current = true;
    setUserError("");
    setStatus("saving user");
    try {
      if (!email.includes("@")) throw new Error("enter a valid email");
      if (editor.current.email && !selectedUser) throw new Error("This user is no longer in the identity list. Select a user before saving.");
      const profile = { tenantId: form.tenantId || "default", enabled: form.enabled, groups: parseGroups(form.groups), contentRetentionDisabled: form.contentRetentionDisabled };
      const saved = demoMode ? {
        user: { email, role: selectedUser?.role ?? "user", ...profile },
        bindings: reconcileDirectUserBindings(bindings, email, policies, form.policyIds).filter(direct),
      } : await request<{ user: AccessUser; bindings: PolicyBinding[] }>(gatewayOrigin, "/v1/admin/access-user-grants/" + encodeURIComponent(email), {
        method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...profile, policyIds: form.policyIds }),
      });
      if (saved.user.email !== email || !saved.bindings.every(direct)) throw new Error("The save response did not match the submitted user.");
      const canonical = accessFormFromUser(saved.user, saved.bindings);
      // The receipt belongs in the submitted user's records even if the inspector moved.
      // Wait for reconciliation first: a joined read may have been started before the PUT.
      let refreshError = "";
      if (!demoMode) await refresh().catch(error => { refreshError = errorMessage(error); });
      setUsers(current => current.some(user => user.email === email)
        ? current.map(user => user.email === email ? saved.user : user) : [...current, saved.user]);
      setBindings(current => [...current.filter(binding => !direct(binding)), ...saved.bindings]);
      if (ownsDraft()) {
        showUser(email, canonical);
        if (refreshError) setUserError("saved user, but refresh failed: " + refreshError);
      } else if (editor.current.email === email) editor.current.baseline = canonical;
      setStatus(refreshError ? "saved user; refresh failed" : "saved user");
    } catch (caught) {
      const message = errorMessage(caught);
      if (ownsDraft()) setUserError(message);
      await refresh().catch(() => undefined);
      setStatus(ownsDraft() ? message : "Save failed for " + email + ": " + message);
    } finally {
      pendingUser.current = false;
    }
  }

  function editBinding(binding: PolicyBinding) {
    showBinding(bindingKey(binding), bindingFormFromBinding(binding));
    setPolicyError("");
  }

  function startNewBinding() {
    showBinding("", { ...defaultBinding, policyId: selectedPolicyId || policies[0]?.policyId || "" });
    setPolicyError("");
  }

  function startNewUser() {
    showUser("", { ...defaultAccess, email: "", tenantId: session.tenantId ?? "default" });
    setUserError("");
  }

  return {
    bindings: { items: bindings, setItems: setBindings, selected: selectedBinding, selectedKey: selectedBindingKey, form: bindingForm, setForm: editBindingForm, save: saveBinding, edit: editBinding, startNew: startNewBinding },
    users: { items: users, setItems: setUsers, selected: selectedUser, selectedEmail: selectedUserEmail, setSelectedEmail: selectUser, form: accessForm, setForm: editUserForm, error: userError, setError: setUserError, save: saveUser, startNew: startNewUser },
    hydrate,
    hydrateUser,
  };
}
