import { useState } from "react";
import { policyUsageFallback, tenantSummaryFallback } from "../domain";
import { demo, emptyUsageSnapshot } from "../ui-config";
import { adminOverviewFromPolicies, request, settled } from "../ui-helpers";
import type { AccessPolicy, AdminOverview, AdminTenantSummary, AdminUsageRow, ProviderRow, ProxyCredential, RouteCatalog, UsageSnapshot } from "../ui-types";

export function useUsage(allowDemo: boolean) {
  const [adminOverview, setAdminOverview] = useState<AdminOverview | null>(allowDemo ? demo.overview : null);
  const [tenantSummaries, setTenantSummaries] = useState<AdminTenantSummary[]>(allowDemo ? demo.tenants : []);
  const [rows, setRows] = useState<AdminUsageRow[]>(allowDemo ? demo.usageRows : []);
  const [snapshot, setSnapshot] = useState<UsageSnapshot>(allowDemo ? demo.usage : emptyUsageSnapshot);
  const [loaded, setLoaded] = useState(allowDemo);
  const [refreshKey, setRefreshKey] = useState(0);

  function reset() {
    setAdminOverview(null);
    setTenantSummaries([]);
    setRows([]);
    setSnapshot(emptyUsageSnapshot);
    setLoaded(false);
  }

  function resetLedger() {
    setRows([]);
    setSnapshot(emptyUsageSnapshot);
    setLoaded(false);
  }

  function syncDemoAdmin(policies: AccessPolicy[], credentials: ProxyCredential[], providers: ProviderRow[], routes: RouteCatalog, syncRows = false) {
    setAdminOverview(adminOverviewFromPolicies(policies, credentials, providers, routes));
    setTenantSummaries(tenantSummaryFallback(policies, credentials));
    if (syncRows) {
      setRows(policies.map(policyUsageFallback));
      setLoaded(true);
    }
  }

  async function refreshLedger(gatewayOrigin: string, setStatus: (status: string) => void, showError: boolean) {
    const result = await settled(() => request<{ policies?: AdminUsageRow[]; keys?: AdminUsageRow[]; usage: UsageSnapshot }>(gatewayOrigin, "/v1/admin/usage"));
    if (result.ok) {
      setRows(result.value.policies ?? result.value.keys ?? []);
      setSnapshot(result.value.usage);
      setLoaded(true);
      return;
    }
    resetLedger();
    if (showError) setStatus(`usage ledger unavailable: ${result.error}`);
  }

  return {
    adminOverview,
    setAdminOverview,
    tenantSummaries,
    setTenantSummaries,
    rows,
    setRows,
    snapshot,
    setSnapshot,
    loaded,
    setLoaded,
    refreshKey,
    requestRefresh: () => setRefreshKey((current) => current + 1),
    reset,
    resetLedger,
    syncDemoAdmin,
    refreshLedger,
  };
}
