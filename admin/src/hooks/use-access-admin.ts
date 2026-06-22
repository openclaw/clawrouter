import { type FormEvent, useState } from "react";
import {
  accessFormFromUser,
  bindingFormFromBinding,
  bindingKey,
  currencyInput,
  errorMessage,
  knownPolicyProviders,
  optionalCurrencyMicros,
  optionalNumber,
  parseGroups,
  reconcileDirectUserBindings,
  unique,
} from "../domain";
import {
  defaultAccess,
  defaultAssignmentRule,
  defaultBinding,
  defaultCredential,
  defaultPolicy,
  defaultUpstreamGrant,
  demo,
  initialAccessTab,
  rolePresets,
} from "../ui-config";
import {
  assignmentRuleFormFromRule,
  demoGrantFromForm,
  demoRuleFromForm,
  generateSecret,
  parseCredentialBundle,
  policyFormFromPolicy,
  request,
  sha256Hex,
  upstreamGrantFormFromGrant,
} from "../ui-helpers";
import type {
  AccessPolicy,
  AccessTab,
  AccessUser,
  AssignmentRule,
  AssignmentRuleForm,
  BindingForm,
  CredentialForm,
  PolicyBinding,
  PolicyForm,
  ProviderConnection,
  ProviderReadiness,
  ProviderRow,
  ProxyCredential,
  RouteCatalog,
  SessionResponse,
  UpstreamGrant,
  UpstreamGrantForm,
} from "../ui-types";

interface AccessAdminDependencies {
  allowDemo: boolean;
  gatewayOrigin: string;
  session: SessionResponse;
  demoMode: boolean;
  providers: ProviderRow[];
  routes: RouteCatalog;
  setStatus: (status: string) => void;
  setProviderReadiness: React.Dispatch<React.SetStateAction<Record<string, ProviderReadiness>>>;
  refresh: () => Promise<void>;
  syncDemoAdmin: (policies: AccessPolicy[], credentials: ProxyCredential[], providers: ProviderRow[], routes: RouteCatalog, syncRows?: boolean) => void;
}

interface AdminRecords {
  policies: AccessPolicy[];
  credentials: ProxyCredential[];
  connections: ProviderConnection[];
  users: AccessUser[];
  bindings: PolicyBinding[];
  grants: UpstreamGrant[];
  rules: AssignmentRule[];
}

export function useAccessAdmin(dependencies: AccessAdminDependencies) {
  const { allowDemo, gatewayOrigin, session, demoMode, providers, routes, setStatus, setProviderReadiness, refresh, syncDemoAdmin } = dependencies;
  const [keys, setKeys] = useState<AccessPolicy[]>(allowDemo ? demo.keys : []);
  const [credentials, setCredentials] = useState<ProxyCredential[]>(allowDemo ? demo.credentials : []);
  const [connections, setConnections] = useState<ProviderConnection[]>(allowDemo ? demo.connections : []);
  const [upstreamGrants, setUpstreamGrants] = useState<UpstreamGrant[]>(allowDemo ? demo.upstreamGrants : []);
  const [assignmentRules, setAssignmentRules] = useState<AssignmentRule[]>(allowDemo ? demo.assignmentRules : []);
  const [users, setUsers] = useState<AccessUser[]>(allowDemo ? demo.users : []);
  const [bindings, setBindings] = useState<PolicyBinding[]>(allowDemo ? demo.bindings : []);
  const [loaded, setLoaded] = useState(allowDemo);
  const [policyForm, setPolicyForm] = useState<PolicyForm>(allowDemo && demo.keys[0] ? policyFormFromPolicy(demo.keys[0]) : defaultPolicy);
  const [credentialForm, setCredentialForm] = useState<CredentialForm>(allowDemo && demo.keys[0] ? { credentialId: "", policyId: demo.keys[0].policyId, principalId: "" } : defaultCredential);
  const [bindingForm, setBindingForm] = useState<BindingForm>(allowDemo && demo.keys[0] ? { ...defaultBinding, policyId: demo.keys[0].policyId } : defaultBinding);
  const [upstreamGrantForm, setUpstreamGrantForm] = useState<UpstreamGrantForm>(allowDemo && demo.upstreamGrants[0] ? upstreamGrantFormFromGrant(demo.upstreamGrants[0]) : defaultUpstreamGrant);
  const [assignmentRuleForm, setAssignmentRuleForm] = useState<AssignmentRuleForm>(allowDemo && demo.assignmentRules[0] ? assignmentRuleFormFromRule(demo.assignmentRules[0]) : defaultAssignmentRule);
  const [accessTab, setAccessTab] = useState<AccessTab>(initialAccessTab);
  const [accessForm, setAccessForm] = useState(allowDemo && demo.users[0] ? accessFormFromUser(demo.users[0], demo.bindings) : defaultAccess);
  const [selectedPolicyId, setSelectedPolicyId] = useState(allowDemo ? demo.keys[0]?.policyId ?? "" : "");
  const [selectedCredentialId, setSelectedCredentialId] = useState(allowDemo ? demo.credentials[0]?.credentialId ?? "" : "");
  const [selectedBindingKey, setSelectedBindingKey] = useState(allowDemo ? bindingKey(demo.bindings[0]) : "");
  const [selectedUpstreamGrantKey, setSelectedUpstreamGrantKey] = useState(allowDemo ? demo.upstreamGrants[0]?.key ?? "" : "");
  const [selectedAssignmentRuleId, setSelectedAssignmentRuleId] = useState(allowDemo ? demo.assignmentRules[0]?.ruleId ?? "" : "");
  const [selectedUserEmail, setSelectedUserEmail] = useState(demo.users[0]?.email ?? "");
  const [issuedKey, setIssuedKey] = useState("");
  const [policyError, setPolicyError] = useState("");
  const [userError, setUserError] = useState("");
  const selectedPolicy = keys.find((key) => key.policyId === selectedPolicyId);
  const selectedCredential = credentials.find((credential) => credential.credentialId === selectedCredentialId);
  const selectedBinding = bindings.find((binding) => bindingKey(binding) === selectedBindingKey);
  const selectedUpstreamGrant = upstreamGrants.find((grant) => grant.key === selectedUpstreamGrantKey);
  const selectedAssignmentRule = assignmentRules.find((rule) => rule.ruleId === selectedAssignmentRuleId);
  const selectedUser = selectedUserEmail ? users.find((user) => user.email === selectedUserEmail) : undefined;

  function hydrateAdmin(records: AdminRecords, background: boolean, sessionData: SessionResponse, providerRows: ProviderRow[]) {
    setKeys(records.policies);
    setCredentials(records.credentials);
    setConnections(records.connections);
    setUpstreamGrants(records.grants);
    setAssignmentRules(records.rules);
    setUsers(records.users);
    setBindings(records.bindings);
    setLoaded(true);
    if (background) return;
    const refreshedPolicy = records.policies.find((policy) => policy.policyId === selectedPolicyId) ?? records.policies[0];
    setSelectedPolicyId(refreshedPolicy?.policyId ?? "");
    setPolicyForm(refreshedPolicy ? policyFormFromPolicy(refreshedPolicy) : { ...defaultPolicy, policyId: "", tenantId: sessionData.tenantId ?? "default", providers: [...defaultPolicy.providers] });
    const refreshedCredential = records.credentials.find((credential) => credential.credentialId === selectedCredentialId) ?? records.credentials[0];
    setSelectedCredentialId(refreshedCredential?.credentialId ?? "");
    setCredentialForm({ credentialId: "", policyId: refreshedPolicy?.policyId ?? records.policies[0]?.policyId ?? "", principalId: "" });
    const refreshedBinding = records.bindings.find((binding) => bindingKey(binding) === selectedBindingKey) ?? records.bindings[0];
    setSelectedBindingKey(refreshedBinding ? bindingKey(refreshedBinding) : "");
    setBindingForm(refreshedBinding ? bindingFormFromBinding(refreshedBinding) : { ...defaultBinding, policyId: refreshedPolicy?.policyId ?? "" });
    const refreshedGrant = records.grants.find((grant) => grant.key === selectedUpstreamGrantKey) ?? records.grants[0];
    setSelectedUpstreamGrantKey(refreshedGrant?.key ?? "");
    setUpstreamGrantForm(refreshedGrant ? upstreamGrantFormFromGrant(refreshedGrant) : { ...defaultUpstreamGrant, scopeId: refreshedPolicy?.policyId ?? "", provider: providerRows[0]?.id ?? "", tokenRef: providerRows[0]?.id ?? "" });
    const refreshedRule = records.rules.find((rule) => rule.ruleId === selectedAssignmentRuleId) ?? records.rules[0];
    setSelectedAssignmentRuleId(refreshedRule?.ruleId ?? "");
    setAssignmentRuleForm(refreshedRule ? assignmentRuleFormFromRule(refreshedRule) : defaultAssignmentRule);
    const refreshedUser = records.users.find((user) => user.email === selectedUserEmail) ?? records.users[0];
    setSelectedUserEmail(refreshedUser?.email ?? "");
    setAccessForm(refreshedUser ? accessFormFromUser(refreshedUser, records.bindings) : defaultAccess);
  }

  function hydrateUser(user: AccessUser) {
    setKeys([]);
    setCredentials([]);
    setConnections([]);
    setUpstreamGrants([]);
    setAssignmentRules([]);
    setLoaded(false);
    setUsers([user]);
    setBindings([]);
    setSelectedUserEmail(user.email);
    setAccessForm(accessFormFromUser(user, []));
  }

  function hydrateDemo() {
    hydrateAdmin({ policies: demo.keys, credentials: demo.credentials, connections: demo.connections, users: demo.users, bindings: demo.bindings, grants: demo.upstreamGrants, rules: demo.assignmentRules }, false, demo.session, demo.providers);
  }

  async function savePolicy(event: FormEvent) {
    event.preventDefault();
    try {
      setPolicyError("");
      setStatus("saving policy");
      const policyProviders = knownPolicyProviders(policyForm.providers, providers.map((provider) => provider.id));
      if (!policyForm.allProviders && !policyProviders.length) throw new Error("select at least one service");
      if (!/^[A-Za-z0-9_]{4,}$/.test(policyForm.policyId)) throw new Error("policy id must use 4 or more letters, numbers, or underscores");
      const existingPolicy = keys.some((key) => key.policyId === policyForm.policyId);
      if (existingPolicy && selectedPolicyId !== policyForm.policyId) throw new Error("policy id already exists; select it from the policy list to edit it");
      const next: AccessPolicy = {
        policyId: policyForm.policyId,
        enabled: policyForm.enabled,
        providers: policyForm.allProviders ? [] : policyProviders,
        tenantId: policyForm.tenantId || "default",
        tokenRole: policyForm.tokenRole || null,
        monthlyBudgetMicros: optionalCurrencyMicros(policyForm.monthlyBudgetMicros) ?? null,
        requestCostMicros: optionalNumber(policyForm.requestCostMicros) ?? null,
        retainRequestContent: policyForm.retainRequestContent,
      };
      if (demoMode) {
        applyDemoKeys((current) => [next, ...current.filter((key) => key.policyId !== next.policyId)]);
        setSelectedPolicyId(next.policyId);
        setStatus("saved policy");
        return;
      }
      await request<AccessPolicy>(gatewayOrigin, `/v1/admin/policies/${encodeURIComponent(policyForm.policyId)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...next, allProviders: policyForm.allProviders }),
      });
      await refresh();
      setSelectedPolicyId(next.policyId);
      setPolicyForm(policyFormFromPolicy(next));
      setStatus("saved policy");
    } catch (caught) {
      handlePolicyError(caught);
    }
  }

  async function issueCredential(event: FormEvent) {
    event.preventDefault();
    try {
      setPolicyError("");
      const policyId = credentialForm.policyId || selectedPolicyId;
      if (!keys.some((policy) => policy.policyId === policyId)) throw new Error("select a policy for this credential");
      const credentialId = credentialForm.credentialId.trim() || `${policyId}_${Date.now().toString(36)}`;
      if (!/^[A-Za-z0-9_]{4,}$/.test(credentialId)) throw new Error("credential id must use 4 or more letters, numbers, or underscores");
      if (credentials.some((credential) => credential.credentialId === credentialId)) throw new Error("credential id already exists");
      setStatus("issuing credential");
      const secret = generateSecret();
      const revealedKey = `clawrouter-live-${credentialId}-${secret}`;
      const principalId = credentialForm.principalId.trim().toLowerCase() || null;
      if (principalId && !principalId.includes("@")) throw new Error("owner must be a valid user email");
      const next: ProxyCredential = { credentialId, policyId, enabled: true, principalId };
      if (demoMode) {
        applyDemoCredentials((current) => [next, ...current]);
      } else {
        await request<ProxyCredential>(gatewayOrigin, `/v1/admin/credentials/${encodeURIComponent(credentialId)}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled: true, policyId, principalId, secretSha256: await sha256Hex(secret) }),
        });
        setIssuedKey(revealedKey);
        try {
          await refresh();
        } catch (caught) {
          const message = errorMessage(caught);
          setSelectedCredentialId(credentialId);
          setCredentialForm({ credentialId: "", policyId, principalId: credentialForm.principalId });
          setPolicyError(`credential issued, but refresh failed: ${message}`);
          setStatus("issued credential; refresh failed");
          return;
        }
      }
      setSelectedCredentialId(credentialId);
      setCredentialForm({ credentialId: "", policyId, principalId: credentialForm.principalId });
      setIssuedKey(revealedKey);
      setStatus("issued credential");
    } catch (caught) {
      handlePolicyError(caught);
    }
  }

  async function revokeCredential(credentialId: string) {
    try {
      setStatus(`revoking ${credentialId}`);
      if (demoMode) applyDemoCredentials((current) => current.map((credential) => credential.credentialId === credentialId ? { ...credential, enabled: false } : credential));
      else {
        await request<ProxyCredential>(gatewayOrigin, `/v1/admin/credentials/${encodeURIComponent(credentialId)}/revoke`, { method: "POST" });
        await refresh();
      }
      setIssuedKey("");
      setStatus(`revoked ${credentialId}`);
    } catch (caught) {
      handlePolicyError(caught);
    }
  }

  async function saveBinding(event: FormEvent) {
    event.preventDefault();
    try {
      setPolicyError("");
      const principalId = bindingForm.principalId.trim().toLowerCase();
      if (!principalId) throw new Error("principal is required");
      if (!bindingForm.policyId) throw new Error("select a policy");
      const next: PolicyBinding = { policyId: bindingForm.policyId, principalType: bindingForm.principalType, principalId, enabled: bindingForm.enabled, priority: optionalNumber(bindingForm.priority) ?? 100 };
      setStatus("saving binding");
      if (demoMode) setBindings((current) => [next, ...current.filter((binding) => bindingKey(binding) !== bindingKey(next))]);
      else {
        await request<PolicyBinding>(gatewayOrigin, "/v1/admin/policy-bindings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(next) });
        await refresh();
      }
      setSelectedBindingKey(bindingKey(next));
      setBindingForm(bindingFormFromBinding(next));
      setStatus("saved binding");
    } catch (caught) {
      handlePolicyError(caught);
    }
  }

  async function saveUpstreamGrant(event: FormEvent) {
    event.preventDefault();
    try {
      setPolicyError("");
      const scopeId = upstreamGrantForm.scopeId.trim();
      const tokenRef = upstreamGrantForm.tokenRef.trim();
      const provider = upstreamGrantForm.provider.trim();
      if (!scopeId || !tokenRef || !provider) throw new Error("scope, token reference, and provider are required");
      const credentialBundle = parseCredentialBundle(upstreamGrantForm.credentialBundle);
      const primarySecret = upstreamGrantForm.kind === "api_key" ? upstreamGrantForm.credential.trim() || Object.keys(credentialBundle).length : upstreamGrantForm.accessToken.trim();
      if (!selectedUpstreamGrant && !primarySecret) throw new Error("a new upstream grant requires its primary secret");
      const body = {
        version: 1,
        enabled: upstreamGrantForm.enabled,
        kind: upstreamGrantForm.kind,
        provider,
        label: upstreamGrantForm.label.trim() || undefined,
        tokenType: selectedUpstreamGrant?.tokenType ?? "Bearer",
        expiresAt: upstreamGrantForm.expiresAt.trim() || undefined,
        scopes: selectedUpstreamGrant?.scopes ?? [],
        accountId: upstreamGrantForm.accountId.trim() || undefined,
        subscription: selectedUpstreamGrant?.subscription ?? undefined,
        ...(upstreamGrantForm.credential.trim() ? { credential: upstreamGrantForm.credential.trim() } : {}),
        ...(Object.keys(credentialBundle).length ? { credentials: credentialBundle } : {}),
        ...(upstreamGrantForm.accessToken.trim() ? { accessToken: upstreamGrantForm.accessToken.trim() } : {}),
        ...(upstreamGrantForm.refreshToken.trim() ? { refreshToken: upstreamGrantForm.refreshToken.trim() } : {}),
      };
      const path = `/v1/admin/upstream-grants/${upstreamGrantForm.scope}/${encodeURIComponent(scopeId)}/${encodeURIComponent(tokenRef)}`;
      setStatus("saving upstream grant");
      let saved: UpstreamGrant;
      if (demoMode) {
        saved = demoGrantFromForm(upstreamGrantForm, selectedUpstreamGrant);
        setUpstreamGrants((current) => [saved, ...current.filter((grant) => grant.key !== saved.key)]);
      } else {
        saved = await request<UpstreamGrant>(gatewayOrigin, path, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        await refresh();
      }
      setSelectedUpstreamGrantKey(saved.key);
      setUpstreamGrantForm(upstreamGrantFormFromGrant(saved));
      setStatus("saved upstream grant");
    } catch (caught) {
      handlePolicyError(caught);
    }
  }

  async function revokeUpstreamGrant(grant: UpstreamGrant) {
    try {
      setPolicyError("");
      setStatus("revoking upstream grant");
      let revoked: UpstreamGrant;
      if (demoMode) {
        revoked = { ...grant, enabled: false, usable: false, hasCredential: false, credentialFields: [], hasAccessToken: false, hasRefreshToken: false, revokedAt: new Date().toISOString() };
        setUpstreamGrants((current) => current.map((item) => item.key === grant.key ? revoked : item));
      } else {
        revoked = await request<UpstreamGrant>(gatewayOrigin, `/v1/admin/upstream-grants/${grant.scope}/${encodeURIComponent(grant.scopeId)}/${encodeURIComponent(grant.tokenRef)}/revoke`, { method: "POST" });
        await refresh();
      }
      setSelectedUpstreamGrantKey(revoked.key);
      setUpstreamGrantForm(upstreamGrantFormFromGrant(revoked));
      setStatus("revoked upstream grant");
    } catch (caught) {
      handlePolicyError(caught);
    }
  }

  async function refreshUpstreamGrant(grant: UpstreamGrant) {
    try {
      setPolicyError("");
      setStatus("refreshing upstream grant");
      if (!demoMode) {
        const refreshed = await request<UpstreamGrant>(gatewayOrigin, `/v1/admin/upstream-grants/${grant.scope}/${encodeURIComponent(grant.scopeId)}/${encodeURIComponent(grant.tokenRef)}/refresh`, { method: "POST" });
        await refresh();
        setSelectedUpstreamGrantKey(refreshed.key);
        setUpstreamGrantForm(upstreamGrantFormFromGrant(refreshed));
      }
      setStatus("refreshed upstream grant");
    } catch (caught) {
      handlePolicyError(caught);
    }
  }

  async function authorizeUpstreamGrant() {
    try {
      setPolicyError("");
      const scopeId = upstreamGrantForm.scopeId.trim();
      const tokenRef = upstreamGrantForm.tokenRef.trim();
      const provider = upstreamGrantForm.provider.trim();
      if (!scopeId || !tokenRef || !provider) throw new Error("scope, token reference, and provider are required");
      if (!providers.find((item) => item.id === provider)?.auth?.authorization) throw new Error("selected provider does not support browser OAuth");
      setStatus("connecting upstream grant");
      if (demoMode) {
        setStatus("browser OAuth unavailable in local demo");
        return;
      }
      const result = await request<{ authorizationUrl: string }>(gatewayOrigin, `/v1/admin/upstream-grants/${upstreamGrantForm.scope}/${encodeURIComponent(scopeId)}/${encodeURIComponent(tokenRef)}/authorize`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider }),
      });
      window.location.assign(result.authorizationUrl);
    } catch (caught) {
      handlePolicyError(caught);
    }
  }

  async function saveAssignmentRule(event: FormEvent) {
    event.preventDefault();
    try {
      setPolicyError("");
      const ruleId = assignmentRuleForm.ruleId.trim();
      if (!/^[a-z0-9_]{4,48}$/.test(ruleId)) throw new Error("rule id must use 4-48 lowercase letters, numbers, or underscores");
      if (!assignmentRuleForm.subject.trim()) throw new Error("rule subject is required");
      const body = {
        version: 1,
        enabled: assignmentRuleForm.enabled,
        kind: assignmentRuleForm.kind,
        subject: assignmentRuleForm.subject.trim(),
        groups: parseGroups(assignmentRuleForm.groups),
        policyIds: assignmentRuleForm.policyIds,
        priority: optionalNumber(assignmentRuleForm.priority) ?? 100,
        revokeOnLoss: assignmentRuleForm.revokeOnLoss,
        provenance: assignmentRuleForm.provenance.trim(),
      };
      setStatus("saving assignment rule");
      let saved: AssignmentRule;
      if (demoMode) {
        saved = demoRuleFromForm(assignmentRuleForm);
        setAssignmentRules((current) => [saved, ...current.filter((rule) => rule.ruleId !== saved.ruleId)]);
      } else {
        saved = await request<AssignmentRule>(gatewayOrigin, `/v1/admin/assignment-rules/${encodeURIComponent(ruleId)}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        await refresh();
      }
      setSelectedAssignmentRuleId(saved.ruleId);
      setAssignmentRuleForm(assignmentRuleFormFromRule(saved));
      setStatus("saved assignment rule");
    } catch (caught) {
      handlePolicyError(caught);
    }
  }

  async function reconcileAssignments() {
    try {
      setPolicyError("");
      setStatus("reconciling assignments");
      if (!demoMode) {
        await request<{ results: unknown[] }>(gatewayOrigin, "/v1/admin/assignment-rules/reconcile", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ all: true }) });
        await refresh();
      }
      setStatus("reconciled assignments");
    } catch (caught) {
      handlePolicyError(caught);
    }
  }

  async function setProviderConnection(providerId: string, enabled: boolean) {
    try {
      setStatus(`${enabled ? "enabling" : "disabling"} ${providerId}`);
      const current = connections.find((connection) => connection.providerId === providerId);
      const next: ProviderConnection = { providerId, enabled, label: current?.label ?? null };
      if (demoMode) {
        setConnections((items) => [next, ...items.filter((item) => item.providerId !== providerId)]);
        setProviderReadiness((items) => {
          const readiness = items[providerId];
          return readiness ? { ...items, [providerId]: { ...readiness, connectionEnabled: enabled, executable: enabled && readiness.configPresent && (!readiness.oauthGrantRequired || readiness.oauthGrantCount > 0), status: enabled ? (readiness.verified ? "verified" : "unverified") : "disabled" } } : items;
        });
      } else {
        await request<ProviderConnection>(gatewayOrigin, `/v1/admin/connections/${encodeURIComponent(providerId)}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(next) });
        await refresh();
      }
      setStatus(`${enabled ? "enabled" : "disabled"} ${providerId}`);
    } catch (caught) {
      setStatus(errorMessage(caught));
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
      const nextBindings = reconcileDirectUserBindings(bindings, email, keys, accessForm.policyIds);
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

  async function revokePolicy(policyId: string) {
    try {
      setStatus(`revoking ${policyId}`);
      if (demoMode) {
        applyDemoKeys((current) => current.map((key) => key.policyId === policyId ? { ...key, enabled: false } : key));
        setStatus(`revoked ${policyId}`);
        return;
      }
      await request<AccessPolicy>(gatewayOrigin, `/v1/admin/policies/${encodeURIComponent(policyId)}/revoke`, { method: "POST" });
      await refresh();
      setStatus(`revoked ${policyId}`);
    } catch (caught) {
      handlePolicyError(caught);
    }
  }

  function editPolicy(key: AccessPolicy) {
    setIssuedKey("");
    setSelectedPolicyId(key.policyId);
    setPolicyForm(policyFormFromPolicy(key));
    setCredentialForm((current) => ({ ...current, policyId: key.policyId }));
    setBindingForm((current) => ({ ...current, policyId: key.policyId }));
  }

  function startNewPolicy() {
    setIssuedKey("");
    setPolicyError("");
    setSelectedPolicyId("");
    setPolicyForm({ ...defaultPolicy, policyId: "", tenantId: session.tenantId ?? "default", providers: [...defaultPolicy.providers] });
  }

  function startNewUser() {
    setSelectedUserEmail("");
    setUserError("");
    setAccessForm({ ...defaultAccess, email: "", tenantId: session.tenantId ?? "default" });
  }

  function editBinding(binding: PolicyBinding) {
    setSelectedBindingKey(bindingKey(binding));
    setBindingForm(bindingFormFromBinding(binding));
  }

  function startNewBinding() {
    setSelectedBindingKey("");
    setBindingForm({ ...defaultBinding, policyId: selectedPolicyId || keys[0]?.policyId || "" });
  }

  function editUpstreamGrant(grant: UpstreamGrant) {
    setSelectedUpstreamGrantKey(grant.key);
    setUpstreamGrantForm(upstreamGrantFormFromGrant(grant));
  }

  function startNewUpstreamGrant() {
    const provider = providers[0]?.id ?? "";
    setSelectedUpstreamGrantKey("");
    setUpstreamGrantForm({ ...defaultUpstreamGrant, scopeId: selectedPolicyId || keys[0]?.policyId || "default", provider, tokenRef: provider });
  }

  function editAssignmentRule(rule: AssignmentRule) {
    setSelectedAssignmentRuleId(rule.ruleId);
    setAssignmentRuleForm(assignmentRuleFormFromRule(rule));
  }

  function startNewAssignmentRule() {
    setSelectedAssignmentRuleId("");
    setAssignmentRuleForm({ ...defaultAssignmentRule, policyIds: [] });
  }

  function applyPreset(role: keyof typeof rolePresets) {
    const preset = rolePresets[role];
    const available = new Set(providers.map((provider) => provider.id));
    setPolicyForm((current) => ({
      ...current,
      tokenRole: role,
      monthlyBudgetMicros: currencyInput(optionalNumber(preset.budget)),
      requestCostMicros: preset.request,
      providers: preset.providers.length ? preset.providers.filter((id) => available.has(id)) : providers.map((provider) => provider.id),
      allProviders: false,
    }));
  }

  function togglePolicyProvider(providerId: string) {
    const allProviderIds = providers.map((provider) => provider.id);
    setPolicyForm((current) => ({
      ...current,
      allProviders: false,
      providers: (current.allProviders ? allProviderIds : current.providers).includes(providerId)
        ? (current.allProviders ? allProviderIds : current.providers).filter((id) => id !== providerId)
        : [...current.providers, providerId].sort(),
    }));
  }

  function setPolicyProviderGroup(providerIds: string[], checked: boolean) {
    const allProviderIds = providers.map((provider) => provider.id);
    setPolicyForm((current) => {
      if (current.allProviders && checked) return current;
      const selected = current.allProviders ? allProviderIds : current.providers;
      return { ...current, allProviders: false, providers: checked ? unique([...selected, ...providerIds]).sort() : selected.filter((id) => !providerIds.includes(id)) };
    });
  }

  function applyDemoKeys(updater: (current: AccessPolicy[]) => AccessPolicy[]) {
    const next = updater(keys);
    setKeys(next);
    syncDemoAdmin(next, credentials, providers, routes, true);
  }

  function applyDemoCredentials(updater: (current: ProxyCredential[]) => ProxyCredential[]) {
    const next = updater(credentials);
    setCredentials(next);
    syncDemoAdmin(keys, next, providers, routes);
  }

  function handlePolicyError(caught: unknown) {
    const message = errorMessage(caught);
    setPolicyError(message);
    setStatus(message);
  }

  return {
    loaded,
    setLoaded,
    tab: { value: accessTab, set: setAccessTab },
    policies: { items: keys, setItems: setKeys, selected: selectedPolicy, selectedId: selectedPolicyId, setSelectedId: setSelectedPolicyId, form: policyForm, setForm: setPolicyForm, error: policyError, setError: setPolicyError, save: savePolicy, revoke: revokePolicy, edit: editPolicy, startNew: startNewPolicy, applyPreset, toggleProvider: togglePolicyProvider, setProviderGroup: setPolicyProviderGroup },
    credentials: { items: credentials, setItems: setCredentials, selected: selectedCredential, selectedId: selectedCredentialId, setSelectedId: setSelectedCredentialId, form: credentialForm, setForm: setCredentialForm, issuedKey, setIssuedKey, issue: issueCredential, revoke: revokeCredential },
    connections: { items: connections, setItems: setConnections, setEnabled: setProviderConnection },
    bindings: { items: bindings, setItems: setBindings, selected: selectedBinding, selectedKey: selectedBindingKey, setSelectedKey: setSelectedBindingKey, form: bindingForm, setForm: setBindingForm, save: saveBinding, edit: editBinding, startNew: startNewBinding },
    upstream: { items: upstreamGrants, setItems: setUpstreamGrants, selected: selectedUpstreamGrant, selectedKey: selectedUpstreamGrantKey, setSelectedKey: setSelectedUpstreamGrantKey, form: upstreamGrantForm, setForm: setUpstreamGrantForm, save: saveUpstreamGrant, revoke: revokeUpstreamGrant, refresh: refreshUpstreamGrant, authorize: authorizeUpstreamGrant, edit: editUpstreamGrant, startNew: startNewUpstreamGrant },
    assignments: { items: assignmentRules, setItems: setAssignmentRules, selected: selectedAssignmentRule, selectedId: selectedAssignmentRuleId, setSelectedId: setSelectedAssignmentRuleId, form: assignmentRuleForm, setForm: setAssignmentRuleForm, save: saveAssignmentRule, reconcile: reconcileAssignments, edit: editAssignmentRule, startNew: startNewAssignmentRule },
    users: { items: users, setItems: setUsers, selected: selectedUser, selectedEmail: selectedUserEmail, setSelectedEmail: setSelectedUserEmail, form: accessForm, setForm: setAccessForm, error: userError, setError: setUserError, save: saveUser, startNew: startNewUser },
    hydrateAdmin,
    hydrateUser,
    hydrateDemo,
  };
}
