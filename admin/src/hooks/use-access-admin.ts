import { useState } from "react";
import { initialAccessTab, demo } from "../ui-config";
import type { AccessPolicy, AccessTab, AccessUser, AssignmentRule, FusionConfig, PolicyBinding, ProviderConnection, ProviderReadiness, ProviderRow, ProxyCredential, RouteCatalog, SessionResponse, UpstreamGrant } from "../ui-types";
import { useAssignmentAdmin } from "./access/use-assignment-admin";
import { useConnectionAdmin } from "./access/use-connection-admin";
import { useCredentialAdmin } from "./access/use-credential-admin";
import type { CredentialOperations } from "./use-credential-operations";
import { useFusionAdmin } from "./access/use-fusion-admin";
import { usePolicyAdmin } from "./access/use-policy-admin";
import { usePrincipalAdmin } from "./access/use-principal-admin";
import { useUpstreamAdmin } from "./access/use-upstream-admin";

interface Dependencies {
  allowDemo: boolean;
  credentialOwner: CredentialOperations;
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
  const { allowDemo, credentialOwner, gatewayOrigin, session, demoMode, providers, routes, setStatus, setProviderReadiness, refresh, syncDemoAdmin } = dependencies;
  const [loaded, setLoaded] = useState(allowDemo);
  const [tab, setTab] = useState<AccessTab>(initialAccessTab);
  const policy = usePolicyAdmin({ allowDemo, gatewayOrigin, session, demoMode, providers, credentials: credentialOwner.rows.admin, routes, setStatus, refresh, syncDemoAdmin });
  const credentials = useCredentialAdmin(credentialOwner, policy.policies.items);
  const principal = usePrincipalAdmin({ allowDemo, gatewayOrigin, session, demoMode, policies: policy.policies.items, selectedPolicyId: policy.policies.selectedId, setPolicyError: policy.policies.setError, setStatus, refresh });
  const connection = useConnectionAdmin({ allowDemo, gatewayOrigin, demoMode, setStatus, setProviderReadiness, refresh });
  const upstream = useUpstreamAdmin({ allowDemo, gatewayOrigin, demoMode, providers, policies: policy.policies.items, selectedPolicyId: policy.policies.selectedId, setError: policy.policies.setError, setStatus, refresh });
  const assignment = useAssignmentAdmin({ allowDemo, gatewayOrigin, demoMode, setError: policy.policies.setError, setStatus, refresh });
  const fusion = useFusionAdmin({ allowDemo, gatewayOrigin, demoMode, policies: policy.policies.items, selectedPolicyId: policy.policies.selectedId, setStatus, refresh });

  function hydrateAdmin(records: AdminRecords, background: boolean, sessionData: SessionResponse, providerRows: ProviderRow[], credentialSnapshot: number) {
    policy.hydrate(records.policies, background, sessionData);
    credentialOwner.hydrate("admin", records.credentials, credentialSnapshot);
    connection.hydrate(records.connections);
    const policyId = records.policies.find((item) => item.policyId === policy.policies.selectedId)?.policyId ?? records.policies[0]?.policyId ?? "";
    principal.hydrate(records.users, records.bindings, background, policyId);
    upstream.hydrate(records.grants, background, policyId, providerRows);
    assignment.hydrate(records.rules, background);
    fusion.hydrate(records.fusion, background, policyId, records.policies.map((item) => item.policyId));
    setLoaded(true);
  }

  function hydrateUser(user: AccessUser) {
    policy.hydrate([], false, session);
    connection.hydrate([]);
    upstream.hydrate([], false, "", []);
    assignment.hydrate([], false);
    fusion.hydrate({ ...demo.fusion, enabled: false }, false);
    principal.hydrateUser(user);
    setLoaded(false);
  }

  function hydrateDemo() {
    hydrateAdmin({ policies: demo.keys, credentials: demo.credentials, connections: demo.connections, users: demo.users, bindings: demo.bindings, grants: demo.upstreamGrants, rules: demo.assignmentRules, fusion: demo.fusion }, false, demo.session, demo.providers, credentialOwner.captureHydration());
  }

  return {
    loaded,
    setLoaded,
    tab: { value: tab, set: (next: AccessTab) => { if (next !== tab) credentialOwner.invalidatePresentation(); setTab(next); } },
    policies: policy.policies,
    credentials,
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
