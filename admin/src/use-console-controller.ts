export function useConsoleController() {
  const [view, setView] = useState<View>(initialViewFromPath);
  const gatewayOrigin = window.location.origin;
  const allowDemo = isLocalDemoAllowed();
  const [session, setSession] = useState<SessionResponse>(allowDemo ? demo.session : emptySession);
  const [providers, setProviders] = useState<ProviderRow[]>(allowDemo ? demo.providers : []);
  const [routes, setRoutes] = useState<RouteCatalog>(allowDemo ? demo.routes : emptyRoutes);
  const [keys, setKeys] = useState<AccessPolicy[]>(allowDemo ? demo.keys : []);
  const [credentials, setCredentials] = useState<ProxyCredential[]>(allowDemo ? demo.credentials : []);
  const [connections, setConnections] = useState<ProviderConnection[]>(allowDemo ? demo.connections : []);
  const [upstreamGrants, setUpstreamGrants] = useState<UpstreamGrant[]>(allowDemo ? demo.upstreamGrants : []);
  const [assignmentRules, setAssignmentRules] = useState<AssignmentRule[]>(allowDemo ? demo.assignmentRules : []);
  const [policyDataLoaded, setPolicyDataLoaded] = useState(allowDemo);
  const [users, setUsers] = useState<AccessUser[]>(allowDemo ? demo.users : []);
  const [bindings, setBindings] = useState<PolicyBinding[]>(allowDemo ? demo.bindings : []);
  const [adminOverview, setAdminOverview] = useState<AdminOverview | null>(allowDemo ? demo.overview : null);
  const [tenantSummaries, setTenantSummaries] = useState<AdminTenantSummary[]>(allowDemo ? demo.tenants : []);
  const [usageRows, setUsageRows] = useState<AdminUsageRow[]>(allowDemo ? demo.usageRows : []);
  const [usageSnapshot, setUsageSnapshot] = useState<UsageSnapshot>(allowDemo ? demo.usage : emptyUsageSnapshot);
  const [usageLoaded, setUsageLoaded] = useState(allowDemo);
  const [usageRefreshKey, setUsageRefreshKey] = useState(0);
  const [entitlements, setEntitlements] = useState<EntitlementsResponse | null>(allowDemo ? demo.entitlements : null);
  const [providerReadiness, setProviderReadiness] = useState<Record<string, ProviderReadiness>>(allowDemo ? readinessMap(demo.entitlements.providers.map((item) => item.readiness)) : {});
  const [policyForm, setPolicyForm] = useState<PolicyForm>(allowDemo && demo.keys[0] ? policyFormFromPolicy(demo.keys[0]) : defaultPolicy);
  const [credentialForm, setCredentialForm] = useState<CredentialForm>(allowDemo && demo.keys[0] ? { credentialId: "", policyId: demo.keys[0].policyId, principalId: "" } : defaultCredential);
  const [bindingForm, setBindingForm] = useState<BindingForm>(allowDemo && demo.keys[0] ? { ...defaultBinding, policyId: demo.keys[0].policyId } : defaultBinding);
  const [upstreamGrantForm, setUpstreamGrantForm] = useState<UpstreamGrantForm>(allowDemo && demo.upstreamGrants[0] ? upstreamGrantFormFromGrant(demo.upstreamGrants[0]) : defaultUpstreamGrant);
  const [assignmentRuleForm, setAssignmentRuleForm] = useState<AssignmentRuleForm>(allowDemo && demo.assignmentRules[0] ? assignmentRuleFormFromRule(demo.assignmentRules[0]) : defaultAssignmentRule);
  const [accessTab, setAccessTab] = useState<AccessTab>(initialAccessTab);
  const [accessForm, setAccessForm] = useState<AccessForm>(allowDemo && demo.users[0] ? accessFormFromUser(demo.users[0], demo.bindings) : defaultAccess);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("all");
  const [selectedServiceId, setSelectedServiceId] = useState(demo.services[0]?.id ?? "");
  const [selectedPolicyId, setSelectedPolicyId] = useState(allowDemo ? demo.keys[0]?.policyId ?? "" : "");
  const [selectedCredentialId, setSelectedCredentialId] = useState(allowDemo ? demo.credentials[0]?.credentialId ?? "" : "");
  const [selectedBindingKey, setSelectedBindingKey] = useState(allowDemo ? bindingKey(demo.bindings[0]) : "");
  const [selectedUpstreamGrantKey, setSelectedUpstreamGrantKey] = useState(allowDemo ? demo.upstreamGrants[0]?.key ?? "" : "");
  const [selectedAssignmentRuleId, setSelectedAssignmentRuleId] = useState(allowDemo ? demo.assignmentRules[0]?.ruleId ?? "" : "");
  const [selectedUserEmail, setSelectedUserEmail] = useState(demo.users[0]?.email ?? "");
  const [status, setStatus] = useState(allowDemo ? "local demo data loaded" : "loading");
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(allowDemo ? Date.now() : null);
  const [demoMode, setDemoMode] = useState(allowDemo);
  const [issuedKey, setIssuedKey] = useState("");
  const [policyError, setPolicyError] = useState("");
  const [userError, setUserError] = useState("");
  const [playgroundError, setPlaygroundError] = useState("");
  const [playground, setPlayground] = useState<PlaygroundForm>({
    mode: "model",
    model: catalogModels(demo.routes)[0]?.id ?? "",
    endpoint: "/v1/chat/completions",
    ...demoServicePreset,
    system: "You are concise and useful.",
    prompt: "Say hello from ClawRouter in one short sentence.",
    maxTokens: "128",
    temperature: "0.7",
  });
  const [playgroundTurns, setPlaygroundTurns] = useState<PlaygroundTurn[]>([]);
  const [selectedPlaygroundTurnId, setSelectedPlaygroundTurnId] = useState("");
  const [requestMode, setRequestMode] = useState<"json" | "curl">("json");
  const refreshPromiseRef = useRef<Promise<void> | null>(null);
  const refreshBackgroundRef = useRef(false);
  const refreshRef = useRef<(options?: RefreshOptions) => Promise<void>>(async () => undefined);
  const accessByProvider = useMemo(() => accessMap(entitlements), [entitlements]);
  const services = useMemo(() => serviceItems(providers, routes, providerReadiness, accessByProvider), [accessByProvider, providerReadiness, providers, routes]);
  const models = useMemo(() => catalogModels(routes), [routes]);
  const serviceRoutes = useMemo(() => routes.manifestProxy, [routes]);
  const kinds = useMemo(() => ["all", ...Array.from(new Set(services.map((item) => item.kind))).sort()], [services]);
  const filteredServices = useMemo(() => {
    return services.filter((item) => (kind === "all" || item.kind === kind) && matchesServiceQuery(item, query));
  }, [kind, query, services]);
  const selectedService = services.find((item) => item.id === selectedServiceId) ?? services[0];
  const selectedPolicy = keys.find((key) => key.policyId === selectedPolicyId);
  const selectedCredential = credentials.find((credential) => credential.credentialId === selectedCredentialId);
  const selectedBinding = bindings.find((binding) => bindingKey(binding) === selectedBindingKey);
  const selectedUpstreamGrant = upstreamGrants.find((grant) => grant.key === selectedUpstreamGrantKey);
  const selectedAssignmentRule = assignmentRules.find((rule) => rule.ruleId === selectedAssignmentRuleId);
  const selectedUser = selectedUserEmail ? users.find((user) => user.email === selectedUserEmail) : undefined;
  const selectedModel = models.find((model) => model.id === playground.model) ?? models[0];
  const selectedServiceRoute = serviceRoutes.find((route) => routeKey(route) === playground.serviceRoute) ?? serviceRoutes[0];
  const statusPresentation = consoleStatusPresentation(status, demoMode);
  const busy = statusPresentation.tone === "pending";
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const statusTone = statusPresentation.tone;
  useEffect(() => {
    if (localDemoRole() === "user") {
      loadUserDemo();
      return;
    }
    void refresh();
  }, []);
  useEffect(() => {
    refreshRef.current = refresh;
  });
  useEffect(() => {
    if (demoMode) return;
    return installAutoRefresh(() => {
      if (!busyRef.current) void refreshRef.current({ background: true });
    });
  }, [demoMode]);
  useEffect(() => {
    const onPopState = () => setView(initialViewFromPath());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);
  useEffect(() => {
    if (status !== "loading" && session.role !== "admin" && adminViews.has(view)) navigateTo("catalog", true);
  }, [session.role, status, view]);
  useEffect(() => {
    if ((view === "home" || view === "usage") && session.role === "admin" && policyDataLoaded && !demoMode && !usageLoaded) {
      void refreshUsageLedger();
    }
  }, [demoMode, policyDataLoaded, session.role, usageLoaded, usageRefreshKey, view]);
  useEffect(() => {
    if (models.length && !models.some((model) => model.id === playground.model)) {
      setPlayground((current) => ({ ...current, model: models[0].id }));
    }
  }, [models, playground.model]);
  useEffect(() => {
    if (serviceRoutes.length && !serviceRoutes.some((route) => routeKey(route) === playground.serviceRoute)) {
      const route = serviceRoutes[0];
      setPlayground((current) => ({ ...current, ...playgroundServicePreset(route) }));
    }
  }, [playground.serviceRoute, serviceRoutes]);
  function refresh(options: RefreshOptions = {}): Promise<void> {
    if (refreshPromiseRef.current) {
      if (!options.background && refreshBackgroundRef.current) {
        return refreshPromiseRef.current.then(() => refresh(options));
      }
      return refreshPromiseRef.current;
    }
    refreshBackgroundRef.current = options.background ?? false;
    const operation = refreshData(options).finally(() => {
      if (refreshPromiseRef.current === operation) {
        refreshPromiseRef.current = null;
        refreshBackgroundRef.current = false;
      }
    });
    refreshPromiseRef.current = operation;
    return operation;
  }
  async function refreshData({ background = false }: RefreshOptions) {
    try {
      if (!background) {
        setStatus("loading");
        setPolicyDataLoaded(false);
      }
      const [sessionData, providerData, routeData] = await Promise.all([
        request<SessionResponse>(gatewayOrigin, "/v1/session"),
        request<ProviderResponse>(gatewayOrigin, "/v1/providers"),
        request<RouteCatalog>(gatewayOrigin, "/v1/routes"),
      ]);
      setSession(sessionData);
      setProviders(providerData.providers);
      setRoutes(routeData);
      let refreshWarnings = sessionData.entitlementsError ? [`entitlements unavailable: ${sessionData.entitlementsError}`] : [];
      const sessionEntitlements = sessionData.entitlements
        ? { session: sessionData, providers: sessionData.entitlements.providers, contentRetention: sessionData.contentRetention ?? { enabled: false, retentionDays: 30, policyEnabled: false, userExempt: false } }
        : null;
      if (sessionEntitlements) {
        setEntitlements(sessionEntitlements);
        setProviderReadiness(readinessMap(sessionEntitlements.providers.map((item) => item.readiness)));
      } else {
        const entitlementResult = await settled(() => request<EntitlementsResponse>(gatewayOrigin, "/v1/entitlements"));
        if (entitlementResult.ok) {
          setEntitlements(entitlementResult.value);
          setProviderReadiness(readinessMap(entitlementResult.value.providers.map((item) => item.readiness)));
        } else {
          setEntitlements(null);
          refreshWarnings = [...refreshWarnings, `entitlements unavailable: ${entitlementResult.error}`];
        }
      }
      if (sessionData.role === "admin") {
        const [policyData, credentialData, connectionData, userData, bindingData, readinessData, upstreamGrantData, assignmentRuleData] = await Promise.all([
          request<{ policies: AccessPolicy[] }>(gatewayOrigin, "/v1/admin/policies"),
          request<{ credentials: ProxyCredential[] }>(gatewayOrigin, "/v1/admin/credentials"),
          request<{ connections: ProviderConnection[] }>(gatewayOrigin, "/v1/admin/connections"),
          request<{ users: AccessUser[] }>(gatewayOrigin, "/v1/admin/access-users"),
          request<{ bindings: PolicyBinding[] }>(gatewayOrigin, "/v1/admin/policy-bindings"),
          request<{ providers: ProviderReadiness[] }>(gatewayOrigin, "/v1/admin/provider-status"),
          request<{ grants: UpstreamGrant[] }>(gatewayOrigin, "/v1/admin/upstream-grants"),
          request<{ rules: AssignmentRule[] }>(gatewayOrigin, "/v1/admin/assignment-rules"),
        ]);
        setKeys(policyData.policies);
        setCredentials(credentialData.credentials);
        setConnections(connectionData.connections);
        setUpstreamGrants(upstreamGrantData.grants);
        setAssignmentRules(assignmentRuleData.rules);
        setUsers(userData.users);
        setBindings(bindingData.bindings);
        if (!background) {
          const refreshedPolicy = policyData.policies.find((policy) => policy.policyId === selectedPolicyId) ?? policyData.policies[0];
          setSelectedPolicyId(refreshedPolicy?.policyId ?? "");
          setPolicyForm(refreshedPolicy ? policyFormFromPolicy(refreshedPolicy) : { ...defaultPolicy, policyId: "", tenantId: sessionData.tenantId ?? "default", providers: [...defaultPolicy.providers] });
          const refreshedCredential = credentialData.credentials.find((credential) => credential.credentialId === selectedCredentialId) ?? credentialData.credentials[0];
          setSelectedCredentialId(refreshedCredential?.credentialId ?? "");
          setCredentialForm({ credentialId: "", policyId: refreshedPolicy?.policyId ?? policyData.policies[0]?.policyId ?? "", principalId: "" });
          const refreshedBinding = bindingData.bindings.find((binding) => bindingKey(binding) === selectedBindingKey) ?? bindingData.bindings[0];
          setSelectedBindingKey(refreshedBinding ? bindingKey(refreshedBinding) : "");
          setBindingForm(refreshedBinding ? bindingFormFromBinding(refreshedBinding) : { ...defaultBinding, policyId: refreshedPolicy?.policyId ?? "" });
          const refreshedGrant = upstreamGrantData.grants.find((grant) => grant.key === selectedUpstreamGrantKey) ?? upstreamGrantData.grants[0];
          setSelectedUpstreamGrantKey(refreshedGrant?.key ?? "");
          setUpstreamGrantForm(refreshedGrant ? upstreamGrantFormFromGrant(refreshedGrant) : { ...defaultUpstreamGrant, scopeId: refreshedPolicy?.policyId ?? "", provider: providerData.providers[0]?.id ?? "", tokenRef: providerData.providers[0]?.id ?? "" });
          const refreshedRule = assignmentRuleData.rules.find((rule) => rule.ruleId === selectedAssignmentRuleId) ?? assignmentRuleData.rules[0];
          setSelectedAssignmentRuleId(refreshedRule?.ruleId ?? "");
          setAssignmentRuleForm(refreshedRule ? assignmentRuleFormFromRule(refreshedRule) : defaultAssignmentRule);
          const refreshedUser = userData.users.find((user) => user.email === selectedUserEmail) ?? userData.users[0];
          setSelectedUserEmail(refreshedUser?.email ?? "");
          setAccessForm(refreshedUser ? accessFormFromUser(refreshedUser, bindingData.bindings) : defaultAccess);
        }
        setProviderReadiness((current) => ({ ...current, ...readinessMap(readinessData.providers) }));
        const [overviewResult, tenantResult, usageResult] = await Promise.all([
          settled(() => request<AdminOverview>(gatewayOrigin, "/v1/admin/overview")),
          settled(() => request<{ tenants: AdminTenantSummary[] }>(gatewayOrigin, "/v1/admin/tenants")),
          background
            ? settled(() => request<{ policies?: AdminUsageRow[]; keys?: AdminUsageRow[]; usage: UsageSnapshot }>(gatewayOrigin, "/v1/admin/usage"))
            : Promise.resolve(null),
        ]);
        if (overviewResult.ok) {
          setAdminOverview(overviewResult.value);
        } else {
          setAdminOverview(adminOverviewFromPolicies(policyData.policies, credentialData.credentials, providerData.providers, routeData));
          refreshWarnings = [...refreshWarnings, `overview unavailable: ${overviewResult.error}`];
        }
        if (tenantResult.ok) {
          setTenantSummaries(tenantResult.value.tenants);
        } else {
          setTenantSummaries(tenantSummaryFallback(policyData.policies, credentialData.credentials));
          refreshWarnings = [...refreshWarnings, `tenant summary unavailable: ${tenantResult.error}`];
        }
        if (usageResult?.ok) {
          setUsageRows(usageResult.value.policies ?? usageResult.value.keys ?? []);
          setUsageSnapshot(usageResult.value.usage);
          setUsageLoaded(true);
        } else if (usageResult) {
          refreshWarnings = [...refreshWarnings, `usage ledger unavailable: ${usageResult.error}`];
        } else {
          setUsageRows([]);
          setUsageSnapshot(emptyUsageSnapshot);
          setUsageLoaded(false);
        }
        setPolicyDataLoaded(true);
        if (!background && view === "usage") setUsageRefreshKey((current) => current + 1);
      } else {
        const user = {
          email: sessionData.email ?? "access-user",
          role: sessionData.role,
          tenantId: sessionData.tenantId ?? "default",
          enabled: sessionData.authenticated,
          groups: sessionData.groups ?? [],
          contentRetentionDisabled: sessionData.contentRetention?.userExempt ?? false,
        };
        setKeys([]);
        setCredentials([]);
        setConnections([]);
        setUpstreamGrants([]);
        setAssignmentRules([]);
        setPolicyDataLoaded(false);
        setUsers([user]);
        setBindings([]);
        setAdminOverview(null);
        setTenantSummaries([]);
        const accessUsageResult = await settled(() => request<{ policies: AdminUsageRow[]; usage: UsageSnapshot }>(gatewayOrigin, "/v1/session/usage"));
        if (accessUsageResult.ok) {
          setUsageRows(accessUsageResult.value.policies);
          setUsageSnapshot(accessUsageResult.value.usage);
          setUsageLoaded(true);
        } else {
          setUsageRows([]);
          setUsageSnapshot(emptyUsageSnapshot);
          setUsageLoaded(false);
          refreshWarnings = [...refreshWarnings, `quota status unavailable: ${accessUsageResult.error}`];
        }
        setSelectedUserEmail(user.email);
        setAccessForm(accessFormFromUser(user, []));
      }
      setDemoMode(false);
      setLastUpdatedAt(Date.now());
      if (!background) setStatus(refreshWarnings.length ? refreshWarnings.join("; ") : oauthCallbackStatus() ?? "connected");
    } catch (error) {
      const message = errorMessage(error);
      if (allowDemo) {
        setSession(demo.session);
        setProviders(demo.providers);
        setRoutes(demo.routes);
        setKeys(demo.keys);
        setCredentials(demo.credentials);
        setConnections(demo.connections);
        setUpstreamGrants(demo.upstreamGrants);
        setAssignmentRules(demo.assignmentRules);
        setPolicyDataLoaded(true);
        setUsers(demo.users);
        setBindings(demo.bindings);
        setAdminOverview(demo.overview);
        setTenantSummaries(demo.tenants);
        setUsageRows(demo.usageRows);
        setUsageSnapshot(demo.usage);
        setUsageLoaded(true);
        setEntitlements(demo.entitlements);
        setProviderReadiness(readinessMap(demo.entitlements.providers.map((item) => item.readiness)));
        setSelectedPolicyId(demo.keys[0]?.policyId ?? "");
        setPolicyForm(demo.keys[0] ? policyFormFromPolicy(demo.keys[0]) : defaultPolicy);
        setSelectedCredentialId(demo.credentials[0]?.credentialId ?? "");
        setCredentialForm({ credentialId: "", policyId: demo.keys[0]?.policyId ?? "", principalId: "" });
        setSelectedBindingKey(demo.bindings[0] ? bindingKey(demo.bindings[0]) : "");
        setBindingForm(demo.bindings[0] ? bindingFormFromBinding(demo.bindings[0]) : defaultBinding);
        setSelectedUpstreamGrantKey(demo.upstreamGrants[0]?.key ?? "");
        setUpstreamGrantForm(demo.upstreamGrants[0] ? upstreamGrantFormFromGrant(demo.upstreamGrants[0]) : defaultUpstreamGrant);
        setSelectedAssignmentRuleId(demo.assignmentRules[0]?.ruleId ?? "");
        setAssignmentRuleForm(demo.assignmentRules[0] ? assignmentRuleFormFromRule(demo.assignmentRules[0]) : defaultAssignmentRule);
        setSelectedUserEmail(demo.users[0]?.email ?? "");
        setAccessForm(demo.users[0] ? accessFormFromUser(demo.users[0], demo.bindings) : defaultAccess);
        setDemoMode(true);
        setLastUpdatedAt(Date.now());
        setStatus("local demo data loaded");
        return;
      }
      setDemoMode(false);
      if (!background) setStatus(`load error: ${message}`);
    }
  }
  function loadUserDemo() {
    const user = demo.users.find((candidate) => candidate.email === "research@example.com") ?? demo.users.find((candidate) => candidate.role === "user")!;
    const access = effectiveAccess(user, demo.keys, demo.bindings, demo.services);
    const policyIds = new Set(access.policies.map((policy) => policy.policyId));
    const providers = new Set(access.services.map((service) => service.provider));
    const providerUsage = demo.usage.providers.filter((provider) => providers.has(provider.provider));
    const usageSummary = providerUsage.reduce<UsageSummary>((summary, provider) => ({
      ...summary,
      requestCount: summary.requestCount + provider.requestCount,
      successCount: summary.successCount + provider.successCount,
      errorCount: summary.errorCount + provider.errorCount,
      totalTokens: summary.totalTokens + provider.totalTokens,
      actualCostMicros: summary.actualCostMicros + provider.actualCostMicros,
    }), { requestCount: 0, successCount: 0, errorCount: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, actualCostMicros: 0 });
    const entitlements = {
      session: { ...demo.session, ...user, auth: "demo" },
      contentRetention: {
        enabled: !user.contentRetentionDisabled && access.policies.some((policy) => policy.retainRequestContent),
        retentionDays: 30,
        policyEnabled: access.policies.some((policy) => policy.retainRequestContent),
        userExempt: user.contentRetentionDisabled,
      },
      providers: demo.entitlements.providers.map((provider) => ({
        ...provider,
        allowed: providers.has(provider.provider),
        policies: provider.policies.filter((policyId) => policyIds.has(policyId)),
      })),
    };
    setSession(entitlements.session);
    setProviders(demo.providers);
    setRoutes(demo.routes);
    setKeys([]);
    setCredentials([]);
    setConnections([]);
    setUpstreamGrants([]);
    setAssignmentRules([]);
    setPolicyDataLoaded(false);
    setUsers([user]);
    setBindings([]);
    setAdminOverview(null);
    setTenantSummaries([]);
    setUsageRows(access.policies.map(policyUsageFallback));
    setUsageSnapshot({ ...demo.usage, summary: usageSummary, providers: providerUsage, events: [] });
    setUsageLoaded(true);
    setEntitlements(entitlements);
    setProviderReadiness(readinessMap(entitlements.providers.map((provider) => provider.readiness)));
    setLastUpdatedAt(Date.now());
    setStatus("local user demo loaded");
    setDemoMode(true);
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
    } catch (error) {
      const message = errorMessage(error);
      setPolicyError(message);
      setStatus(message);
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
        } catch (error) {
          const message = errorMessage(error);
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
    } catch (error) {
      const message = errorMessage(error);
      setPolicyError(message);
      setStatus(message);
    }
  }
  async function revokeCredential(credentialId: string) {
    try {
      setStatus(`revoking ${credentialId}`);
      if (demoMode) {
        applyDemoCredentials((current) => current.map((credential) => credential.credentialId === credentialId ? { ...credential, enabled: false } : credential));
      } else {
        await request<ProxyCredential>(gatewayOrigin, `/v1/admin/credentials/${encodeURIComponent(credentialId)}/revoke`, { method: "POST" });
        await refresh();
      }
      setIssuedKey("");
      setStatus(`revoked ${credentialId}`);
    } catch (error) {
      const message = errorMessage(error);
      setPolicyError(message);
      setStatus(message);
    }
  }
  async function saveBinding(event: FormEvent) {
    event.preventDefault();
    try {
      setPolicyError("");
      const principalId = bindingForm.principalId.trim().toLowerCase();
      if (!principalId) throw new Error("principal is required");
      if (!bindingForm.policyId) throw new Error("select a policy");
      const next: PolicyBinding = {
        policyId: bindingForm.policyId,
        principalType: bindingForm.principalType,
        principalId,
        enabled: bindingForm.enabled,
        priority: optionalNumber(bindingForm.priority) ?? 100,
      };
      setStatus("saving binding");
      if (demoMode) {
        setBindings((current) => [next, ...current.filter((binding) => bindingKey(binding) !== bindingKey(next))]);
      } else {
        await request<PolicyBinding>(gatewayOrigin, "/v1/admin/policy-bindings", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(next),
        });
        await refresh();
      }
      setSelectedBindingKey(bindingKey(next));
      setBindingForm(bindingFormFromBinding(next));
      setStatus("saved binding");
    } catch (error) {
      const message = errorMessage(error);
      setPolicyError(message);
      setStatus(message);
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
        saved = await request<UpstreamGrant>(gatewayOrigin, path, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        await refresh();
      }
      setSelectedUpstreamGrantKey(saved.key);
      setUpstreamGrantForm(upstreamGrantFormFromGrant(saved));
      setStatus("saved upstream grant");
    } catch (error) {
      const message = errorMessage(error);
      setPolicyError(message);
      setStatus(message);
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
    } catch (error) {
      const message = errorMessage(error);
      setPolicyError(message);
      setStatus(message);
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
    } catch (error) {
      const message = errorMessage(error);
      setPolicyError(message);
      setStatus(message);
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
    } catch (error) {
      const message = errorMessage(error);
      setPolicyError(message);
      setStatus(message);
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
        saved = await request<AssignmentRule>(gatewayOrigin, `/v1/admin/assignment-rules/${encodeURIComponent(ruleId)}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        await refresh();
      }
      setSelectedAssignmentRuleId(saved.ruleId);
      setAssignmentRuleForm(assignmentRuleFormFromRule(saved));
      setStatus("saved assignment rule");
    } catch (error) {
      const message = errorMessage(error);
      setPolicyError(message);
      setStatus(message);
    }
  }
  async function reconcileAssignments() {
    try {
      setPolicyError("");
      setStatus("reconciling assignments");
      if (!demoMode) {
        await request<{ results: unknown[] }>(gatewayOrigin, "/v1/admin/assignment-rules/reconcile", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ all: true }),
        });
        await refresh();
      }
      setStatus("reconciled assignments");
    } catch (error) {
      const message = errorMessage(error);
      setPolicyError(message);
      setStatus(message);
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
        await request<ProviderConnection>(gatewayOrigin, `/v1/admin/connections/${encodeURIComponent(providerId)}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(next),
        });
        await refresh();
      }
      setStatus(`${enabled ? "enabled" : "disabled"} ${providerId}`);
    } catch (error) {
      const message = errorMessage(error);
      setStatus(message);
    }
  }
  async function refreshUsageLedger() {
    if (demoMode || session.role !== "admin") return;
    const result = await settled(() => request<{ policies?: AdminUsageRow[]; keys?: AdminUsageRow[]; usage: UsageSnapshot }>(gatewayOrigin, "/v1/admin/usage"));
    if (result.ok) {
      setUsageRows(result.value.policies ?? result.value.keys ?? []);
      setUsageSnapshot(result.value.usage);
      setUsageLoaded(true);
      return;
    }
    setUsageRows([]);
    setUsageSnapshot(emptyUsageSnapshot);
    setUsageLoaded(false);
    if (view === "usage") setStatus(`usage ledger unavailable: ${result.error}`);
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
        body: JSON.stringify({
          tenantId: next.tenantId,
          enabled: next.enabled,
          groups: next.groups,
          contentRetentionDisabled: next.contentRetentionDisabled,
          policyIds: accessForm.policyIds,
        }),
      });
      try {
        await refresh();
      } catch (error) {
        const message = errorMessage(error);
        setSelectedUserEmail(email);
        setAccessForm(accessFormFromUser(next, nextBindings));
        setUserError(`saved user, but refresh failed: ${message}`);
        setStatus("saved user; refresh failed");
        return;
      }
      setSelectedUserEmail(email);
      setAccessForm(accessFormFromUser(next, nextBindings));
      setStatus("saved user");
    } catch (error) {
      const message = errorMessage(error);
      setUserError(message);
      setStatus(message);
      await refresh().catch(() => undefined);
      setUserError(message);
      setStatus(message);
    }
  }
  async function revoke(policyId: string) {
    try {
      setStatus(`revoking ${policyId}`);
      if (demoMode) {
        applyDemoKeys((current) => current.map((key) => (key.policyId === policyId ? { ...key, enabled: false } : key)));
        setStatus(`revoked ${policyId}`);
        return;
      }
      await request<AccessPolicy>(gatewayOrigin, `/v1/admin/policies/${encodeURIComponent(policyId)}/revoke`, { method: "POST" });
      await refresh();
      setStatus(`revoked ${policyId}`);
    } catch (error) {
      const message = errorMessage(error);
      setPolicyError(message);
      setStatus(message);
    }
  }
  async function runPlayground(event: FormEvent) {
    event.preventDefault();
    const startedAt = performance.now();
    const prompt = playground.mode === "model" ? playground.prompt.trim() : playground.servicePayload.trim();
    const conversation = playground.mode === "model"
      ? playgroundTurns.filter((turn) => turn.mode === "model" && !turn.error).flatMap((turn) => [
        { role: "user" as const, content: turn.prompt },
        { role: "assistant" as const, content: turn.response },
      ])
      : [];
    const provider = playground.mode === "model" ? selectedModel?.provider ?? "unknown" : selectedServiceRoute?.provider ?? "unknown";
    const model = playground.mode === "model" ? selectedModel?.id ?? playground.model : selectedServiceRoute?.endpoint ?? playground.serviceRoute;
    const endpoint = playgroundAccessEndpoint(playground, selectedServiceRoute);
    let requestPreview = "";
    try {
      if (!prompt) throw new Error(playground.mode === "model" ? "Enter a message." : "Enter a JSON request body.");
      setPlaygroundError("");
      setStatus("running playground");
      const guard = playgroundBlocker(playground, selectedModel, selectedServiceRoute, accessByProvider, providerReadiness);
      if (guard) throw new Error(guard);
      const payload = playgroundPayload(playground, selectedServiceRoute, conversation);
      requestPreview = JSON.stringify(payload, null, 2);
      if (demoMode) {
        const raw = JSON.stringify(playground.mode === "model"
          ? { provider: selectedModel?.provider, model: selectedModel?.id, output: "Hello from ClawRouter demo mode." }
          : { provider: selectedServiceRoute?.provider, route: selectedServiceRoute?.route, output: "Service proxy demo response." }, null, 2);
        const turn = createPlaygroundTurn({ mode: playground.mode, prompt, raw, request: requestPreview, provider, model, endpoint, status: 200, durationMs: Math.max(1, Math.round(performance.now() - startedAt)), retention: "demo" });
        setPlaygroundTurns((current) => [...current, turn]);
        setSelectedPlaygroundTurnId(turn.id);
        if (playground.mode === "model") setPlayground((current) => ({ ...current, prompt: "" }));
        setStatus("playground ready");
        return;
      }
      const method = "POST";
      const result = await playgroundRequest(gatewayOrigin, playgroundAccessEndpoint(playground, selectedServiceRoute), {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const responseError = result.ok ? undefined : playgroundResponseText(result.raw) || `Request failed with HTTP ${result.status}`;
      const turn = createPlaygroundTurn({ mode: playground.mode, prompt, raw: result.raw, request: requestPreview, provider, model, endpoint, status: result.status, durationMs: Math.max(1, Math.round(performance.now() - startedAt)), retention: result.retention, error: responseError });
      setPlaygroundTurns((current) => [...current, turn]);
      setSelectedPlaygroundTurnId(turn.id);
      if (responseError) {
        setPlaygroundError(responseError);
        setStatus(responseError);
        return;
      }
      if (playground.mode === "model") setPlayground((current) => ({ ...current, prompt: "" }));
      setStatus("playground ready");
    } catch (error) {
      const message = errorMessage(error);
      const turn = createPlaygroundTurn({ mode: playground.mode, prompt, raw: message, request: requestPreview, provider, model, endpoint, status: null, durationMs: Math.max(1, Math.round(performance.now() - startedAt)), retention: "unknown", error: message });
      if (prompt) {
        setPlaygroundTurns((current) => [...current, turn]);
        setSelectedPlaygroundTurnId(turn.id);
      }
      setPlaygroundError(message);
      setStatus(message);
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
      return {
        ...current,
        allProviders: false,
        providers: checked
          ? unique([...selected, ...providerIds]).sort()
          : selected.filter((id) => !providerIds.includes(id)),
      };
    });
  }
  function applyDemoKeys(updater: (current: AccessPolicy[]) => AccessPolicy[]) {
    setKeys((current) => {
      const next = updater(current);
      setAdminOverview(adminOverviewFromPolicies(next, credentials, providers, routes));
      setTenantSummaries(tenantSummaryFallback(next, credentials));
      setUsageRows(next.map(policyUsageFallback));
      setUsageLoaded(true);
      return next;
    });
  }
  function applyDemoCredentials(updater: (current: ProxyCredential[]) => ProxyCredential[]) {
    setCredentials((current) => {
      const next = updater(current);
      setAdminOverview(adminOverviewFromPolicies(keys, next, providers, routes));
      setTenantSummaries(tenantSummaryFallback(keys, next));
      return next;
    });
  }
  function navigateTo(nextView: View, replace = false) {
    setView(nextView);
    const nextPath = viewPaths[nextView];
    if (window.location.pathname !== nextPath) {
      const nextUrl = `${nextPath}${window.location.search}${window.location.hash}`;
      if (replace) window.history.replaceState(null, "", nextUrl);
      else window.history.pushState(null, "", nextUrl);
    }
  }
return { view, setView, gatewayOrigin, allowDemo, session, setSession, providers, setProviders, routes, setRoutes, keys, setKeys, credentials, setCredentials, connections, setConnections, upstreamGrants, setUpstreamGrants, assignmentRules, setAssignmentRules, policyDataLoaded, setPolicyDataLoaded, users, setUsers, bindings, setBindings, adminOverview, setAdminOverview, tenantSummaries, setTenantSummaries, usageRows, setUsageRows, usageSnapshot, setUsageSnapshot, usageLoaded, setUsageLoaded, usageRefreshKey, setUsageRefreshKey, entitlements, setEntitlements, providerReadiness, setProviderReadiness, policyForm, setPolicyForm, credentialForm, setCredentialForm, bindingForm, setBindingForm, upstreamGrantForm, setUpstreamGrantForm, assignmentRuleForm, setAssignmentRuleForm, accessTab, setAccessTab, accessForm, setAccessForm, query, setQuery, kind, setKind, selectedServiceId, setSelectedServiceId, selectedPolicyId, setSelectedPolicyId, selectedCredentialId, setSelectedCredentialId, selectedBindingKey, setSelectedBindingKey, selectedUpstreamGrantKey, setSelectedUpstreamGrantKey, selectedAssignmentRuleId, setSelectedAssignmentRuleId, selectedUserEmail, setSelectedUserEmail, status, setStatus, lastUpdatedAt, setLastUpdatedAt, demoMode, setDemoMode, issuedKey, setIssuedKey, policyError, setPolicyError, userError, setUserError, playgroundError, setPlaygroundError, playground, setPlayground, playgroundTurns, setPlaygroundTurns, selectedPlaygroundTurnId, setSelectedPlaygroundTurnId, requestMode, setRequestMode, refreshPromiseRef, refreshBackgroundRef, refreshRef, accessByProvider, services, models, serviceRoutes, kinds, filteredServices, selectedService, selectedPolicy, selectedCredential, selectedBinding, selectedUpstreamGrant, selectedAssignmentRule, selectedUser, selectedModel, selectedServiceRoute, statusPresentation, busy, busyRef, statusTone, refresh, refreshData, loadUserDemo, savePolicy, issueCredential, revokeCredential, saveBinding, saveUpstreamGrant, revokeUpstreamGrant, refreshUpstreamGrant, authorizeUpstreamGrant, saveAssignmentRule, reconcileAssignments, setProviderConnection, refreshUsageLedger, saveUser, revoke, runPlayground, editPolicy, startNewPolicy, startNewUser, editBinding, editUpstreamGrant, startNewUpstreamGrant, editAssignmentRule, startNewAssignmentRule, applyPreset, togglePolicyProvider, setPolicyProviderGroup, applyDemoKeys, applyDemoCredentials, navigateTo };
}
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { installAutoRefresh } from "./auto-refresh";
import { consoleStatusPresentation } from "./status-display";
import { accessFormFromUser,accessMap,bindingFormFromBinding,bindingKey,catalogProviderIds,currencyInput,effectiveAccess,errorMessage,grantNamesForService,knownPolicyProviders,optionalCurrencyMicros,optionalNumber,parseGroups,playgroundAccessEndpoint,playgroundBlockedForService,playgroundBlocker,playgroundPayload,playgroundResponseText,playgroundServicePreset,playgroundSupportsTemperature,policyCoversProvider,policyUsageFallback,preferredPlaygroundEndpoint,readinessLabel,readinessMap,readinessTone,reconcileDirectUserBindings,routeKey,serviceOutcome,tenantSummaryFallback,unique } from "./domain";
import { adminViews, defaultAccess, defaultAssignmentRule, defaultBinding, defaultCredential, defaultPolicy, defaultUpstreamGrant, demo, demoServicePreset, emptyRoutes, emptySession, emptyUsageSnapshot, initialAccessTab, initialViewFromPath, rolePresets, viewPaths } from "./ui-config";
import { adminOverviewFromPolicies,assignmentRuleFormFromRule,catalogModels,createPlaygroundTurn,demoGrantFromForm,demoRuleFromForm,generateSecret,isLocalDemoAllowed,localDemoRole,matchesServiceQuery,oauthCallbackStatus,parseCredentialBundle,playgroundRequest,policyFormFromPolicy,request,serviceItems,settled,sha256Hex,upstreamGrantFormFromGrant } from "./ui-helpers";
import type { AccessForm,AccessPolicy,AccessRole,AccessTab,AccessUser,AdminOverview,AdminTenantSummary,AdminUsageRow,AssignmentRule,AssignmentRuleForm,BindingForm,BrandIcon,BudgetStatus,ContentRetention,CredentialForm,EntitlementsResponse,IconComponent,OutcomeTone,PlaygroundForm,PlaygroundHttpResponse,PlaygroundTurn,PolicyBinding,PolicyForm,ProviderAccess,ProviderConnection,ProviderReadiness,ProviderResponse,ProviderRow,ProviderUsageSummary,ProxyCredential,RefreshOptions,RetainedRequestContent,RouteCatalog,ServiceItem,ServiceOutcome,SessionResponse,UpstreamGrant,UpstreamGrantForm,UsageAuditEvent,UsageSnapshot,UsageSummary,View } from "./ui-types";
