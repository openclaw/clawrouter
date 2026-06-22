export function UserAvatar({ email }: { email?: string | null }) {
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    setLoaded(false);
  }, [email]);

  return (
    <span className={`contextIcon${loaded ? " contextIconLoaded" : ""}`}>
      <ShieldCheck aria-hidden="true" />
      {email ? <img src="/v1/session/avatar" alt="" loading="lazy" decoding="async" onLoad={() => setLoaded(true)} onError={() => setLoaded(false)} /> : null}
    </span>
  );
}

export function DashboardScreen({ session, services, policies, credentials, users, tenants, overview, usageRows, usage, usageLoaded, onOpenCatalog, onOpenPlayground, onOpenUsage, onOpenAccess }: {
  session: SessionResponse;
  services: ServiceItem[];
  policies: AccessPolicy[];
  credentials: ProxyCredential[];
  users: AccessUser[];
  tenants: AdminTenantSummary[];
  overview: AdminOverview | null;
  usageRows: AdminUsageRow[];
  usage: UsageSnapshot;
  usageLoaded: boolean;
  onOpenCatalog: () => void;
  onOpenPlayground: () => void;
  onOpenUsage: () => void;
  onOpenAccess: () => void;
}) {
  const isAdmin = session.role === "admin";
  const grantedServices = services.filter((service) => service.access?.allowed);
  const visibleServices = isAdmin ? services : grantedServices;
  const usableServices = grantedServices.filter((service) => serviceOutcome(service).playable);
  const configuredServices = services.filter((service) => service.readiness?.executable);
  const attentionServices = visibleServices.filter((service) => !serviceOutcome(service).playable);
  const rows = (usageRows.length ? usageRows : isAdmin ? policies.map(policyUsageFallback) : []).filter((row) => row.enabled);
  const successRate = usage.summary.requestCount ? Math.round((usage.summary.successCount / usage.summary.requestCount) * 100) : 100;
  const servicePercent = isAdmin
    ? services.length ? Math.round((configuredServices.length / services.length) * 100) : 0
    : grantedServices.length ? Math.round((usableServices.length / grantedServices.length) * 100) : 0;
  const providerMaximum = Math.max(1, ...usage.providers.map((provider) => provider.requestCount));
  const displayName = session.email?.split("@")[0] ?? (isAdmin ? "operator" : "member");
  const activePolicies = policies.filter((policy) => policy.enabled).length;
  const activeCredentials = credentials.filter((credential) => credential.enabled && credential.active !== false).length;

  return (
    <div className="dashboardCanvas">
      <section className={`dashboardHero ${isAdmin ? "admin" : "member"}`}>
        <div className="heroCopy">
          <span className="heroEyebrow">{isAdmin ? "gateway operations" : "personal access"} · {session.tenantId ?? "default"}</span>
          <h2>{isAdmin ? "Every route, budget, and identity—under control." : `Your services are ready, ${displayName}.`}</h2>
          <p>{isAdmin ? "Live posture across the complete gateway. Drill into access or usage when a signal needs attention." : "See what you can call, how healthy it is, and the shared quota pools backing your access."}</p>
          <div className="heroActions">
            <button type="button" onClick={onOpenCatalog}>Explore services <ArrowUpRight aria-hidden="true" /></button>
            <button type="button" className="heroButtonSecondary" onClick={onOpenPlayground}><Play aria-hidden="true" /> Open playground</button>
          </div>
        </div>
        <div className="heroMeters" aria-label="gateway status summary">
          <RadialMeter label={isAdmin ? "configured" : "usable"} value={isAdmin ? configuredServices.length : usableServices.length} total={isAdmin ? services.length : grantedServices.length} tone="green" />
          <RadialMeter label="success" value={successRate} total={100} suffix="%" tone={successRate >= 95 ? "green" : "amber"} />
          <RadialMeter label="requests" value={usage.summary.requestCount} total={Math.max(usage.summary.requestCount, 100)} display={formatCount(usage.summary.requestCount)} tone="blue" />
        </div>
      </section>

      <section className="dashboardStats" aria-label="access overview">
        <DashboardStat label={isAdmin ? "catalog coverage" : "available services"} value={isAdmin ? `${configuredServices.length}/${services.length}` : String(grantedServices.length)} note={isAdmin ? `${services.length - configuredServices.length} need attention` : `${usableServices.length} ready to call`} />
        <DashboardStat label="shared activity" value={formatCount(usage.summary.totalTokens)} note={`${formatCount(usage.summary.requestCount)} requests · ${successRate}% success`} />
        <DashboardStat label={isAdmin ? "active policies" : "quota pools"} value={String(isAdmin ? overview?.policiesActive ?? activePolicies : rows.length)} note={isAdmin ? `${overview?.tenantsTotal ?? tenants.length} tenants` : usageLoaded ? "live policy ledgers" : "status unavailable"} />
        <DashboardStat label="actual spend" value={formatMicros(usage.summary.actualCostMicros)} note={isAdmin ? `${usage.providers.length} active providers` : "across your policy pools"} />
      </section>

      <div className="dashboardGrid">
        <section className="dashboardPanel servicePanel">
          <DashboardPanelHeader eyebrow={isAdmin ? "service estate" : "your access"} title={isAdmin ? "Provider readiness" : "Services you can use"} meta={`${isAdmin ? configuredServices.length : usableServices.length} ready`} action="View catalog" onAction={onOpenCatalog} />
          <div className="serviceSpectrum" role="img" aria-label={`${servicePercent}% of ${isAdmin ? "catalog services are configured" : "granted services are usable"}`}>
            <span className="serviceSpectrumReady" style={{ width: `${servicePercent}%` }} />
            <span className="serviceSpectrumBlocked" style={{ width: `${100 - servicePercent}%` }} />
          </div>
          <div className="dashboardServiceGrid">
            {visibleServices.slice(0, isAdmin ? 10 : 8).map((service, index) => {
              const outcome = serviceOutcome(service);
              return (
                <article className={`dashboardService ${outcome.playable ? "ready" : "attention"}`} key={service.id} style={{ "--reveal": `${index * 35}ms` } as React.CSSProperties}>
                  <span className="dashboardServiceMark"><BrandMark brandIcon={service.brandIcon} fallback={kindIcon(service.kind)} /></span>
                  <span><strong>{service.name}</strong><small>{kindLabel(service.kind)} · {outcome.detail}</small></span>
                  <Status label={outcome.label} tone={outcome.tone} />
                </article>
              );
            })}
            {!visibleServices.length ? <div className="dashboardEmpty"><CircleSlash2 aria-hidden="true" /><strong>No services assigned</strong><p>Ask an administrator to bind a service policy to your identity or group.</p></div> : null}
          </div>
          {visibleServices.length > (isAdmin ? 10 : 8) ? <button className="dashboardTextAction" type="button" onClick={onOpenCatalog}>Show {visibleServices.length - (isAdmin ? 10 : 8)} more services <ChevronRight aria-hidden="true" /></button> : null}
        </section>

        <section className="dashboardPanel quotaPanel">
          <DashboardPanelHeader eyebrow="policy budgets" title={isAdmin ? "Budget posture" : "Your shared quotas"} meta={usageLoaded ? "live ledger" : "policy fallback"} />
          <p className="panelIntro">{isAdmin ? "Spend and remaining capacity across active policies." : "Your requests draw from these shared policy pools; totals may include activity from teammates on the same policy."}</p>
          <div className="quotaList">
            {rows.slice(0, 6).map((row) => {
              const percent = budgetPercent(row);
              const limit = row.budget.limitMicros ?? row.monthlyBudgetMicros;
              const remaining = row.budget.remainingMicros;
              return (
                <article className="quotaRow" key={usagePolicyId(row)}>
                  <RadialMeter label="used" value={percent ?? 0} total={100} suffix="%" display={percent === null ? limit === undefined || limit === null ? "∞" : "—" : `${Math.round(percent)}%`} compact tone={percent !== null && percent >= 90 ? "amber" : "green"} />
                  <span className="quotaIdentity"><strong>{usagePolicyId(row)}</strong><small>{row.tokenRole ?? "custom"} · {effectiveProviderCount(row.providers, services)} services</small></span>
                  <span className="quotaNumbers"><strong>{remaining === undefined || remaining === null ? formatBudget(limit) : formatMicros(remaining)}</strong><small>{remaining === undefined || remaining === null ? "monthly limit" : `remaining of ${formatBudget(limit)}`}</small></span>
                </article>
              );
            })}
            {!rows.length ? <div className="dashboardEmpty"><Activity aria-hidden="true" /><strong>No quota pools assigned</strong><p>Usage will appear when an access policy is bound to your account.</p></div> : null}
          </div>
          {isAdmin ? <button className="dashboardTextAction" type="button" onClick={onOpenUsage}>Open full usage ledger <ChevronRight aria-hidden="true" /></button> : null}
        </section>

        <section className="dashboardPanel activityPanel">
          <DashboardPanelHeader eyebrow="traffic shape" title="Provider activity" meta={`${usage.providers.length} active`} />
          <div className="activityDiagram">
            {usage.providers.slice(0, 7).map((provider) => {
              const service = services.find((candidate) => candidate.provider === provider.provider);
              const width = Math.max(4, Math.round((provider.requestCount / providerMaximum) * 100));
              return <div className="activityBar" key={provider.provider}><EntityName brandIcon={service?.brandIcon} icon={ServerCog} title={service?.name ?? provider.provider} subtitle={`${formatCount(provider.totalTokens)} tokens`} /><span className="activityTrack"><span style={{ width: `${width}%` }} /></span><strong>{formatCount(provider.requestCount)}</strong></div>;
            })}
            {!usage.providers.length ? <div className="dashboardEmpty"><BarChart3 aria-hidden="true" /><strong>No activity yet</strong><p>Provider traffic will build this diagram as requests pass through the gateway.</p></div> : null}
          </div>
        </section>

        {isAdmin ? (
          <section className="dashboardPanel operationsPanel">
            <DashboardPanelHeader eyebrow="administration" title="Control plane" meta={`${attentionServices.length} signals`} action="Manage access" onAction={onOpenAccess} />
            <div className="operationsDiagram">
              <div><span>identities</span><strong>{users.length}</strong><small>{users.filter((user) => user.enabled).length} enabled</small></div>
              <div><span>credentials</span><strong>{activeCredentials}</strong><small>{credentials.length} provisioned</small></div>
              <div><span>tenants</span><strong>{overview?.tenantsTotal ?? tenants.length}</strong><small>{overview?.policiesTotal ?? policies.length} policies</small></div>
              <div className={attentionServices.length ? "needsAttention" : "healthy"}><span>service alerts</span><strong>{attentionServices.length}</strong><small>{attentionServices.length ? "configuration required" : "all clear"}</small></div>
            </div>
            <div className="operationsFooter"><ShieldCheck aria-hidden="true" /><span><strong>Access boundary active</strong><small>Identity, policy, quota, then provider</small></span></div>
          </section>
        ) : null}
      </div>
    </div>
  );
}

export function DashboardPanelHeader({ eyebrow, title, meta, action, onAction }: { eyebrow: string; title: string; meta: string; action?: string; onAction?: () => void }) {
  return <header className="dashboardPanelHeader"><div><span>{eyebrow}</span><h2>{title}</h2></div>{action && onAction ? <button type="button" onClick={onAction}>{action}<ArrowUpRight aria-hidden="true" /></button> : <small>{meta}</small>}</header>;
}

export function DashboardStat({ label, value, note }: { label: string; value: string; note: string }) {
  return <div><span>{label}</span><strong>{value}</strong><small>{note}</small></div>;
}

export function RadialMeter({ label, value, total, display, suffix = "", compact = false, tone }: { label: string; value: number; total: number; display?: string; suffix?: string; compact?: boolean; tone: "green" | "amber" | "blue" }) {
  const percent = total > 0 ? Math.min(100, Math.max(0, (value / total) * 100)) : 0;
  const shown = display ?? (suffix ? `${Math.round(value)}${suffix}` : `${formatCount(value)}/${formatCount(total)}`);
  return <div className={`radialMeter ${compact ? "compact" : ""} ${tone}`} style={{ "--meter": `${percent}%` } as React.CSSProperties} aria-label={`${label}: ${shown}`}><div><strong>{shown}</strong><span>{label}</span></div></div>;
}

export function CatalogScreen({ services, allServices, selected, policies, connections, query, setQuery, kind, setKind, kinds, canAdminister, onSelect, onSetConnection, onPlay, onAdd }: {
  services: ServiceItem[];
  allServices: ServiceItem[];
  selected?: ServiceItem;
  policies: AccessPolicy[];
  connections: ProviderConnection[];
  query: string;
  setQuery: (value: string) => void;
  kind: string;
  setKind: (value: string) => void;
  kinds: string[];
  canAdminister: boolean;
  onSelect: (service: ServiceItem) => void;
  onSetConnection: (providerId: string, enabled: boolean) => void;
  onPlay: (service: ServiceItem) => void;
  onAdd: (service: ServiceItem) => void;
}) {
  const activePolicies = policies.filter((policy) => policy.enabled);
  const queryMatchedServices = allServices.filter((service) => matchesServiceQuery(service, query));
  const selectedPolicies = selected ? activePolicies.filter((policy) => policyCoversProvider(policy, selected.provider)) : [];
  const connectionByProvider = new Map(connections.map((connection) => [connection.providerId, connection]));
  const kindCounts = new Map(kinds.map((item) => [item, item === "all" ? queryMatchedServices.length : queryMatchedServices.filter((service) => service.kind === item).length]));
  const servicePolicies = (service: ServiceItem) => activePolicies.filter((policy) => policyCoversProvider(policy, service.provider));
  const outcomes = allServices.map((service) => serviceOutcome(service));
  const usableCount = outcomes.filter((outcome) => outcome.playable).length;
  const grantedCount = allServices.filter((service) => service.access?.allowed).length;
  const blockedCount = outcomes.filter((outcome) => outcome.blocked).length;

  return (
    <div className="entityLayout">
      <section className="mainPane">
        <div className="catalogControls">
          <div className="catalogMeta"><strong>{services.length} services</strong><span>{usableCount} usable · {grantedCount} granted · {blockedCount} blocked</span></div>
          <label><span>search catalog</span><div className="inputWithIcon"><Search aria-hidden="true" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="service, provider, model, route" /></div></label>
          <div className="kindTabs" role="tablist" aria-label="service kind">
            {kinds.map((item) => <button key={item} type="button" className={kind === item ? "active" : ""} onClick={() => setKind(item)}>{kindLabel(item)}<span>{kindCounts.get(item) ?? 0}</span></button>)}
          </div>
        </div>
        <EntityTable
          columns={["service", "your access", "connection", "policies", "kind"]}
          columnTemplate="minmax(220px, 1.45fr) 124px 126px minmax(130px, 0.8fr) 116px"
          rows={services.map((service) => {
            const policiesForService = servicePolicies(service);
            const outcome = serviceOutcome(service);
            return {
              id: service.id,
              active: selected?.id === service.id,
              onClick: () => onSelect(service),
              cells: [
                <EntityName brandIcon={service.brandIcon} icon={kindIcon(service.kind)} title={service.name} subtitle={`${service.provider} · ${kindLabel(service.kind)}`} />,
                <Status label={service.access?.allowed ? "granted" : service.access ? "not granted" : "unknown"} tone={service.access?.allowed ? "active" : service.access ? "revoked" : "neutral"} />,
                <ReadinessStatus readiness={service.readiness} />,
                <GrantChips names={grantNamesForService(service, policiesForService)} />,
                kindLabel(service.kind),
              ],
            };
          })}
        />
      </section>
      <aside className="inspector">
        {selected ? (
          <>
            {(() => {
              const outcome = serviceOutcome(selected);
              const playBlocker = playgroundBlockedForService(selected);
              const connection = connectionByProvider.get(selected.provider);
              const connectionEnabled = connection?.enabled ?? selected.readiness?.connectionEnabled;
              return (
                <>
            <InspectorHeader brandIcon={selected.brandIcon} icon={kindIcon(selected.kind)} title={selected.name} subtitle={`${kindLabel(selected.kind)} · ${selected.category}`} />
            <div className={`outcomeCallout ${outcome.tone}`}>
              <OutcomeStatus outcome={outcome} />
              <p>{outcome.detail}</p>
            </div>
            <dl className="facts">
              <dt>provider</dt><dd>{selected.provider}</dd>
              <dt>kind</dt><dd>{kindLabel(selected.kind)}</dd>
              <dt>routes</dt><dd>{selected.route}</dd>
              <dt>surfaces</dt><dd>{selected.surfaces.join(", ")}</dd>
              <dt>policies</dt><dd>{grantNamesForService(selected, selectedPolicies).join(", ") || "none"}</dd>
              <dt>connection</dt><dd>{connectionEnabled === false ? "disabled" : connectionEnabled === true ? "enabled" : "unknown"}</dd>
              <dt>readiness</dt><dd>{readinessLabel(selected.readiness)}</dd>
              <dt>verified</dt><dd>{selected.readiness?.lastCheckedAt ? `${formatRelativeTime(selected.readiness.lastCheckedAt)} · ${formatDuration(selected.readiness.latencyMs)}` : "not checked"}</dd>
              <dt>missing</dt><dd>{selected.readiness?.missingConfig.length ? selected.readiness.missingConfig.join(", ") : "none"}</dd>
              <dt>oauth grants</dt><dd>{selected.readiness?.oauthGrantRequired ? selected.readiness.oauthGrantCount : "n/a"}</dd>
            </dl>
            {selected.readiness?.reasons.length ? <InlineNote>{selected.readiness.reasons.join("; ")}</InlineNote> : null}
            <div className="sectionTitle">Policies including this service</div>
            <div className="miniList">
              {grantNamesForService(selected, selectedPolicies).length ? grantNamesForService(selected, selectedPolicies).map((policyId) => <button key={policyId} type="button">{policyId}<span>{selectedPolicies.find((policy) => policy.policyId === policyId)?.tenantId ?? "identity policy"}</span></button>) : <p>No active policy includes this service yet.</p>}
            </div>
            <div className="inspectorActions">
              <button type="button" disabled={Boolean(playBlocker)} onClick={() => onPlay(selected)} title={playBlocker ?? undefined}><Play className="buttonIcon" aria-hidden="true" /><span>Try in playground</span></button>
              {canAdminister ? <button type="button" className={connectionEnabled === false ? "buttonSecondary" : "buttonDanger"} onClick={() => onSetConnection(selected.provider, connectionEnabled === false)}><ServerCog className="buttonIcon" aria-hidden="true" /><span>{connectionEnabled === false ? "Enable connection" : "Disable connection"}</span></button> : null}
              {canAdminister ? <button type="button" className="buttonSecondary" onClick={() => onAdd(selected)}><Plus className="buttonIcon" aria-hidden="true" /><span>Add to selected policy</span></button> : null}
            </div>
                </>
              );
            })()}
          </>
        ) : <p>Select a service.</p>}
      </aside>
    </div>
  );
}

export function GrantChips({ names }: { names: string[] }) {
  if (!names.length) return <span className="emptyGrant">no policy</span>;
  const first = names[0];
  return (
    <span className="grantChips">
      <span className="grantChip" title={first}>{first}</span>
      {names.length > 1 ? <span className="grantMore" title={names.slice(1).join(", ")}>+{names.length - 1}</span> : null}
    </span>
  );
}
import React, { useEffect, useState } from "react";
import { Activity, ArrowUpRight, BarChart3, Boxes, Bug, CheckCircle2, ChevronRight, CircleSlash2, FlaskConical, Play, Plus, Search, ServerCog, ShieldCheck, SlidersHorizontal, Users } from "lucide-react";
import { grantNamesForService, playgroundBlockedForService, policyCoversProvider, policyUsageFallback, readinessLabel, serviceOutcome } from "../domain";
import { BrandMark, EntityName, InlineNote, InspectorHeader, OutcomeStatus, PanelTitle, ReadinessStatus, Status, kindIcon, kindLabel } from "../components";
import { budgetPercent, effectiveProviderCount, formatBudget, formatCount, formatDuration, formatMicros, formatRelativeTime, matchesServiceQuery, providerBrandIcon, readyCount, usagePolicyId } from "../ui-helpers";
import { EntityTable } from "./users-usage";
import type { AccessForm,AccessPolicy,AccessRole,AccessTab,AccessUser,AdminOverview,AdminTenantSummary,AdminUsageRow,AssignmentRule,AssignmentRuleForm,BindingForm,BrandIcon,BudgetStatus,ContentRetention,CredentialForm,EntitlementsResponse,IconComponent,OutcomeTone,PlaygroundForm,PlaygroundHttpResponse,PlaygroundTurn,PolicyBinding,PolicyForm,ProviderAccess,ProviderConnection,ProviderReadiness,ProviderResponse,ProviderRow,ProviderUsageSummary,ProxyCredential,RefreshOptions,RetainedRequestContent,RouteCatalog,ServiceItem,ServiceOutcome,SessionResponse,UpstreamGrant,UpstreamGrantForm,UsageAuditEvent,UsageSnapshot,UsageSummary,View } from "../ui-types";
