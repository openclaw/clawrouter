import { type FormEvent, useState } from "react";
import { currencyInput, errorMessage, knownPolicyProviders, optionalCurrencyMicros, optionalNumber, parseEligibleGrants, unique } from "../../domain";
import { defaultCredential, defaultPolicy, demo, rolePresets } from "../../ui-config";
import { generateSecret, policyFormFromPolicy, request, sha256Hex } from "../../ui-helpers";
import type { AccessPolicy, CredentialForm, PolicyForm, ProviderRow, ProxyCredential, RouteCatalog, SessionResponse } from "../../ui-types";

interface Dependencies {
  allowDemo: boolean;
  gatewayOrigin: string;
  session: SessionResponse;
  demoMode: boolean;
  providers: ProviderRow[];
  routes: RouteCatalog;
  setStatus: (status: string) => void;
  refresh: () => Promise<void>;
  syncDemoAdmin: (policies: AccessPolicy[], credentials: ProxyCredential[], providers: ProviderRow[], routes: RouteCatalog, syncRows?: boolean) => void;
}

export function usePolicyAdmin({ allowDemo, gatewayOrigin, session, demoMode, providers, routes, setStatus, refresh, syncDemoAdmin }: Dependencies) {
  const [keys, setKeys] = useState<AccessPolicy[]>(allowDemo ? demo.keys : []);
  const [credentials, setCredentials] = useState<ProxyCredential[]>(allowDemo ? demo.credentials : []);
  const [policyForm, setPolicyForm] = useState<PolicyForm>(allowDemo && demo.keys[0] ? policyFormFromPolicy(demo.keys[0]) : defaultPolicy);
  const [credentialForm, setCredentialForm] = useState<CredentialForm>(allowDemo && demo.keys[0] ? { credentialId: "", policyId: demo.keys[0].policyId, principalId: "" } : defaultCredential);
  const [selectedPolicyId, setSelectedPolicyId] = useState(allowDemo ? demo.keys[0]?.policyId ?? "" : "");
  const [selectedCredentialId, setSelectedCredentialId] = useState(allowDemo ? demo.credentials[0]?.credentialId ?? "" : "");
  const [issuedKey, setIssuedKey] = useState("");
  const [error, setError] = useState("");
  const selectedPolicy = keys.find((key) => key.policyId === selectedPolicyId);
  const selectedCredential = credentials.find((credential) => credential.credentialId === selectedCredentialId);

  function hydrate(policies: AccessPolicy[], nextCredentials: ProxyCredential[], background: boolean, sessionData: SessionResponse) {
    setKeys(policies);
    setCredentials(nextCredentials);
    if (background) return;
    const refreshedPolicy = policies.find((policy) => policy.policyId === selectedPolicyId) ?? policies[0];
    setSelectedPolicyId(refreshedPolicy?.policyId ?? "");
    setPolicyForm(refreshedPolicy ? policyFormFromPolicy(refreshedPolicy) : newPolicyForm(sessionData));
    const refreshedCredential = nextCredentials.find((credential) => credential.credentialId === selectedCredentialId) ?? nextCredentials[0];
    setSelectedCredentialId(refreshedCredential?.credentialId ?? "");
    setCredentialForm({ credentialId: "", policyId: refreshedPolicy?.policyId ?? policies[0]?.policyId ?? "", principalId: "" });
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    try {
      setError("");
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
        grantRouting: {
          strategy: policyForm.grantStrategy,
          stickiness: policyForm.grantStickiness,
          failover: policyForm.grantFailover,
          staleState: policyForm.grantStaleState,
          staleAfterSeconds: optionalNumber(policyForm.grantStaleAfterSeconds) ?? 300,
          eligibleGrants: parseEligibleGrants(policyForm.eligibleGrants),
        },
      };
      if (demoMode) {
        applyDemoKeys((current) => [next, ...current.filter((key) => key.policyId !== next.policyId)]);
        setSelectedPolicyId(next.policyId);
        setStatus("saved policy");
        return;
      }
      await request<AccessPolicy>(gatewayOrigin, `/v1/admin/policies/${encodeURIComponent(policyForm.policyId)}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...next, allProviders: policyForm.allProviders }) });
      await refresh();
      setSelectedPolicyId(next.policyId);
      setPolicyForm(policyFormFromPolicy(next));
      setStatus("saved policy");
    } catch (caught) { handleError(caught); }
  }

  async function issueCredential(event: FormEvent) {
    event.preventDefault();
    try {
      setError("");
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
      if (demoMode) applyDemoCredentials((current) => [next, ...current]);
      else {
        await request<ProxyCredential>(gatewayOrigin, `/v1/admin/credentials/${encodeURIComponent(credentialId)}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: true, policyId, principalId, secretSha256: await sha256Hex(secret) }) });
        setIssuedKey(revealedKey);
        try { await refresh(); }
        catch (caught) {
          const message = errorMessage(caught);
          setSelectedCredentialId(credentialId);
          setCredentialForm({ credentialId: "", policyId, principalId: credentialForm.principalId });
          setError(`credential issued, but refresh failed: ${message}`);
          setStatus("issued credential; refresh failed");
          return;
        }
      }
      setSelectedCredentialId(credentialId);
      setCredentialForm({ credentialId: "", policyId, principalId: credentialForm.principalId });
      setIssuedKey(revealedKey);
      setStatus("issued credential");
    } catch (caught) { handleError(caught); }
  }

  async function revokeCredential(credentialId: string) {
    try {
      setStatus(`revoking ${credentialId}`);
      if (demoMode) applyDemoCredentials((current) => current.map((credential) => credential.credentialId === credentialId ? { ...credential, enabled: false } : credential));
      else { await request<ProxyCredential>(gatewayOrigin, `/v1/admin/credentials/${encodeURIComponent(credentialId)}/revoke`, { method: "POST" }); await refresh(); }
      setIssuedKey("");
      setStatus(`revoked ${credentialId}`);
    } catch (caught) { handleError(caught); }
  }

  async function revokePolicy(policyId: string) {
    try {
      setStatus(`revoking ${policyId}`);
      if (demoMode) { applyDemoKeys((current) => current.map((key) => key.policyId === policyId ? { ...key, enabled: false } : key)); setStatus(`revoked ${policyId}`); return; }
      await request<AccessPolicy>(gatewayOrigin, `/v1/admin/policies/${encodeURIComponent(policyId)}/revoke`, { method: "POST" });
      await refresh();
      setStatus(`revoked ${policyId}`);
    } catch (caught) { handleError(caught); }
  }

  function edit(key: AccessPolicy) {
    setIssuedKey("");
    setSelectedPolicyId(key.policyId);
    setPolicyForm(policyFormFromPolicy(key));
    setCredentialForm((current) => ({ ...current, policyId: key.policyId }));
  }

  function startNew() {
    setIssuedKey("");
    setError("");
    setSelectedPolicyId("");
    setPolicyForm(newPolicyForm(session));
  }

  function applyPreset(role: keyof typeof rolePresets) {
    const preset = rolePresets[role], available = new Set(providers.map((provider) => provider.id));
    setPolicyForm((current) => ({ ...current, tokenRole: role, monthlyBudgetMicros: currencyInput(optionalNumber(preset.budget)), requestCostMicros: preset.request, providers: preset.providers.length ? preset.providers.filter((id) => available.has(id)) : providers.map((provider) => provider.id), allProviders: false }));
  }

  function toggleProvider(providerId: string) {
    const allProviderIds = providers.map((provider) => provider.id);
    setPolicyForm((current) => ({ ...current, allProviders: false, providers: (current.allProviders ? allProviderIds : current.providers).includes(providerId) ? (current.allProviders ? allProviderIds : current.providers).filter((id) => id !== providerId) : [...current.providers, providerId].sort() }));
  }

  function setProviderGroup(providerIds: string[], checked: boolean) {
    const allProviderIds = providers.map((provider) => provider.id);
    setPolicyForm((current) => {
      if (current.allProviders && checked) return current;
      const selected = current.allProviders ? allProviderIds : current.providers;
      return { ...current, allProviders: false, providers: checked ? unique([...selected, ...providerIds]).sort() : selected.filter((id) => !providerIds.includes(id)) };
    });
  }

  function applyDemoKeys(updater: (current: AccessPolicy[]) => AccessPolicy[]) { const next = updater(keys); setKeys(next); syncDemoAdmin(next, credentials, providers, routes, true); }
  function applyDemoCredentials(updater: (current: ProxyCredential[]) => ProxyCredential[]) { const next = updater(credentials); setCredentials(next); syncDemoAdmin(keys, next, providers, routes); }
  function handleError(caught: unknown) { const message = errorMessage(caught); setError(message); setStatus(message); }

  return {
    policies: { items: keys, setItems: setKeys, selected: selectedPolicy, selectedId: selectedPolicyId, setSelectedId: setSelectedPolicyId, form: policyForm, setForm: setPolicyForm, error, setError, save, revoke: revokePolicy, edit, startNew, applyPreset, toggleProvider, setProviderGroup },
    credentials: { items: credentials, setItems: setCredentials, selected: selectedCredential, selectedId: selectedCredentialId, setSelectedId: setSelectedCredentialId, form: credentialForm, setForm: setCredentialForm, issuedKey, setIssuedKey, issue: issueCredential, revoke: revokeCredential },
    hydrate,
  };
}

function newPolicyForm(session: SessionResponse): PolicyForm {
  return {
    ...defaultPolicy,
    policyId: "",
    tenantId: session.tenantId ?? "default",
    providers: [...defaultPolicy.providers],
    retainRequestContent:
      session.contentRetention?.defaultEnabled ?? defaultPolicy.retainRequestContent,
  };
}
