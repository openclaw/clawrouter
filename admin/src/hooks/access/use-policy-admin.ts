import { type FormEvent, type SetStateAction, useRef, useState } from "react";
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

interface PolicyDraft { selection: string; value: PolicyForm; dirty: boolean; initialized: boolean }

export function usePolicyAdmin({ request, allowDemo, gatewayOrigin, session, demoMode, providers, credentials, routes, setStatus, refresh, syncDemoAdmin }: Dependencies) {
  const [keys, setKeys] = useState<AccessPolicy[]>(allowDemo ? demo.keys : []);
  const rows = useRef(keys);
  const [ready, setReady] = useState(allowDemo);
  const readyRef = useRef(ready);
  const [draft, setDraft] = useState<PolicyDraft>(() => ({ selection: keys[0]?.policyId ?? "", value: keys[0] ? policyFormFromPolicy(keys[0]) : newPolicyForm(session), dirty: false, initialized: allowDemo }));
  const currentDraft = useRef(draft);
  const baseline = useRef(draft.value);
  const revision = useRef(0);
  const incarnation = useRef(0);
  const enabledEditRevision = useRef(0);
  const recordsEpoch = useRef(0);
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const selectedPolicy = keys.find((key) => key.policyId === draft.selection);
  const missing = Boolean(draft.selection && !selectedPolicy);

  function captureHydration() { return pending.current ? null : recordsEpoch.current; }

  function hydrate(policies: AccessPolicy[], sessionData: SessionResponse, snapshot: number | null) {
    // A bootstrap admitted before or during a write cannot replace its committed row.
    if (snapshot === null || snapshot !== recordsEpoch.current || pending.current) return;
    updateRows(policies);
    readyRef.current = true;
    setReady(true);
    const current = currentDraft.current;
    if (current.initialized && !current.selection) return;
    const policy = current.initialized ? policies.find((item) => item.policyId === current.selection) : policies[0];
    if (policy) {
      const canonical = policyFormFromPolicy(policy);
      // Preserve edits but compare future changes with the accepted row, not an obsolete baseline.
      if (current.dirty) rebaseDraft(canonical, current);
      else resetDraft(policy.policyId, canonical);
    } else if (!current.initialized) resetDraft("", newPolicyForm(sessionData));
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    await mutate("save", async (policyForm, selection) => {
      if (selection && !rows.current.some((key) => key.policyId === selection)) throw new Error("This policy is no longer available. Select another policy or start a new one.");
      const policyProviders = knownPolicyProviders(policyForm.providers, providers.map((provider) => provider.id));
      if (!policyForm.allProviders && !policyProviders.length) throw new Error("select at least one service");
      if (!/^[A-Za-z0-9_]{4,}$/.test(policyForm.policyId)) throw new Error("policy id must use 4 or more letters, numbers, or underscores");
      const existingPolicy = rows.current.some((key) => key.policyId === policyForm.policyId);
      if (existingPolicy && selection !== policyForm.policyId) throw new Error("policy id already exists; select it from the policy list to edit it");
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
      return demoMode ? next : request<AccessPolicy>(gatewayOrigin, `/v1/admin/policies/${encodeURIComponent(policyForm.policyId)}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...next, allProviders: policyForm.allProviders }) });
    });
  }

  async function revokePolicy(policyId: string) {
    await mutate("disable", async () => {
      const policy = rows.current.find((key) => key.policyId === policyId);
      if (!policy) throw new Error("This policy is no longer available.");
      return demoMode ? { ...policy, enabled: false } : request<AccessPolicy>(gatewayOrigin, `/v1/admin/policies/${encodeURIComponent(policyId)}/revoke`, { method: "POST" });
    });
  }

  async function mutate(action: "save" | "disable", write: (value: PolicyForm, selection: string) => Promise<AccessPolicy>) {
    // An early submit must neither overwrite an unknown ID nor retire its initial bootstrap.
    if (!readyRef.current || pending.current) return;
    const submitted = currentDraft.current, submittedRevision = revision.current, submittedIncarnation = incarnation.current;
    pending.current = true;
    recordsEpoch.current += 1;
    setBusy(true);
    setError("");
    setStatus(action === "save" ? "saving policy" : "revoking policy");
    let committed = false;
    try {
      const saved = await write(submitted.value, submitted.selection);
      updateRows([saved, ...rows.current.filter((key) => key.policyId !== saved.policyId)]);
      const canonical = policyFormFromPolicy(saved), current = currentDraft.current;
      // Clean replacement drafts follow the committed row; Disable still honors later enabled edits.
      const cleanReplacement = current.selection === saved.policyId && incarnation.current !== submittedIncarnation && !current.dirty
        && (action === "save" || enabledEditRevision.current <= submittedRevision);
      if (cleanReplacement || (revision.current === submittedRevision && (action === "save" || !submitted.dirty))) resetDraft(saved.policyId, canonical);
      else if (current.selection === saved.policyId || (action === "save" && !submitted.selection && !current.selection && incarnation.current === submittedIncarnation)) {
        // A committed create owns this New draft's identity, but never a replacement draft.
        // Later edits stay dirty against the committed baseline, including a return to old values.
        const value = action === "disable" && enabledEditRevision.current <= submittedRevision ? { ...current.value, enabled: canonical.enabled } : current.value;
        rebaseDraft(canonical, { ...current, selection: saved.policyId, value });
      }
      if (demoMode) syncDemoAdmin(rows.current, credentials, providers, routes, true);
      committed = true;
      setStatus(action === "save" ? "saved policy" : "disabled policy");
    } catch (caught) {
      const message = errorMessage(caught);
      if (revision.current === submittedRevision) setError(message);
      setStatus(`policy ${action} failed (${submitted.value.policyId || "new policy"}): ${message}`);
    } finally {
      pending.current = false;
      setBusy(false);
    }
    // Read freshness has its own visible failure state; it does not own mutation admission.
    if (committed && !demoMode) void refresh();
  }

  function edit(key: AccessPolicy) {
    if (key.policyId === currentDraft.current.selection || !confirmDiscard()) return;
    resetDraft(key.policyId, policyFormFromPolicy(key));
    setError("");
  }

  function startNew() {
    if (!confirmDiscard()) return;
    setError("");
    resetDraft("", newPolicyForm(session));
  }

  function discard() {
    const selected = rows.current.find((key) => key.policyId === currentDraft.current.selection);
    if (currentDraft.current.selection && !selected) return;
    resetDraft(selected?.policyId ?? "", selected ? policyFormFromPolicy(selected) : newPolicyForm(session));
    setError("");
  }

  function confirmDiscard() { return !currentDraft.current.dirty || window.confirm("Discard unsaved policy changes?"); }

  function updateRows(next: AccessPolicy[]) { rows.current = next; setKeys(next); }

  function resetDraft(selection: string, value: PolicyForm) {
    baseline.current = value;
    incarnation.current += 1;
    enabledEditRevision.current = 0;
    publishDraft({ selection, value, dirty: false, initialized: true });
  }

  function rebaseDraft(canonical: PolicyForm, next: PolicyDraft) {
    baseline.current = canonical;
    publishDraft({ ...next, dirty: JSON.stringify(next.value) !== JSON.stringify(canonical) });
  }

  function publishDraft(next: PolicyDraft) {
    revision.current += 1;
    currentDraft.current = next;
    setDraft(next);
  }

  function setPolicyForm(next: SetStateAction<PolicyForm>) {
    const current = currentDraft.current;
    const value = typeof next === "function" ? next(current.value) : next;
    if (JSON.stringify(value) === JSON.stringify(current.value)) return;
    if (!current.selection && value.policyId !== current.value.policyId) incarnation.current += 1;
    // Disable merges its enabled=false intent unless the operator edited that field later.
    if (value.enabled !== current.value.enabled) enabledEditRevision.current = revision.current + 1;
    publishDraft({ ...current, value, dirty: JSON.stringify(value) !== JSON.stringify(baseline.current), initialized: true });
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

  return {
    policies: { items: keys, selected: selectedPolicy, selectedId: draft.selection, form: draft.value, setForm: setPolicyForm, dirty: draft.dirty, missing, ready, busy, error, save, revoke: revokePolicy, edit, startNew, discard, applyPreset, toggleProvider, setProviderGroup },
    captureHydration,
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
