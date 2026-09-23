import { useCallback, useEffect, useRef } from "react";
import { effectiveAccess, errorMessage, policyCoversProvider, policyUsageFallback } from "./domain";
import { useAccessAdmin } from "./hooks/use-access-admin";
import { useCatalog } from "./hooks/use-catalog";
import { usePlayground } from "./hooks/use-playground";
import { useSession } from "./hooks/use-session";
import { useUsage } from "./hooks/use-usage";
import { useSelfServiceKeys } from "./hooks/use-self-service-keys";
import { useCredentialOperations } from "./hooks/use-credential-operations";
import { installAutoRefresh } from "./auto-refresh";
import { demo } from "./ui-config";
import { localDemoRole, localLoginAvailable, oauthCallbackStatus, request, settled, usagePolicyId } from "./ui-helpers";
import { syntheticUsageTimeline } from "./usage-analytics";
import type {
  AccessUser,
  AdminBootstrapResponse,
  AdminUsageRow,
  EntitlementsResponse,
  ProviderResponse,
  RefreshOptions,
  RouteCatalog,
  SessionResponse,
  UsageSnapshot,
  UsageSummary,
} from "./ui-types";

export function useConsoleController() {
  const session = useSession();
  const catalog = useCatalog(session.allowDemo);
  const usage = useUsage(session.allowDemo);
  const refreshPromiseRef = useRef<Promise<void> | null>(null);
  const refreshBackgroundRef = useRef(false);
  const catalogLoadedRef = useRef(false);
  const principalRef = useRef<string | null>(null);
  const refreshRef = useRef<(options?: RefreshOptions) => Promise<void>>(async () => undefined);
  const refreshCurrent = useCallback(() => refreshRef.current(), []);
  const refreshCredentialMetadata = useCallback(() => refreshRef.current({ background: true }), []);
  const credentialOwner = useCredentialOperations({ origin: session.gatewayOrigin, demo: session.demoMode, session: session.value }, session.setStatus, refreshCredentialMetadata);
  const selfServiceKeys = useSelfServiceKeys(credentialOwner);
  const access = useAccessAdmin({
    credentialOwner,
    allowDemo: session.allowDemo,
    gatewayOrigin: session.gatewayOrigin,
    session: session.value,
    demoMode: session.demoMode,
    providers: catalog.providers,
    routes: catalog.routes,
    setStatus: session.setStatus,
    setProviderReadiness: catalog.setProviderReadiness,
    refresh: refreshCurrent,
    syncDemoAdmin: usage.syncDemoAdmin,
  });
  credentialOwner.observePresentation(session.view === "home" ? "personal" : session.view === "policies" && access.tab.value === "credentials" && session.value.role === "admin" ? "admin" : null);
  const playground = usePlayground({
    gatewayOrigin: session.gatewayOrigin,
    demoMode: session.demoMode,
    setStatus: session.setStatus,
    models: catalog.models,
    serviceRoutes: catalog.serviceRoutes,
    accessByProvider: catalog.accessByProvider,
    providerReadiness: catalog.providerReadiness,
  });
  const busyRef = useRef(session.busy);
  busyRef.current = session.busy;

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
    if (session.demoMode) return;
    return installAutoRefresh(() => {
      if (!busyRef.current) void refreshRef.current({ background: true });
    });
  }, [session.demoMode]);

  useEffect(() => {
    const onPopState = () => { credentialOwner.invalidatePresentation(); session.syncViewFromPath(); };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [session.setView]);

  useEffect(() => {
    session.enforceRoleView();
  }, [session.value.role, session.refreshing, session.view]);

  useEffect(() => {
    if ((session.view === "home" || session.view === "usage") && session.value.role === "admin" && access.loaded && !session.demoMode && (!usage.loaded || usage.stale) && !usage.error) {
      void usage.refreshLedger(session.gatewayOrigin);
    }
  }, [access.loaded, session.demoMode, session.value.role, session.view, usage.loaded, usage.stale, usage.error, usage.revision]);

  function refresh(options: RefreshOptions = {}): Promise<void> {
    if (refreshPromiseRef.current) {
      if (!options.background && refreshBackgroundRef.current) return refreshPromiseRef.current.then(() => refresh(options));
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
    if (!background) {
      session.setRefreshing(true);
      access.setLoaded(false);
    }
    // Invalidate before reads begin so later navigation keeps its new ledger read.
    if (!background || (session.view !== "home" && session.view !== "usage" && !usage.error)) usage.invalidate();
    let failUsageRefresh = usage.captureRefreshFailure();
    try {
      const staticCatalog = catalogLoadedRef.current
        ? Promise.resolve({ providerData: { providers: catalog.providers }, routeData: catalog.routes })
        : Promise.all([
          request<ProviderResponse>(session.gatewayOrigin, "/v1/providers"),
          request<RouteCatalog>(session.gatewayOrigin, "/v1/routes"),
      ]).then(([providerData, routeData]) => ({ providerData, routeData }));
      const [sessionData, { providerData, routeData }] = await Promise.all([
        request<SessionResponse>(session.gatewayOrigin, "/v1/session"),
        staticCatalog,
      ]);
      const principal = JSON.stringify([sessionData.email, sessionData.tenantId, sessionData.role, sessionData.authenticated]);
      if (principalRef.current !== principal) {
        principalRef.current = principal;
        session.setRefreshError("");
        session.setLastUpdatedAt(null);
        usage.setPrincipal(principal);
        // This refresh owns the reset; ordinary waits cannot adopt a newer read.
        failUsageRefresh = usage.captureRefreshFailure();
      }
      session.setValue(sessionData);
      session.setLoginRequired(false);
      credentialOwner.setScope({ origin: session.gatewayOrigin, demo: false, session: sessionData });
      catalog.setProviders(providerData.providers);
      catalog.setRoutes(routeData);
      catalogLoadedRef.current = true;
      let warnings = sessionData.entitlementsError ? [`entitlements unavailable: ${sessionData.entitlementsError}`] : [];
      const sessionEntitlements: EntitlementsResponse | null = sessionData.entitlements
        ? {
          session: sessionData,
          providers: sessionData.entitlements.providers,
          contentRetention: sessionData.contentRetention ?? { enabled: false, retentionDays: 30, policyEnabled: false, userExempt: false },
        }
        : null;
      if (sessionEntitlements) catalog.setEntitlements(sessionEntitlements);
      else {
        const entitlementResult = await settledSessionData(() => request<EntitlementsResponse>(session.gatewayOrigin, "/v1/entitlements"));
        if (entitlementResult.ok) catalog.setEntitlements(entitlementResult.value);
        else {
          catalog.setEntitlements(null);
          warnings = [...warnings, `entitlements unavailable: ${entitlementResult.error}`];
        }
      }
      const result = sessionData.role === "admin"
        ? await loadAdminData(sessionData, providerData, background, warnings)
        : await loadUserData(sessionData, warnings);
      session.setDemoMode(false);
      session.setRefreshError(result.warnings.join("; "));
      if (result.complete) session.setLastUpdatedAt(Date.now());
      if (!background) session.setStatus(oauthCallbackStatus() ?? "connected");
    } catch (caught) {
      const message = errorMessage(caught);
      if (message.includes("access_session_required")) {
        // Confirmed auth loss clears one-time material before the login probe yields.
        credentialOwner.setScope(null);
      }
      if (message.includes("access_session_required") && await localLoginAvailable(session.gatewayOrigin)) {
        principalRef.current = null;
        usage.setPrincipal("");
        session.setLastUpdatedAt(null);
        session.setRefreshError("Sign-in required to refresh console data.");
        session.setLoginRequired(true);
        if (!background) session.setStatus("sign-in required");
        return;
      }
      if (session.allowDemo && principalRef.current === null) {
        loadAdminDemo();
        return;
      }
      session.setDemoMode(false);
      // Refresh health is separate from the mutation result that the caller reports.
      session.setRefreshError(`Console data refresh failed: ${message}`);
      failUsageRefresh(`Usage was not refreshed: ${message}`);
    } finally {
      if (!background) session.setRefreshing(false);
    }
  }

  async function loadAdminData(sessionData: SessionResponse, providerData: ProviderResponse, background: boolean, initialWarnings: string[]) {
    let warnings = initialWarnings;
    const keySnapshot = credentialOwner.captureHydration();
    const [data, sessionUsageResult, sessionCredentialsResult] = await Promise.all([
      request<AdminBootstrapResponse>(session.gatewayOrigin, "/v1/admin/bootstrap"),
      settledSessionData(() => request<{ policies: AdminUsageRow[] }>(session.gatewayOrigin, "/v1/session/usage")),
      settledSessionData(() => request<{ credentials: AdminBootstrapResponse["credentials"] }>(session.gatewayOrigin, "/v1/session/credentials")),
    ]);
    access.hydrateAdmin({
      policies: data.policies,
      credentials: data.credentials,
      connections: data.connections,
      users: data.users,
      bindings: data.bindings,
      grants: data.grants,
      rules: data.rules,
      fusion: data.fusion,
    }, background, sessionData, providerData.providers, keySnapshot);
    catalog.mergeReadiness(data.providers);
    usage.setAdminOverview(data.overview);
    usage.setTenantSummaries(data.tenants);
    if (sessionUsageResult.ok && sessionCredentialsResult.ok) credentialOwner.hydrate("personal", sessionCredentialsResult.value.credentials, keySnapshot, sessionUsageResult.value.policies.filter((policy) => policy.enabled).map(usagePolicyId));
    else warnings = [...warnings, "personal credentials unavailable"];
    const includeUsage = session.view === "home" || session.view === "usage" || Boolean(usage.error);
    const usageFresh = includeUsage ? await usage.refreshLedger(session.gatewayOrigin) : true;
    return { warnings, complete: !warnings.length && usageFresh };
  }

  async function loadUserData(sessionData: SessionResponse, initialWarnings: string[]) {
    let warnings = initialWarnings;
    const keySnapshot = credentialOwner.captureHydration();
    const user: AccessUser = {
      email: sessionData.email ?? "access-user",
      role: sessionData.role,
      tenantId: sessionData.tenantId ?? "default",
      enabled: sessionData.authenticated,
      groups: sessionData.groups ?? [],
      contentRetentionDisabled: sessionData.contentRetention?.userExempt ?? false,
    };
    access.hydrateUser(user);
    usage.setAdminOverview(null);
    usage.setTenantSummaries([]);
    const [result, credentialResult] = await Promise.all([
      settledSessionData(() => request<{ policies: AdminUsageRow[]; usage: UsageSnapshot }>(session.gatewayOrigin, "/v1/session/usage")),
      settledSessionData(() => request<{ credentials: AdminBootstrapResponse["credentials"] }>(session.gatewayOrigin, "/v1/session/credentials")),
    ]);
    if (result.ok) {
      usage.hydrate(result.value.policies, result.value.usage);
      if (credentialResult.ok) credentialOwner.hydrate("personal", credentialResult.value.credentials, keySnapshot, result.value.policies.filter((policy) => policy.enabled).map(usagePolicyId));
      else warnings = [...warnings, `personal credentials unavailable: ${credentialResult.error}`];
    } else {
      usage.fail(`Quota status unavailable: ${result.error}`);
    }
    return { warnings, complete: !warnings.length && result.ok };
  }

  function loadAdminDemo() {
    credentialOwner.setScope({ origin: session.gatewayOrigin, demo: true, session: demo.session });
    session.setValue(demo.session);
    catalog.setProviders(demo.providers);
    catalog.setRoutes(demo.routes);
    catalog.setEntitlements(demo.entitlements);
    access.hydrateDemo();
    usage.setAdminOverview(demo.overview);
    usage.setTenantSummaries(demo.tenants);
    usage.hydrate(demo.usageRows, demo.usage);
    credentialOwner.hydrate("personal", demo.credentials.filter((credential) => credential.principalId === demo.session.email), credentialOwner.captureHydration(), demo.keys.filter((policy) => policy.enabled).map((policy) => policy.policyId));
    session.setRefreshError("");
    session.setDemoMode(true);
    session.setLastUpdatedAt(Date.now());
    session.setStatus("local demo data loaded");
  }

  function loadUserDemo() {
    const user = demo.users.find((candidate) => candidate.email === "research@example.com") ?? demo.users.find((candidate) => candidate.role === "user")!;
    const effective = effectiveAccess(user, demo.keys, demo.bindings, demo.services);
    const providerIds = new Set(effective.services.map((service) => service.provider));
    const providerUsage = demo.usage.providers.filter((provider) => providerIds.has(provider.provider));
    const summary = providerUsage.reduce<UsageSummary>((current, provider) => ({
      ...current,
      requestCount: current.requestCount + provider.requestCount,
      successCount: current.successCount + provider.successCount,
      errorCount: current.errorCount + provider.errorCount,
      totalTokens: current.totalTokens + provider.totalTokens,
      actualCostMicros: current.actualCostMicros + provider.actualCostMicros,
      unpricedRequestCount: (current.unpricedRequestCount ?? 0) + (provider.unpricedRequestCount ?? 0),
    }), { requestCount: 0, successCount: 0, errorCount: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, actualCostMicros: 0 });
    const contentRetention = {
      enabled: !user.contentRetentionDisabled && effective.policies.some((policy) => policy.retainRequestContent),
      retentionDays: 30,
      policyEnabled: effective.policies.some((policy) => policy.retainRequestContent),
      userExempt: user.contentRetentionDisabled,
    };
    const entitlements: EntitlementsResponse = {
      session: { ...demo.session, ...user, auth: "demo", contentRetention },
      contentRetention,
      providers: demo.entitlements.providers.map((provider) => ({
        ...provider,
        allowed: providerIds.has(provider.provider),
        policies: effective.policies.filter((policy) => policyCoversProvider(policy, provider.provider)).map((policy) => policy.policyId),
      })),
    };
    session.setValue(entitlements.session);
    credentialOwner.setScope({ origin: session.gatewayOrigin, demo: true, session: entitlements.session });
    catalog.setProviders(demo.providers);
    catalog.setRoutes(demo.routes);
    catalog.setEntitlements(entitlements);
    access.hydrateUser(user);
    usage.setAdminOverview(null);
    usage.setTenantSummaries([]);
    usage.hydrate(effective.policies.map(policyUsageFallback), { ...demo.usage, summary, providers: providerUsage, daily: syntheticUsageTimeline(Date.now(), summary), events: [] });
    credentialOwner.hydrate("personal", demo.credentials.filter((credential) => credential.principalId === user.email), credentialOwner.captureHydration(), effective.policies.filter((policy) => policy.enabled).map((policy) => policy.policyId));
    session.setRefreshError("");
    session.setLastUpdatedAt(Date.now());
    session.setStatus("local user demo loaded");
    session.setDemoMode(true);
  }

  function navigateTo(...args: Parameters<typeof session.navigateTo>) {
    if (args[0] !== session.view) credentialOwner.invalidatePresentation();
    session.navigateTo(...args);
  }

  return { session: { ...session, navigateTo }, catalog, access, usage, selfServiceKeys, credentialOwner, playground, refresh };
}

export type ConsoleController = ReturnType<typeof useConsoleController>;

async function settledSessionData<T>(loader: () => Promise<T>) {
  const result = await settled(loader);
  // Auth loss must reach the scope reset even when sibling reads are still pending.
  if (!result.ok && result.error.includes("access_session_required")) throw new Error(result.error);
  return result;
}
