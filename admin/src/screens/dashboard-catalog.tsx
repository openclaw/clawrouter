import { GrantPoolIncidents } from "../grant-health";
import { MemberGrantedService } from "./member-granted-service";
import { credentialExpiryLabel, KeyTierControls, keyTierChoices } from "../member-key-controls";
import type { SessionPolicyLimits } from "../../../shared/contracts";
import React, { useEffect, useState } from "react";
import {
  Activity,
  ArrowUpRight,
  ChevronRight,
  CircleSlash2,
  KeyRound,
  Play,
  Plus,
  Search,
  ServerCog,
  ShieldCheck,
} from "lucide-react";
import {
  grantNamesForService,
  kindLabel,
  playgroundBlockedForService,
  policyCoversProvider,
  policyUsageFallback,
  readinessLabel,
  serviceOutcome,
} from "../domain";
import {
  BrandMark,
  EntityName,
  EntityTable,
  InlineNote,
  InspectorHeader,
  MiniListItem,
  OutcomeStatus,
  ReadinessStatus,
  Status,
  kindIcon,
} from "../components";
import { formatConfiguredLimit, presentAccountedSpend, presentAllowanceWindows, presentPolicyBudget, presentProviderBudget } from "../cost-presentation";
import { dollarInputFromMicros, policyBudgetMicros } from "../request-price-input";
import { ProviderUsageChart, TrafficAreaChart, UsageFreshness } from "../analytics-charts";
import {
  catalogPlaygroundTarget,
  type CatalogModel,
  effectiveProviderCount,
  formatCount,
  formatDuration,
  formatRelativeTime,
  matchesServiceQuery,
  usagePolicyId,
} from "../ui-helpers";
import { CredentialNotice, type CredentialFeedback } from "../credential-notice";
import type {
  AccessPolicy,
  UpstreamGrant,
  AccessUser,
  AdminOverview,
  AdminTenantSummary,
  AdminUsageRow,
  ProviderConnection,
  ProviderReadiness,
  ProxyCredential,
  PlaygroundForm,
  RouteCatalog,
  ServiceItem,
  SessionResponse,
  UsageSnapshot,
} from "../ui-types";

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

export function DashboardScreen({ personalUsageSummary, grants, grantsReady, grantsError, onOpenGrant, session, services, gatewayReadiness, policies, credentials, users, tenants, overview, usageRows, usage, usageLoaded, usageStale, usageError, usageUpdatedAt, myCredentials, myPolicyLimits, myPolicyIds, myKeyFeedback, myKeyScope, myKeysBusy, onMyKeyDraftChange, onIssueMyKey, onRevokeMyKey, onRenameMyKey, onOpenCatalog, onOpenPlayground, onOpenUsage, onOpenAccess }: {
  personalUsageSummary?: React.ReactNode;
  grants: UpstreamGrant[];
  grantsReady: boolean;
  grantsError: string;
  onOpenGrant: (grant: UpstreamGrant) => void;
  session: SessionResponse;
  services: ServiceItem[];
  gatewayReadiness: Readonly<Record<string, ProviderReadiness>>;
  policies: AccessPolicy[];
  credentials: ProxyCredential[];
  users: AccessUser[];
  tenants: AdminTenantSummary[];
  overview: AdminOverview | null;
  usageRows: AdminUsageRow[];
  usage: UsageSnapshot;
  usageLoaded: boolean;
  usageStale: boolean;
  usageError: string;
  usageUpdatedAt: number | null;
  myCredentials: ProxyCredential[];
  myPolicyIds: string[];
  myKeyFeedback: CredentialFeedback;
  myKeyScope: number;
  onMyKeyDraftChange: () => void;
  myKeysBusy: boolean;
  myPolicyLimits?: SessionPolicyLimits[];
  onIssueMyKey: (policyId: string, credentialId?: string, options?: { days: number; serviceTiers: string[]; name?: string }) => Promise<void>;
  onRevokeMyKey: (credentialId: string) => Promise<void>;
  onRenameMyKey: (credentialId: string, name: string) => Promise<boolean>;
  onOpenCatalog: () => void;
  onOpenPlayground: () => void;
  onOpenUsage: () => void;
  onOpenAccess: () => void;
}) {
  const isAdmin = session.role === "admin";
  // Admin bootstrap can replace catalog readiness, but not this identity's eligible routes.
  const serviceAccess = services.map((service) => ({ service, outcome: serviceOutcome({ ...service, readiness: service.access?.readiness }) }));
  const grantedServices = serviceAccess.filter(({ service }) => service.access?.allowed);
  const visibleServices = isAdmin ? serviceAccess : grantedServices;
  const usableCount = grantedServices.filter(({ outcome }) => outcome.playable).length;
  const accessIncomplete = services.some((service) => !service.access);
  const unknownAccess = accessIncomplete && grantedServices.length === 0;
  const executableCount = services.filter((service) => gatewayReadiness[service.provider]?.executable).length;
  const blockedCount = services.filter((service) => gatewayReadiness[service.provider]?.executable === false).length;
  const catalogReadinessKnown = executableCount + blockedCount > 0;
  const unknownReadinessCount = services.length - executableCount - blockedCount;
  const scopeNote = accessIncomplete ? " · partial" : "";
  const accessMeta = isAdmin ? `${services.length} in catalog` : unknownAccess ? "Access unknown" : `${usableCount} of ${grantedServices.length} usable${scopeNote}`;
  const rows = (usageRows.length ? usageRows : isAdmin ? policies.map(policyUsageFallback) : []).filter((row) => row.enabled);
  // Only administrators can continue to the full usage ledger.
  const visibleBudgetRows = isAdmin ? rows.slice(0, 6) : rows;
  const successRate = usage.summary.requestCount ? Math.round((usage.summary.successCount / usage.summary.requestCount) * 100) : null;
  const displayName = session.email?.split("@")[0] ?? (isAdmin ? "operator" : "member");
  const activePolicies = policies.filter((policy) => policy.enabled).length;
  const activeCredentials = credentials.filter((credential) => credential.enabled && credential.active !== false).length;
  const spend = presentAccountedSpend(usage.summary);

  return (
    <div className="dashboardCanvas">
      <header className="dashboardOverviewHeader">
        <div>
          <span className="dashboardEyebrow">{isAdmin ? "Gateway overview" : "Personal access"} · {session.tenantId ?? "default"}</span>
          <h2>{isAdmin ? "Routing and access at a glance" : `Your gateway, ${displayName}`}</h2>
          <p>{isAdmin ? "Thirty-day traffic, provider health, and shared policy budgets in one operational view." : "See the services you can call, their current health, and the shared quotas behind your access."}</p>
        </div>
        <div className="dashboardOverviewActions">
          <button type="button" className="buttonSecondary" onClick={onOpenCatalog}>View catalog <ArrowUpRight aria-hidden="true" /></button>
          <button type="button" onClick={onOpenPlayground}><Play aria-hidden="true" /> Open playground</button>
        </div>
      </header>

      {isAdmin ? <GrantPoolIncidents policies={policies} grants={grants} ready={grantsReady} error={grantsError} onOpenGrant={onOpenGrant} /> : null}
      {isAdmin ? <>
      <UsageFreshness loaded={usageLoaded} stale={usageStale} error={usageError} updatedAt={usageUpdatedAt} />
      <section className="dashboardStats" aria-label="access overview">
        <DashboardStat label="Catalog readiness" value={catalogReadinessKnown ? `${executableCount}/${services.length}` : "—"} note={!catalogReadinessKnown ? "Readiness unavailable" : unknownReadinessCount ? `Executable services · ${unknownReadinessCount} unknown` : "Executable services in the catalog"} />
        <DashboardStat label="requests" value={usageLoaded ? formatCount(usage.summary.requestCount) : "—"} note={usageLoaded ? `${formatCount(usage.summary.totalTokens)} tokens in 30 days` : "Usage unavailable"} />
        <DashboardStat label="success rate" value={successRate === null ? "—" : `${successRate}%`} note={!usageLoaded ? "Usage unavailable" : successRate === null ? "No requests in this period" : `${formatCount(usage.summary.successCount)} successful`} />
        <DashboardStat label="active policies" value={String(overview?.policiesActive ?? activePolicies)} note={`${overview?.tenantsTotal ?? tenants.length} tenants`} />
        <DashboardStat label={spend.label} value={usageLoaded ? spend.value : "—"} note={usageLoaded ? `Last 30 days · ${spend.note}` : "Usage unavailable"} />
      </section>

      <div className="dashboardAnalyticsGrid">
        <section className="dashboardPanel dashboardTrafficPanel">
          <DashboardPanelHeader eyebrow="Last 30 days" title="Request activity" meta="UTC daily totals" action="Open usage" onAction={onOpenUsage} />
          <div className="dashboardChartBody">{usageLoaded ? <TrafficAreaChart usage={usage} compact /> : <InlineNote>Request activity unavailable.</InlineNote>}</div>
        </section>
        <section className="dashboardPanel dashboardProviderPanel">
          <DashboardPanelHeader eyebrow="Provider mix" title="Traffic distribution" meta={usageLoaded ? `${usage.providers.length} active` : "unavailable"} />
          {usageLoaded ? <ProviderUsageChart providers={usage.providers} services={services} limit={5} /> : <InlineNote>Provider usage unavailable.</InlineNote>}
        </section>
      </div>

      </> : personalUsageSummary}

      <div className="dashboardGrid">
        <MyKeysCard policies={myPolicyLimits ?? session.entitlements?.policies} key={myKeyScope} credentials={myCredentials} policyIds={myPolicyIds} feedback={myKeyFeedback} onDraftChange={onMyKeyDraftChange} busy={myKeysBusy} onIssue={onIssueMyKey} onRevoke={onRevokeMyKey} onRename={onRenameMyKey} />
        <section className="dashboardPanel servicePanel">
          <DashboardPanelHeader eyebrow={isAdmin ? "Gateway catalog" : "Your access"} title={isAdmin ? "Service access" : "Granted services"} meta={accessMeta} action="View catalog" onAction={onOpenCatalog} />
          {isAdmin && services.length > 0 ? <dl className="dashboardAccessSummary">
            <div><dt>Catalog readiness</dt><dd>{catalogReadinessKnown ? `${executableCount} executable` : "Unknown"}</dd></div>
            <div><dt>Your policy access</dt><dd>{unknownAccess ? "Unknown" : <><strong>{usableCount} usable</strong> <small>of {grantedServices.length} granted{scopeNote}</small></>}</dd></div>
          </dl> : null}
          <div className="dashboardServiceGrid">
            {visibleServices.slice(0, isAdmin ? 10 : 8).map(({ service, outcome }, index) => isAdmin ? (
              <article className="dashboardService" key={service.id} style={{ "--reveal": `${index * 35}ms` } as React.CSSProperties}>
                <span className="dashboardServiceMark"><BrandMark brandIcon={service.brandIcon} fallback={kindIcon(service.kind)} /></span>
                <span><strong>{service.name}</strong><small>{kindLabel(service.kind)} · {outcome.detail}</small></span>
                <Status label={outcome.label} tone={outcome.tone} />
              </article>
            ) : <MemberGrantedService key={service.id} service={service} />)}
            {!visibleServices.length ? <div className="dashboardEmpty">
              <CircleSlash2 aria-hidden="true" />
              <strong>{isAdmin ? "No services in the catalog" : unknownAccess ? "Service access unavailable" : "No services assigned"}</strong>
              {!isAdmin && !unknownAccess ? <p>Ask an administrator to bind a service policy to your identity or group.</p> : null}
            </div> : null}
          </div>
          {visibleServices.length > (isAdmin ? 10 : 8) ? <button className="dashboardTextAction" type="button" onClick={onOpenCatalog}>Show {visibleServices.length - (isAdmin ? 10 : 8)} more services <ChevronRight aria-hidden="true" /></button> : null}
        </section>

        <section className="dashboardPanel quotaPanel">
          <DashboardPanelHeader eyebrow="policy budgets" title={isAdmin ? "Budget posture" : "Your policy budgets"} meta={usageStale && usageLoaded ? "last known ledger" : usageLoaded ? "live ledger" : "policy limits only"} />
          {!isAdmin ? <UsageFreshness loaded={usageLoaded} stale={usageStale} error={usageError} updatedAt={usageUpdatedAt} /> : null}
          <p className="panelIntro">UTC calendar month · Used includes reservations. {isAdmin ? "Balances follow each policy's shared or per-principal scope." : "Shared pools include other users; per-principal balances apply to your identity."} Other policy or provider limits still apply.</p>
          <div className="quotaList">
            {visibleBudgetRows.map((row) => {
              const budget = presentPolicyBudget(row, formatConfiguredLimit);
              return (
                <article className="quotaRow" key={usagePolicyId(row)} title={budget.note}>
                  <span className="quotaIdentity"><strong>{usagePolicyId(row)}</strong><small>{budget.scopeLabel} · {effectiveProviderCount(row.providers, services)} services</small></span>
                  <span className="quotaNumbers"><strong>{budget.remaining}</strong><small>{budget.limit} · {budget.used}</small></span>
                  <span className={`quotaTrack${budget.percent !== null && budget.percent >= 90 ? " warning" : ""}`}><span style={{ width: `${budget.percent ?? 0}%` }} /></span>
                  <strong className="quotaPercent">{budget.percent === null ? "—" : `${Math.round(budget.percent)}%`}</strong>
                </article>
              );
            })}
            {!rows.length ? <div className="dashboardEmpty"><Activity aria-hidden="true" /><strong>{usageLoaded ? "No quota pools assigned" : "Quota status unavailable"}</strong><p>{usageLoaded ? "Usage will appear when an access policy is bound to your account." : "Wait for usage to load, or retry the refresh."}</p></div> : null}
          </div>
          {isAdmin ? <button className="dashboardTextAction" type="button" onClick={onOpenUsage}>Open full usage ledger <ChevronRight aria-hidden="true" /></button> : null}
        </section>

        {isAdmin ? (
          <section className="dashboardPanel operationsPanel">
            <DashboardPanelHeader eyebrow="administration" title="Control plane" meta="Gateway-wide" action="Manage access" onAction={onOpenAccess} />
            <div className="operationsDiagram">
              <div><span>identities</span><strong>{users.length}</strong><small>{users.filter((user) => user.enabled).length} enabled</small></div>
              <div><span>credentials</span><strong>{activeCredentials}</strong><small>{credentials.length} provisioned</small></div>
              <div><span>tenants</span><strong>{overview?.tenantsTotal ?? tenants.length}</strong><small>{overview?.policiesTotal ?? policies.length} policies</small></div>
              <div className={catalogReadinessKnown && blockedCount ? "needsAttention" : undefined}><span>Not executable</span><strong>{catalogReadinessKnown ? blockedCount : "—"}</strong><small>{!catalogReadinessKnown ? "Readiness unavailable" : unknownReadinessCount ? `${unknownReadinessCount} unknown` : "Catalog services"}</small></div>
            </div>
            <div className="operationsFooter"><ShieldCheck aria-hidden="true" /><span><strong>Access boundary active</strong><small>Identity, policy, quota, then provider</small></span></div>
          </section>
        ) : null}
      </div>
    </div>
  );
}

export function MyKeysCard({ policies, credentials, policyIds, feedback, onDraftChange, busy, onIssue, onRevoke, onRename }: {
  credentials: ProxyCredential[];
  policyIds: string[];
  feedback: CredentialFeedback;
  onDraftChange: () => void;
  busy: boolean;
  policies?: SessionPolicyLimits[];
  onIssue: (policyId: string, credentialId?: string, options?: { days: number; serviceTiers: string[]; name?: string }) => Promise<void>;
  onRevoke: (credentialId: string) => Promise<void>;
  onRename: (credentialId: string, name: string) => Promise<boolean>;
}) {
  const [policyId, setPolicyId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [editing, setEditing] = useState<{ credentialId: string; name: string } | null>(null);
  const [days, setDays] = useState(180), [fast, setFast] = useState(true), [ultrafast, setUltrafast] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const keys = feedback.inventory?.keys ?? "ready", held = feedback.inventory?.policies ?? "ready";
  const inventoryReady = keys === "ready" && held === "ready";
  const readFailed = [keys, held].some(state => state === "unavailable" || state === "stale");
  const noPolicy = Boolean(feedback.inventory) && held === "ready" && !policyIds.length;
  const showEditor = !feedback.inventory || ((keys === "ready" || keys === "stale") && policyIds.length > 0);
  const count = `${credentials.filter(credential => credential.enabled).length}/${credentials.length} enabled`;
  const meta = keys === "ready" ? count : keys === "stale" ? `Last known: ${count}` : keys === "loading" ? "Loading" : "Unavailable";
  const readNote = keys === "unavailable" ? "Your keys couldn’t be loaded." : keys === "stale" ? "Your keys couldn’t be refreshed. Showing the last known key list."
    : keys === "loading" ? "Loading your keys…" : held === "unavailable" ? "Your policies couldn’t be loaded." : held === "stale" ? "Your policies couldn’t be refreshed. Showing the last known selection."
    : held === "loading" ? "Loading your policies…" : null;
  async function retry() {
    setRetrying(true);
    try { await feedback.refresh(); } finally { setRetrying(false); }
  }
  const selectedPolicy = policyId ?? policyIds[0] ?? "";
  const policyAvailable = policyIds.includes(selectedPolicy);
  const limits = policies?.find(policy => policy.policyId === selectedPolicy);
  useEffect(() => { if (policyId === null && policyIds.length) setPolicyId(policyIds[0]); }, [policyId, policyIds]);
  return (
    <section className="dashboardPanel myKeysPanel">
      <DashboardPanelHeader eyebrow="personal access" title="My keys" meta={meta} />
      <p className="panelIntro">Create proxy keys bound to your signed-in identity and one of your policies.</p>
      <CredentialNotice state={feedback} />
      {readNote ? <div className="inlineNote" role="status">{readNote}</div> : null}
      {readFailed && !feedback.error ? <button type="button" className="buttonSecondary" disabled={retrying} onClick={() => void retry()}>{retrying ? "Retrying…" : "Retry key access"}</button> : null}
      {noPolicy ? <InlineNote>No policy assigned. Ask an administrator to assign a policy to your identity or group before creating a key.</InlineNote> : null}
      {showEditor ? <><div className="myKeysCreate">
        <label><span>policy</span><select value={selectedPolicy} onChange={(event) => { onDraftChange(); setPolicyId(event.target.value); }} disabled={!policyIds.length}>{!policyAvailable ? <option value={selectedPolicy}>{selectedPolicy ? `${selectedPolicy} · unavailable` : "No policies available"}</option> : null}{policyIds.map((id) => <option key={id} value={id}>{id}</option>)}</select></label>
        <label><span>Name (optional)</span><input value={name} maxLength={80} placeholder="e.g. Studio or laptop" onChange={(event) => { onDraftChange(); setName(event.target.value); }} /></label>
        <button type="button" disabled={!policyAvailable || busy || !inventoryReady} onClick={() => void onIssue(selectedPolicy, undefined, { days, serviceTiers: keyTierChoices(limits, fast, ultrafast), name })}><Plus aria-hidden="true" /> Create key</button>
      </div>
      <div className="myKeysCreate"><label><span>Validity</span><select value={days} onChange={event => { onDraftChange(); setDays(Number(event.target.value)); }}>{[30, 90, 180].map(value => <option key={value} value={value}>{value} days</option>)}</select></label><KeyTierControls policy={limits} fast={fast} ultrafast={ultrafast} onFast={value => { onDraftChange(); setFast(value); }} onUltrafast={value => { onDraftChange(); setUltrafast(value); }} /></div>
      {limits ? presentAllowanceWindows(limits.budget, formatConfiguredLimit).map(window => <p className="panelIntro" key={window.label}>{window.text}</p>) : null}
      {limits?.limitHint ? <p className="panelIntro">{limits.limitHint}</p> : null}</> : null}
      <div className="myKeysList">
        {credentials.map((credential) => <article key={credential.credentialId}>
          <span><strong title={credential.name || credential.credentialId}>{credential.name || credential.credentialId}</strong>{credential.name ? <small title={credential.credentialId}>{credential.credentialId}</small> : null}<small className={credentialExpiryLabel(credential.expiresAt).warning ? "keyExpiryWarning" : undefined}>{credentialExpiryLabel(credential.expiresAt).label}</small><small>{credential.policyId} · {credential.active ? "active" : credential.enabled ? "inactive" : "revoked"}</small>{credential.active && held === "ready" && !policyIds.includes(credential.policyId) ? <small>Policy no longer held: rotation unavailable. This key remains usable and can be revoked.</small> : null}</span>
          {editing?.credentialId === credential.credentialId ? <form className="myKeyRename" onSubmit={(event) => {
            event.preventDefault();
            const draft = editing;
            void onRename(draft.credentialId, draft.name).then((saved) => {
              if (saved) setEditing((current) => current === draft ? null : current);
            });
          }}>
            <label><span>Key name</span><input autoFocus value={editing.name} maxLength={80} readOnly={busy} placeholder="Leave blank to use key ID" onChange={(event) => { onDraftChange(); setEditing({ credentialId: credential.credentialId, name: event.target.value }); }} /></label>
            <button type="submit" disabled={busy || keys !== "ready"}>Save name</button>
            <button type="button" className="buttonSecondary" disabled={busy} onClick={() => { onDraftChange(); setEditing(null); }}>Cancel</button>
          </form> : <span className="myKeyActions"><button type="button" className="buttonSecondary" disabled={busy || keys !== "ready"} onClick={() => { onDraftChange(); setEditing({ credentialId: credential.credentialId, name: credential.name ?? "" }); }}>Rename</button><button type="button" className="buttonSecondary" disabled={busy || !inventoryReady || (!credential.active && !(credential.enabled && credential.expired)) || !policyIds.includes(credential.policyId)} title={held === "ready" && !policyIds.includes(credential.policyId) ? "Policy no longer held; rotation unavailable. Existing active keys remain usable and can be revoked." : !credential.active ? "Only active keys can be rotated" : undefined} onClick={() => void onIssue(credential.policyId, credential.credentialId)}>Renew</button><button type="button" className="buttonDanger" disabled={busy || !credential.enabled} onClick={() => void onRevoke(credential.credentialId)}>Revoke</button></span>}
        </article>)}
        {keys === "ready" && !credentials.length ? <div className="dashboardEmpty"><KeyRound aria-hidden="true" /><strong>No personal keys</strong>{!noPolicy && held === "ready" ? <p>Create one to use your policy from OpenClaw or another API client.</p> : null}</div> : null}
      </div>
    </section>
  );
}

export function DashboardPanelHeader({ eyebrow, title, meta, action, onAction }: { eyebrow: string; title: string; meta: string; action?: string; onAction?: () => void }) {
  return <header className="dashboardPanelHeader"><div><span>{eyebrow}</span><h2>{title}</h2></div><div className="dashboardPanelMeta"><small>{meta}</small>{action && onAction ? <button type="button" onClick={onAction}>{action}<ArrowUpRight aria-hidden="true" /></button> : null}</div></header>;
}

export function DashboardStat({ label, value, note }: { label: string; value: string; note: string }) {
  return <div><span>{label}</span><strong>{value}</strong><small>{note}</small></div>;
}

export function CatalogScreen({ services, allServices, selected, models, serviceRoutes, policies, connections, pendingProviderIds, budgetAttempts, discardBudgetAttempt, query, setQuery, kind, setKind, kinds, canAdminister, onOpenPolicy, onSelect, onSetConnection, onSetProviderBudget, onPlay, onAdd }: {
  services: ServiceItem[];
  allServices: ServiceItem[];
  selected?: ServiceItem;
  models: CatalogModel[];
  serviceRoutes: RouteCatalog["manifestProxy"];
  policies: AccessPolicy[];
  connections: ProviderConnection[];
  pendingProviderIds: ReadonlySet<string>;
  budgetAttempts: ReadonlyMap<string, string>;
  discardBudgetAttempt: (providerId: string) => void;
  query: string;
  setQuery: (value: string) => void;
  kind: string;
  setKind: (value: string) => void;
  kinds: string[];
  canAdminister: boolean;
  onOpenPolicy: (policy: AccessPolicy) => void;
  onSelect: (service: ServiceItem) => void;
  onSetConnection: (providerId: string, enabled: boolean) => void;
  onSetProviderBudget: SaveProviderBudget;
  onPlay: (preset: Partial<PlaygroundForm>) => void;
  onAdd: (service: ServiceItem) => void;
}) {
  const activePolicies = policies.filter((policy) => policy.enabled);
  const searchInput = React.useRef<HTMLInputElement>(null);
  const allKindsButton = React.useRef<HTMLButtonElement>(null);
  const queryMatchedServices = allServices.filter((service) => matchesServiceQuery(service, query));
  const selectedPolicies = selected ? activePolicies.filter((policy) => policyCoversProvider(policy, selected.provider)) : [];
  const connectionByProvider = new Map(connections.map((connection) => [connection.providerId, connection]));
  const kindCounts = new Map(kinds.map((item) => [item, item === "all" ? queryMatchedServices.length : queryMatchedServices.filter((service) => service.kind === item).length]));
  const servicePolicies = (service: ServiceItem) => activePolicies.filter((policy) => policyCoversProvider(policy, service.provider));
  const outcomes = services.map((service) => serviceOutcome(service));
  const usableCount = outcomes.filter((outcome) => outcome.playable).length;
  const grantedCount = services.filter((service) => service.access?.allowed).length;
  const noMatches = allServices.length > 0 && services.length === 0;
  const selectedOutsideFilters = selected && !services.some((service) => service.id === selected.id);
  const blockedCount = outcomes.filter((outcome) => outcome.blocked).length;

  return (
    <div className="entityLayout">
      <section className="mainPane catalogPane">
        <div className="catalogControls">
          <div className="catalogMeta"><strong>{services.length} {services.length === 1 ? "service" : "services"}</strong><span>{usableCount} usable · {grantedCount} granted · {blockedCount} blocked</span></div>
          <label><span>search catalog</span><div className="inputWithIcon"><Search aria-hidden="true" /><input ref={searchInput} name="catalog-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="service, provider, model, route" /></div></label>
          <div className="kindTabs" role="group" aria-label="service kind">
            {kinds.map((item) => <button key={item} ref={item === "all" ? allKindsButton : undefined} type="button" aria-pressed={kind === item} className={kind === item ? "active" : ""} onClick={() => setKind(item)}>{kindLabel(item)}<span>{kindCounts.get(item) ?? 0}</span></button>)}
          </div>
        </div>
        <EntityTable
          columns={["service", "your access", "connection", "policies", "kind"]}
          columnTemplate="minmax(220px, 1.45fr) 124px 126px minmax(130px, 0.8fr) 116px"
          rows={services.map((service) => {
            const policiesForService = servicePolicies(service);
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
        {noMatches ? <div className="emptyTable" style={{ display: "grid", gap: 8, justifyItems: "start" }}>
          {queryMatchedServices.length ? <>
            <p>No matching services in this kind.</p>
            <button type="button" className="buttonSecondary" onClick={() => {
              setKind("all");
              allKindsButton.current?.focus();
            }}>Show {queryMatchedServices.length} {queryMatchedServices.length === 1 ? "match" : "matches"} across all kinds</button>
          </> : <>
            <p>No matching services in any kind.</p>
            <button type="button" className="buttonSecondary" onClick={() => {
              setQuery("");
              searchInput.current?.focus();
            }}>Clear search</button>
          </>}
        </div> : null}
      </section>
      {selected || !noMatches ? <aside className="inspector">
        {selected ? (
          <>
            {(() => {
              const outcome = serviceOutcome(selected);
              const target = catalogPlaygroundTarget(selected, query, models, serviceRoutes);
              const playBlocker = playgroundBlockedForService(selected) ?? (!target.preset ? "No Playground target available" : null);
              const connection = connectionByProvider.get(selected.provider);
              const connectionEnabled = connection?.enabled ?? selected.readiness?.connectionEnabled;
              const connectionPending = pendingProviderIds.has(selected.provider);
              return (
                <>
            <InspectorHeader brandIcon={selected.brandIcon} icon={kindIcon(selected.kind)} title={selected.name} subtitle={`${kindLabel(selected.kind)} · ${selected.category}${selectedOutsideFilters ? " · outside current filters" : ""}`} />
            <div className={`outcomeCallout ${outcome.tone}`}>
              <OutcomeStatus outcome={outcome} />
              <p>{outcome.detail}</p>
            </div>
            <dl className="facts">
              <dt>provider</dt><dd>{selected.provider}</dd>
              {target.matchedModel ? <><dt>matched model</dt><dd>{target.matchedModel}{target.preset ? "" : " · Not available in Playground"}</dd></> : null}
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
            {canAdminister ? <ProviderBudgetEditor key={selected.provider} connection={connection ?? { providerId: selected.provider, enabled: connectionEnabled !== false }} pending={connectionPending} attempt={budgetAttempts.get(selected.provider)} onEdit={() => { onSelect(selected); discardBudgetAttempt(selected.provider); }} onSave={onSetProviderBudget} /> : null}
            {selected.readiness?.reasons.length ? <InlineNote>{selected.readiness.reasons.join("; ")}</InlineNote> : null}
            <div className="sectionTitle">Policies including this service</div>
            <div className="miniList">
              {grantNamesForService(selected, selectedPolicies).length ? grantNamesForService(selected, selectedPolicies).map((policyId) => {
                const policy = policies.find((item) => item.policyId === policyId);
                return <MiniListItem key={policyId} onClick={canAdminister && policy ? () => onOpenPolicy(policy) : undefined}>{policyId}<span>{policy?.tenantId ?? "identity policy"}</span></MiniListItem>;
              }) : <p>No active policy includes this service yet.</p>}
            </div>
            <div className="inspectorActions">
              <button type="button" disabled={playBlocker !== null} onClick={() => { if (target.preset) onPlay(target.preset); }} title={playBlocker ?? undefined}><Play className="buttonIcon" aria-hidden="true" /><span>Try in playground</span></button>
              {canAdminister ? <button type="button" disabled={connectionPending} aria-busy={connectionPending} className={connectionEnabled === false ? "buttonSecondary" : "buttonDanger"} onClick={() => onSetConnection(selected.provider, connectionEnabled === false)}><ServerCog className="buttonIcon" aria-hidden="true" /><span>{connectionEnabled === false ? "Enable connection" : "Disable connection"}</span></button> : null}
              {canAdminister ? <button type="button" className="buttonSecondary" onClick={() => onAdd(selected)}><Plus className="buttonIcon" aria-hidden="true" /><span>Add to selected policy</span></button> : null}
            </div>
                </>
              );
            })()}
          </>
        ) : <p>Select a service.</p>}
      </aside> : null}
    </div>
  );
}

type SaveProviderBudget = (providerId: string, monthlyBudgetMicros: number | null, text: string) => boolean;

function ProviderBudgetEditor({ connection, pending, attempt, onEdit, onSave }: { connection: ProviderConnection; pending: boolean; attempt?: string; onEdit: () => void; onSave: SaveProviderBudget }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState("");
  const noteId = React.useId();
  const reported = dollarInputFromMicros(connection.monthlyBudgetMicros);
  const value = draft ?? attempt ?? reported;
  const editing = draft !== null || attempt !== undefined;
  const budget = presentProviderBudget(connection);

  return (
    <form className="providerBudgetEditor" onSubmit={(event) => {
      event.preventDefault();
      if (pending) return;
      try {
        if (onSave(connection.providerId, policyBudgetMicros(value, "Monthly"), value)) {
          setDraft(null);
          setError("");
        }
      } catch (caught) { setError(caught instanceof Error ? caught.message : "invalid monthly budget"); }
    }}>
      <label><span>monthly provider budget ($)</span><input disabled={pending} aria-describedby={editing ? noteId : undefined} inputMode="decimal" value={value} onChange={(event) => {
        onEdit();
        setDraft(event.target.value === reported ? null : event.target.value);
        setError("");
      }} placeholder="no provider cap" /></label>
      <button type="submit" className="buttonSecondary" disabled={pending} aria-busy={pending}>{pending ? "Saving connection…" : "Save budget"}</button>
      {editing ? <small id={noteId}>Draft amount{connection.monthlyBudgetMicros !== undefined ? ` · Last reported cap: ${reported ? `$${reported}` : "none"}` : ""}</small> : null}
      <small>{budget.used} · {budget.remaining}</small>
      <small>{budget.note}</small>
      {error ? <small className="providerBudgetError">{error}</small> : null}
    </form>
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
