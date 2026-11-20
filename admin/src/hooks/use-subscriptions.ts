import { useEffect, useRef, useState } from "react";
import type { GrantUsageSnapshot } from "../../../shared/contracts";
import type { ConsoleRequest } from "../dashboard-fetch";
import { errorMessage } from "../domain";
import { currentSubscriptions, policyGrants, subscriptionPolicies } from "../subscriptions-data";
import type { AccessPolicy, UpstreamGrant } from "../ui-types";

export function useSubscriptions({ request, isCurrent, gatewayOrigin, active, demoMode, policies, grants }: {
  request: ConsoleRequest; isCurrent: () => boolean; gatewayOrigin: string; active: boolean; demoMode: boolean;
  policies: AccessPolicy[]; grants: UpstreamGrant[];
}) {
  const [selection, setPolicyId] = useState("");
  const [showRetired, setShowRetired] = useState(false);
  const [days, setDays] = useState(7);
  const [reading, setReading] = useState<{ key: string; data: GrantUsageSnapshot } | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  const epoch = useRef(0);
  const visiblePolicies = subscriptionPolicies(policies, showRetired);
  const policyId = visiblePolicies.some(policy => policy.policyId === selection) ? selection
    : visiblePolicies.find(policy => currentSubscriptions(policyGrants(policy, grants)).length)?.policyId ?? visiblePolicies[0]?.policyId ?? "";
  // Reconcile before rendering, not in a later effect that could overwrite a user selection.
  if (selection !== policyId) setPolicyId(policyId);
  const key = `${policyId}/${days}`;
  useEffect(() => {
    const generation = ++epoch.current;
    if (!active || !policyId) { setLoading(false); setError(""); return; }
    setLoading(true); setError("");
    if (demoMode) { setReading({ key, data: { days, since: Date.now() - days * 86400000, until: Date.now(), retentionDays: 30, grants: [], lanes: [], daily: [] } }); setLoading(false); return; }
    void request<GrantUsageSnapshot>(gatewayOrigin, `/v1/admin/upstream-grants/usage?scope=policies&scopeId=${encodeURIComponent(policyId)}&days=${days}`)
      .then(data => { if (generation === epoch.current && isCurrent()) setReading({ key, data }); })
      .catch(caught => { if (generation === epoch.current && isCurrent()) setError(errorMessage(caught)); })
      .finally(() => { if (generation === epoch.current && isCurrent()) setLoading(false); });
    return () => { epoch.current += 1; };
  }, [active, policyId, days, gatewayOrigin, demoMode, revision]);
  return { policyId, setPolicyId, visiblePolicies, showRetired, setShowRetired, days, setDays, usage: reading?.key === key ? reading.data : null, error, loading, refresh: () => setRevision(value => value + 1) };
}
