import { type FormEvent, useRef, useState } from "react";
import { accessFormFromUser, bindingFormFromBinding, bindingKey, errorMessage, optionalNumber, parseGroups, reconcileDirectUserBindings } from "../../domain";
import { defaultAccess, defaultBinding, demo } from "../../ui-config";
import type { ConsoleRequest } from "../../dashboard-fetch";
import type { AccessPolicy, AccessUser, BindingForm, PolicyBinding, SessionResponse } from "../../ui-types";

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

  function hydrate(nextUsers: AccessUser[], nextBindings: PolicyBinding[], background: boolean, policyId: string) {
    setUsers(nextUsers);
    setBindings(nextBindings);
    if (background) return;
    const refreshedBinding = nextBindings.find((binding) => bindingKey(binding) === selectedBindingKey) ?? nextBindings[0];
    setSelectedBindingKey(refreshedBinding ? bindingKey(refreshedBinding) : "");
    setBindingForm(refreshedBinding ? bindingFormFromBinding(refreshedBinding) : { ...defaultBinding, policyId });
    const refreshedUser = nextUsers.find((user) => user.email === selectedUserEmail) ?? nextUsers[0];
    setSelectedUserEmail(refreshedUser?.email ?? "");
    setAccessForm(refreshedUser ? accessFormFromUser(refreshedUser, nextBindings) : defaultAccess);
  }

  function hydrateUser(user: AccessUser) {
    setUsers([user]);
    setBindings([]);
    setSelectedUserEmail(user.email);
    setAccessForm(accessFormFromUser(user, []));
  }

  async function saveBinding(event: FormEvent) {
    event.preventDefault();
    if (bindingPending.current) return;
    bindingPending.current = true;
    try {
      setPolicyError("");
      const principalId = bindingForm.principalId.trim().toLowerCase();
      if (!principalId) throw new Error("principal is required");
      if (!policies.some((policy) => policy.policyId === bindingForm.policyId) && !isBindingDisableOnly(bindingForm, selectedBinding)) throw new Error("Select an available policy before saving this binding.");
      const next: PolicyBinding = { policyId: bindingForm.policyId, principalType: bindingForm.principalType, principalId, enabled: bindingForm.enabled, priority: optionalNumber(bindingForm.priority) ?? 100 };
      setStatus("saving binding");
      const saved = demoMode ? next : await request<PolicyBinding>(gatewayOrigin, "/v1/admin/policy-bindings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(next) });
      setBindings((current) => [saved, ...current.filter((binding) => bindingKey(binding) !== bindingKey(saved))]);
      if (!demoMode) await refresh();
      setSelectedBindingKey(bindingKey(saved));
      setBindingForm(bindingFormFromBinding(saved));
      setStatus("saved binding");
    } catch (caught) {
      const message = errorMessage(caught);
      setPolicyError(message);
      setStatus(message);
    } finally {
      bindingPending.current = false;
    }
  }

  async function saveUser(event: FormEvent) {
    event.preventDefault();
    try {
      setUserError("");
      setStatus("saving user");
      const email = accessForm.email.trim().toLowerCase();
      if (!email.includes("@")) throw new Error("enter a valid email");
      const next: AccessUser = {
        email,
        role: selectedUser?.role ?? "user",
        tenantId: accessForm.tenantId || "default",
        enabled: accessForm.enabled,
        groups: parseGroups(accessForm.groups),
        contentRetentionDisabled: accessForm.contentRetentionDisabled,
      };
      const nextBindings = reconcileDirectUserBindings(bindings, email, policies, accessForm.policyIds);
      if (demoMode) {
        setUsers((current) => [next, ...current.filter((user) => user.email !== email)]);
        setBindings(nextBindings);
        setSelectedUserEmail(email);
        setAccessForm(accessFormFromUser(next, nextBindings));
        setStatus("saved user");
        return;
      }
      await request<{ user: AccessUser; bindings: PolicyBinding[] }>(gatewayOrigin, `/v1/admin/access-user-grants/${encodeURIComponent(email)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tenantId: next.tenantId, enabled: next.enabled, groups: next.groups, contentRetentionDisabled: next.contentRetentionDisabled, policyIds: accessForm.policyIds }),
      });
      try {
        await refresh();
      } catch (caught) {
        const message = errorMessage(caught);
        setSelectedUserEmail(email);
        setAccessForm(accessFormFromUser(next, nextBindings));
        setUserError(`saved user, but refresh failed: ${message}`);
        setStatus("saved user; refresh failed");
        return;
      }
      setSelectedUserEmail(email);
      setAccessForm(accessFormFromUser(next, nextBindings));
      setStatus("saved user");
    } catch (caught) {
      const message = errorMessage(caught);
      setUserError(message);
      setStatus(message);
      await refresh().catch(() => undefined);
      setUserError(message);
      setStatus(message);
    }
  }

  function editBinding(binding: PolicyBinding) {
    setSelectedBindingKey(bindingKey(binding));
    setBindingForm(bindingFormFromBinding(binding));
  }

  function startNewBinding() {
    setSelectedBindingKey("");
    setBindingForm({ ...defaultBinding, policyId: selectedPolicyId || policies[0]?.policyId || "" });
  }

  function startNewUser() {
    setSelectedUserEmail("");
    setUserError("");
    setAccessForm({ ...defaultAccess, email: "", tenantId: session.tenantId ?? "default" });
  }

  return {
    bindings: { items: bindings, setItems: setBindings, selected: selectedBinding, selectedKey: selectedBindingKey, setSelectedKey: setSelectedBindingKey, form: bindingForm, setForm: setBindingForm, save: saveBinding, edit: editBinding, startNew: startNewBinding },
    users: { items: users, setItems: setUsers, selected: selectedUser, selectedEmail: selectedUserEmail, setSelectedEmail: setSelectedUserEmail, form: accessForm, setForm: setAccessForm, error: userError, setError: setUserError, save: saveUser, startNew: startNewUser },
    hydrate,
    hydrateUser,
  };
}
