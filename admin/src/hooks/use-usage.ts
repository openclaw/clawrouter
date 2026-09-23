import { useEffect, useRef, useState } from "react";
import { policyUsageFallback, tenantSummaryFallback } from "../domain";
import { demo, emptyUsageSnapshot } from "../ui-config";
import { adminOverviewFromPolicies, request, settled } from "../ui-helpers";
import type { AccessPolicy, AdminOverview, AdminTenantSummary, AdminUsageRow, ProviderRow, ProxyCredential, RouteCatalog, UsageSnapshot } from "../ui-types";

export function useUsage(allowDemo: boolean) {
  const [adminOverview, setAdminOverview] = useState<AdminOverview | null>(allowDemo ? demo.overview : null);
  const [tenantSummaries, setTenantSummaries] = useState<AdminTenantSummary[]>(allowDemo ? demo.tenants : []);
  const [ledger, setLedger] = useState({
    rows: allowDemo ? demo.usageRows : [] as AdminUsageRow[],
    snapshot: allowDemo ? demo.usage : emptyUsageSnapshot,
    loaded: allowDemo,
    stale: false,
    updatedAt: allowDemo ? Date.now() : null as number | null,
    error: "",
    revision: 0, // Empty-to-empty resets must still wake lazy readers.
  });
  const principalRef = useRef("");
  const generationRef = useRef(0);
  const pendingRef = useRef<Promise<boolean> | null>(null);

  useEffect(() => () => { generationRef.current += 1; pendingRef.current = null; }, []);

  function reset() {
    setAdminOverview(null);
    setTenantSummaries([]);
    generationRef.current += 1;
    pendingRef.current = null;
    setLedger({ rows: [], snapshot: emptyUsageSnapshot, loaded: false, stale: false, updatedAt: null, error: "", revision: generationRef.current });
  }

  function setPrincipal(principal: string) {
    if (principalRef.current === principal) return;
    principalRef.current = principal;
    reset();
  }

  function hydrate(rows: AdminUsageRow[], snapshot: UsageSnapshot) {
    setLedger({ rows, snapshot, loaded: true, stale: false, updatedAt: Date.now(), error: "", revision: generationRef.current });
  }

  function invalidate() {
    // A read started before an edit must not restore the old snapshot as fresh.
    const revision = ++generationRef.current;
    pendingRef.current = null;
    setLedger((current) => ({ ...current, stale: current.loaded, revision }));
  }

  function fail(error: string) {
    // Failed reads cannot erase a valid snapshot or turn unknown spend into zero.
    const revision = generationRef.current;
    setLedger((current) => ({ ...current, error, stale: true, revision }));
  }

  function captureRefreshFailure() {
    // Metadata cannot replace an active ledger read's result, even after it settles.
    const generation = pendingRef.current ? null : generationRef.current;
    return (error: string) => {
      if (generation !== null && generation === generationRef.current) fail(error);
    };
  }

  function syncDemoAdmin(policies: AccessPolicy[], credentials: ProxyCredential[], providers: ProviderRow[], routes: RouteCatalog, syncRows = false) {
    setAdminOverview(adminOverviewFromPolicies(policies, credentials, providers, routes));
    setTenantSummaries(tenantSummaryFallback(policies, credentials));
    if (syncRows) {
      setLedger((current) => ({ ...current, rows: policies.map(policyUsageFallback), loaded: true }));
    }
  }

  function refreshLedger(gatewayOrigin: string): Promise<boolean> {
    if (pendingRef.current) return pendingRef.current;
    const generation = ++generationRef.current;
    const operation = settled(() => request<{ policies?: AdminUsageRow[]; keys?: AdminUsageRow[]; usage: UsageSnapshot }>(gatewayOrigin, "/v1/admin/usage"))
      .then((result) => {
        // Navigation and full refresh share this read; a former principal cannot publish it.
        if (generation !== generationRef.current) return false;
        if (result.ok) hydrate(result.value.policies ?? result.value.keys ?? [], result.value.usage);
        else fail(`Usage ledger unavailable: ${result.error}`);
        return result.ok;
      }).finally(() => {
        if (pendingRef.current === operation) pendingRef.current = null;
      });
    pendingRef.current = operation;
    return operation;
  }

  return {
    adminOverview,
    setAdminOverview,
    tenantSummaries,
    setTenantSummaries,
    ...ledger,
    setPrincipal,
    hydrate,
    invalidate,
    fail,
    captureRefreshFailure,
    syncDemoAdmin,
    refreshLedger,
  };
}
