import { useState } from "react";
import { initialAccessTab, demo } from "../ui-config";
import type { AccessPolicy, AccessTab, AccessUser, AssignmentRule, FusionConfig, PolicyBinding, ProviderConnection, ProviderReadiness, ProviderRow, ProxyCredential, RouteCatalog, SessionResponse, UpstreamGrant } from "../ui-types";
import { useAssignmentAdmin } from "./access/use-assignment-admin";
import { useConnectionAdmin } from "./access/use-connection-admin";
import { useFusionAdmin } from "./access/use-fusion-admin";
import { usePolicyAdmin } from "./access/use-policy-admin";
import { usePrincipalAdmin } from "./access/use-principal-admin";
import { useUpstreamAdmin } from "./access/use-upstream-admin";

interface Dependencies {
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
  fusion: FusionConfig;
}

export function useAccessAdmin(dependencies: Dependencies) {
  const { allowDemo, gatewayOrigin, session, demoMode, providers, routes, setStatus, setProviderReadiness, refresh, syncDemoAdmin } = dependencies;
  const [loaded, setLoaded] = useState(allowDemo);
  const [tab, setTab] = useState<AccessTab>(initialAccessTab);
  const policy = usePolicyAdmin({ allowDemo, gatewayOrigin, session, demoMode, providers, routes, setStatus, refresh, syncDemoAdmin });
  const principal = usePrincipalAdmin({ allowDemo, gatewayOrigin, session, demoMode, policies: policy.policies.items, selectedPolicyId: policy.policies.selectedId, setPolicyError: policy.policies.setError, setStatus, refresh });
  const connection = useConnectionAdmin({ allowDemo, gatewayOrigin, demoMode, setStatus, setProviderReadiness, refresh });
  const upstream = useUpstreamAdmin({ allowDemo, gatewayOrigin, demoMode, providers, policies: policy.policies.items, selectedPolicyId: policy.policies.selectedId, setError: policy.policies.setError, setStatus, refresh });
  const assignment = useAssignmentAdmin({ allowDemo, gatewayOrigin, demoMode, setError: policy.policies.setError, setStatus, refresh });
  const fusion = useFusionAdmin({ allowDemo, gatewayOrigin, demoMode, policies: policy.policies.items, selectedPolicyId: policy.policies.selectedId, setStatus, refresh });

  function hydrateAdmin(records: AdminRecords, background: boolean, sessionData: SessionResponse, providerRows: ProviderRow[]) {
    policy.hydrate(records.policies, records.credentials, background, sessionData);
    connection.hydrate(records.connections);
    const policyId = records.policies.find((item) => item.policyId === policy.policies.selectedId)?.policyId ?? records.policies[0]?.policyId ?? "";
    principal.hydrate(records.users, records.bindings, background, policyId);
    upstream.hydrate(records.grants, background, policyId, providerRows);
    assignment.hydrate(records.rules, background);
    fusion.hydrate(records.fusion, background, policyId, records.policies.map((item) => item.policyId));
    setLoaded(true);
  }

  function hydrateUser(user: AccessUser) {
    policy.hydrate([], [], false, session);
    connection.hydrate([]);
    upstream.hydrate([], false, "", []);
    assignment.hydrate([], false);
    fusion.hydrate({ ...demo.fusion, enabled: false }, false);
    principal.hydrateUser(user);
    setLoaded(false);
  }

  function hydrateDemo() {
    hydrateAdmin({ policies: demo.keys, credentials: demo.credentials, connections: demo.connections, users: demo.users, bindings: demo.bindings, grants: demo.upstreamGrants, rules: demo.assignmentRules, fusion: demo.fusion }, false, demo.session, demo.providers);
  }

  function editPolicy(item: AccessPolicy) {
    policy.policies.edit(item);
    principal.bindings.setForm((current) => ({ ...current, policyId: item.policyId }));
  }

  return {
    loaded,
    setLoaded,
    tab: { value: tab, set: setTab },
    policies: { ...policy.policies, edit: editPolicy },
    credentials: policy.credentials,
    connections: connection.connections,
    bindings: principal.bindings,
    upstream: upstream.upstream,
    assignments: assignment.assignments,
    fusion: fusion.fusion,
    users: principal.users,
    hydrateAdmin,
    hydrateUser,
    hydrateDemo,
  };
}
