import { useCallback, useEffect, useRef } from "react";
import { effectiveAccess, errorMessage, policyCoversProvider, policyUsageFallback } from "./domain";
import { useAccessAdmin } from "./hooks/use-access-admin";
import { useCatalog } from "./hooks/use-catalog";
import { usePlayground } from "./hooks/use-playground";
import type { useSession } from "./hooks/use-session";
import { useUsage } from "./hooks/use-usage";
import { useSelfServiceKeys } from "./hooks/use-self-service-keys";
import type { CredentialOperations } from "./hooks/use-credential-operations";
import type { ConsoleRequest } from "./dashboard-fetch";
import type { CapturedSessionScope } from "./session-scope";
import { installAutoRefresh } from "./auto-refresh";
import { demo } from "./ui-config";
import { oauthCallbackStatus, settled, usagePolicyId } from "./ui-helpers";
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

export function useConsoleController({ session, credentialOwner, request, scope, verifySession }: {
  session: ReturnType<typeof useSession> & { setValue: (value: SessionResponse) => void };
  credentialOwner: CredentialOperations;
  request: ConsoleRequest;
  scope: CapturedSessionScope;
  verifySession: () => Promise<SessionResponse | null>;
}) {
  const catalog = useCatalog(session.demoMode);
  const usage = useUsage(session.demoMode, request);
  const refreshPromiseRef = useRef<Promise<void> | null>(null);
  const refreshBackgroundRef = useRef(false);
  const catalogLoadedRef = useRef(false);
  const initialSession = useRef<SessionResponse | null>(session.value);
  const refreshRef = useRef<(options?: RefreshOptions) => Promise<void>>(async () => undefined);
  const refreshCurrent = useCallback(() => refreshRef.current(), []);
  const refreshMetadataAfterMutation = useCallback(async (ownsScope: () => boolean) => {
    // The current read may predate the mutation and fail its resource hydration fence.
    await refreshPromiseRef.current;
    if (ownsScope()) await refreshRef.current({ background: true });
  }, []);
  const selfServiceKeys = useSelfServiceKeys(credentialOwner);
  const access = useAccessAdmin({
    credentialOwner,
    request,
    isCurrent: scope.isCurrent,
    allowDemo: session.demoMode,
    gatewayOrigin: session.gatewayOrigin,
    session: session.value,
    demoMode: session.demoMode,
    providers: catalog.providers,
    routes: catalog.routes,
    setStatus: session.setStatus,
    setProviderReadiness: catalog.setProviderReadiness,
    refresh: refreshCurrent,
    refreshUpstreamMetadata: refreshMetadataAfterMutation,
    refreshPolicyMetadata: async () => {
      if (!scope.isCurrent()) return;
      // Retire pre-commit ledger reads before waiting for metadata already in flight.
      usage.invalidate();
      await refreshMetadataAfterMutation(scope.isCurrent);
    },
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
    if (session.demoMode) {
      if (session.value.role === "user") loadUserDemo();
      else loadAdminDemo();
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
    if (!scope.isCurrent()) return Promise.resolve();
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
    const publishStatus = background ? null : session.captureStatusPublisher();
    if (!background) {
      session.setRefreshing(true);
      access.setLoaded(false);
    }
    // Invalidate before reads begin so later navigation keeps its new ledger read.
    if (!background || (session.view !== "home" && session.view !== "usage" && !usage.error)) usage.invalidate();
    const failUsageRefresh = usage.captureRefreshFailure();
    const keySnapshot = credentialOwner.captureHydration();
    const policySnapshot = access.capturePolicyHydration();
    const upstreamSnapshot = access.captureUpstreamHydration();
    try {
      const staticCatalog = catalogLoadedRef.current
        ? Promise.resolve({ providerData: { providers: catalog.providers }, routeData: catalog.routes })
        : Promise.all([
          request<ProviderResponse>(session.gatewayOrigin, "/v1/providers"),
          request<RouteCatalog>(session.gatewayOrigin, "/v1/routes"),
      ]).then(([providerData, routeData]) => ({ providerData, routeData }));
      const sessionRead = initialSession.current ? Promise.resolve(initialSession.current) : verifySession();
      initialSession.current = null;
      const [sessionData, { providerData, routeData }] = await Promise.all([
        sessionRead,
        staticCatalog,
      ]);
      if (!sessionData || !scope.isCurrent()) return;
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
        const entitlementResult = await settled(() => request<EntitlementsResponse>(session.gatewayOrigin, "/v1/entitlements"));
        if (entitlementResult.ok) catalog.setEntitlements(entitlementResult.value);
        else {
          catalog.setEntitlements(null);
          warnings = [...warnings, `entitlements unavailable: ${entitlementResult.error}`];
        }
      }
      // Entitlement waits cannot adopt a credential scope invalidated by another read.
      if (!scope.isCurrent()) return;
      const result = sessionData.role === "admin"
        ? await loadAdminData(sessionData, providerData, background, warnings, keySnapshot, policySnapshot, upstreamSnapshot)
        : await loadUserData(sessionData, warnings, keySnapshot);
      if (!scope.isCurrent()) return;
      session.setRefreshError(result.warnings.join("; "));
      if (result.complete) session.setLastUpdatedAt(Date.now());
      publishStatus?.(oauthCallbackStatus() ?? "connected");
    } catch (caught) {
      if (!scope.isCurrent()) return;
      const message = errorMessage(caught);
      // Refresh health is separate from the mutation result that the caller reports.
      session.setRefreshError(`Console data refresh failed: ${message}`);
      failUsageRefresh(`Usage was not refreshed: ${message}`);
    } finally {
      if (!background) session.setRefreshing(false);
    }
  }

  async function loadAdminData(sessionData: SessionResponse, providerData: ProviderResponse, background: boolean, initialWarnings: string[], keySnapshot: number, policySnapshot: number | null, upstreamSnapshot: number | null) {
    let warnings = initialWarnings;
    const [data, sessionUsageResult, sessionCredentialsResult] = await Promise.all([
      request<AdminBootstrapResponse>(session.gatewayOrigin, "/v1/admin/bootstrap"),
      settled(() => request<{ policies: AdminUsageRow[] }>(session.gatewayOrigin, "/v1/session/usage")),
      settled(() => request<{ credentials: AdminBootstrapResponse["credentials"] }>(session.gatewayOrigin, "/v1/session/credentials")),
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
    }, background, sessionData, providerData.providers, keySnapshot, policySnapshot, upstreamSnapshot);
    catalog.mergeReadiness(data.providers);
    usage.setAdminOverview(data.overview);
    usage.setTenantSummaries(data.tenants);
    if (sessionUsageResult.ok && sessionCredentialsResult.ok) credentialOwner.hydrate("personal", sessionCredentialsResult.value.credentials, keySnapshot, sessionUsageResult.value.policies.filter((policy) => policy.enabled).map(usagePolicyId));
    else warnings = [...warnings, "personal credentials unavailable"];
    const includeUsage = session.view === "home" || session.view === "usage" || Boolean(usage.error);
    const usageFresh = includeUsage ? await usage.refreshLedger(session.gatewayOrigin) : true;
    return { warnings, complete: !warnings.length && usageFresh };
  }

  async function loadUserData(sessionData: SessionResponse, initialWarnings: string[], keySnapshot: number) {
    let warnings = initialWarnings;
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
      settled(() => request<{ policies: AdminUsageRow[]; usage: UsageSnapshot }>(session.gatewayOrigin, "/v1/session/usage")),
      settled(() => request<{ credentials: AdminBootstrapResponse["credentials"] }>(session.gatewayOrigin, "/v1/session/credentials")),
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
  }

  function navigateTo(...args: Parameters<typeof session.navigateTo>) {
    if (args[0] !== session.view) credentialOwner.invalidatePresentation();
    session.navigateTo(...args);
  }

  return { session: { ...session, navigateTo }, catalog, access, usage, selfServiceKeys, credentialOwner, playground, request, refresh, refreshMetadataAfterMutation };
}

export type ConsoleController = ReturnType<typeof useConsoleController>;
