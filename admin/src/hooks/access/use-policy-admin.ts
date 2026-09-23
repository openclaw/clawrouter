import { type FormEvent, useState } from "react";
import { currencyInput, errorMessage, knownPolicyProviders, optionalCurrencyMicros, optionalNumber, parseEligibleGrants, unique } from "../../domain";
import { defaultPolicy, demo, rolePresets } from "../../ui-config";
import { policyFormFromPolicy } from "../../ui-helpers";
import type { ConsoleRequest } from "../../dashboard-fetch";
import type { AccessPolicy, PolicyForm, ProviderRow, ProxyCredential, RouteCatalog, SessionResponse } from "../../ui-types";

interface Dependencies {
  request: ConsoleRequest;
  allowDemo: boolean;
  gatewayOrigin: string;
  session: SessionResponse;
  demoMode: boolean;
  providers: ProviderRow[];
  credentials: ProxyCredential[];
  routes: RouteCatalog;
  setStatus: (status: string) => void;
  refresh: () => Promise<void>;
  syncDemoAdmin: (policies: AccessPolicy[], credentials: ProxyCredential[], providers: ProviderRow[], routes: RouteCatalog, syncRows?: boolean) => void;
}

export function usePolicyAdmin({ request, allowDemo, gatewayOrigin, session, demoMode, providers, credentials, routes, setStatus, refresh, syncDemoAdmin }: Dependencies) {
  const [keys, setKeys] = useState<AccessPolicy[]>(allowDemo ? demo.keys : []);
  const [policyForm, setPolicyForm] = useState<PolicyForm>(allowDemo && demo.keys[0] ? policyFormFromPolicy(demo.keys[0]) : defaultPolicy);
  const [selectedPolicyId, setSelectedPolicyId] = useState(allowDemo ? demo.keys[0]?.policyId ?? "" : "");
  const [error, setError] = useState("");
  const selectedPolicy = keys.find((key) => key.policyId === selectedPolicyId);

  function hydrate(policies: AccessPolicy[], background: boolean, sessionData: SessionResponse) {
    setKeys(policies);
    if (background) return;
    const refreshedPolicy = policies.find((policy) => policy.policyId === selectedPolicyId) ?? policies[0];
    setSelectedPolicyId(refreshedPolicy?.policyId ?? "");
    setPolicyForm(refreshedPolicy ? policyFormFromPolicy(refreshedPolicy) : newPolicyForm(sessionData));
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
        budgetScope: policyForm.budgetScope,
        retainRequestContent: policyForm.retainRequestContent,
        grantRouting: {
          strategy: policyForm.grantStrategy,
          stickiness: policyForm.grantStickiness,
          failover: policyForm.grantFailover,
          staleState: policyForm.grantStaleState,
          staleAfterSeconds: optionalNumber(policyForm.grantStaleAfterSeconds) ?? 300,
          switchAtUsedPercent: optionalNumber(policyForm.grantSwitchAtUsedPercent) ?? 90,
          hysteresisPercent: optionalNumber(policyForm.grantHysteresisPercent) ?? 10,
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
    setSelectedPolicyId(key.policyId);
    setPolicyForm(policyFormFromPolicy(key));
  }

  function startNew() {
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
  function handleError(caught: unknown) { const message = errorMessage(caught); setError(message); setStatus(message); }

  return {
    policies: { items: keys, setItems: setKeys, selected: selectedPolicy, selectedId: selectedPolicyId, setSelectedId: setSelectedPolicyId, form: policyForm, setForm: setPolicyForm, error, setError, save, revoke: revokePolicy, edit, startNew, applyPreset, toggleProvider, setProviderGroup },
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
