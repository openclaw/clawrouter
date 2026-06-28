export function UsersScreen({ users, selected, policies, bindings, services, form, setForm, error, onOpenPolicy, onSelect, onNew, onSave, busy }: {
  users: AccessUser[];
  selected?: AccessUser;
  policies: AccessPolicy[];
  bindings: PolicyBinding[];
  services: ServiceItem[];
  form: AccessForm;
  setForm: (form: AccessForm) => void;
  error: string;
  onOpenPolicy: (policy: AccessPolicy) => void;
  onSelect: (user: AccessUser) => void;
  onNew: () => void;
  onSave: (event: FormEvent) => void;
  busy: boolean;
}) {
  const [userQuery, setUserQuery] = useState("");
  const accessForUser = (user: AccessUser | undefined) => effectiveAccess(user, policies, bindings, services);
  const selectedAccess = accessForUser(selected);
  const selectedServices = selectedAccess.services.map((service) => ({ service, label: "granted" }));
  const selectedGroups = new Set(selected?.groups ?? []);
  const selectedBindings = bindings
    .filter((binding) => binding.enabled && selected && (binding.principalType === "user" ? binding.principalId === selected.email : selectedGroups.has(binding.principalId)))
    .sort((a, b) => a.priority - b.priority || a.policyId.localeCompare(b.policyId));
  const visibleUsers = users.filter((user) => !userQuery.trim() || [user.email, user.tenantId, user.groups.join(" ")].join(" ").toLowerCase().includes(userQuery.trim().toLowerCase()));
  return (
    <div className="entityLayout">
      <section className="mainPane">
        <div className="tableSectionHeader userListHeader"><label className="inputWithIcon"><Search aria-hidden="true" /><input value={userQuery} onChange={(event) => setUserQuery(event.target.value)} placeholder="search identities or groups" /></label><button type="button" onClick={onNew} disabled={busy}><Plus className="buttonIcon" aria-hidden="true" /><span>New identity</span></button></div>
        <EntityTable columns={["identity", "role", "tenant", "policies", "services", "retention", "status"]} columnTemplate="minmax(240px, 1.5fr) 80px 110px 78px 78px 92px 104px" rows={visibleUsers.map((user) => {
          const access = accessForUser(user);
          return { id: user.email, active: selected?.email === user.email, onClick: () => onSelect(user), cells: [<EntityName icon={Users} title={user.email} subtitle="Cloudflare Access" />, user.role, user.tenantId, String(access.policies.length), String(access.services.length), <Status label={user.contentRetentionDisabled ? "exempt" : "policy"} tone={user.contentRetentionDisabled ? "neutral" : "active"} />, <Status label={user.enabled ? "enabled" : "disabled"} tone={user.enabled ? "active" : "revoked"} />] };
        })} />
      </section>
      <aside className="inspector">
        <form onSubmit={onSave}>
          <InspectorHeader icon={Users} title="Access user" subtitle={selected?.email ?? "new user"} />
          {error ? <InlineError message={error} /> : null}
          <InlineNote>Users are created from Cloudflare Access on first login with no policies. Admin status controls the console only; service access always requires an explicit user or group binding.</InlineNote>
          <div className="formGrid compact">
            <label className="full"><span>email</span><input type="email" value={form.email} readOnly={Boolean(selected)} onChange={(event) => setForm({ ...form, email: event.target.value })} /></label>
            <label><span>tenant</span><input value={form.tenantId} onChange={(event) => setForm({ ...form, tenantId: event.target.value })} /></label>
            <label><span>status</span><select value={form.enabled ? "enabled" : "disabled"} onChange={(event) => setForm({ ...form, enabled: event.target.value === "enabled" })}><option value="enabled">enabled</option><option value="disabled">disabled</option></select></label>
            <label className="full"><span>groups</span><input value={form.groups} onChange={(event) => setForm({ ...form, groups: event.target.value })} placeholder="maintainers, docs" /></label>
            <label className="full"><span>request content retention</span><select value={form.contentRetentionDisabled ? "exempt" : "policy"} onChange={(event) => setForm({ ...form, contentRetentionDisabled: event.target.value === "exempt" })}><option value="policy">follow policy · retained by default</option><option value="exempt">exempt · never retain</option></select></label>
          </div>
          <InlineNote>Exemption wins across browser sessions and every proxy credential owned by this user.</InlineNote>
          <dl className="facts"><dt>granted services</dt><dd>{selectedAccess.services.length}</dd><dt>active policies</dt><dd>{selectedAccess.policies.length}</dd><dt>console role</dt><dd>{selected?.role ?? "user"}</dd><dt>tenant</dt><dd>{selected?.tenantId ?? form.tenantId}</dd></dl>
          <div className="sectionTitle">Direct policies</div>
          <div className="serviceMatrix">{policies.map((policy) => <label key={policy.policyId}><input type="checkbox" checked={form.policyIds.includes(policy.policyId)} onChange={() => setForm({ ...form, policyIds: form.policyIds.includes(policy.policyId) ? form.policyIds.filter((id) => id !== policy.policyId) : [...form.policyIds, policy.policyId].sort() })} /><span>{policy.policyId}</span><small>{effectiveProviderCount(policy.providers, services)} services</small></label>)}</div>
          <div className="sectionTitle">Effective policies</div>
          <div className="miniList">{selectedBindings.length ? selectedBindings.map((binding) => {
            const policy = policies.find((item) => item.policyId === binding.policyId);
            return <button type="button" key={bindingKey(binding)} onClick={() => policy && onOpenPolicy(policy)}>{binding.policyId}<span>{binding.principalType === "user" ? "direct" : `via ${binding.principalId}`} · priority {binding.priority}</span></button>;
          }) : <p>No user or group policies assigned.</p>}</div>
          <div className="sectionTitle">Effective access</div>
          <div className="miniList">{selectedServices.length ? selectedServices.slice(0, 8).map(({ service, label }) => <button type="button" key={service.id}>{service.name}<span>{label} · {kindLabel(service.kind)}</span></button>) : <p>No services available for this user.</p>}</div>
          <div className="inspectorActions"><button type="submit" disabled={busy}><ShieldCheck className="buttonIcon" aria-hidden="true" /><span>Save user</span></button></div>
        </form>
      </aside>
    </div>
  );
}

export function UsageScreen({ keys, credentials, services, overview, tenants, usageRows, usage, usageLoaded }: { keys: AccessPolicy[]; credentials: ProxyCredential[]; services: ServiceItem[]; overview: AdminOverview | null; tenants: AdminTenantSummary[]; usageRows: AdminUsageRow[]; usage: UsageSnapshot; usageLoaded: boolean }) {
  const [retainedContent, setRetainedContent] = useState<RetainedRequestContent | null>(null);
  const [contentError, setContentError] = useState("");
  const [contentLoading, setContentLoading] = useState(false);
  async function inspectContent(event: UsageAuditEvent) {
    if (!event.content_ref) return;
    setContentLoading(true);
    setContentError("");
    try {
      setRetainedContent(await request<RetainedRequestContent>(window.location.origin, `/v1/admin/content?tenant=${encodeURIComponent(event.tenant_id)}&ref=${encodeURIComponent(event.content_ref)}`));
    } catch (error) {
      setRetainedContent(null);
      setContentError(errorMessage(error));
    } finally {
      setContentLoading(false);
    }
  }
  const activePolicies = keys.filter((key) => key.enabled);
  const readyServices = readyCount(services);
  const blockedServices = services.filter((service) => service.readiness && !service.readiness.executable);
  const rows = usageRows.length ? usageRows : keys.map(policyUsageFallback);
  const tenantRows = tenants.length ? tenants : tenantSummaryFallback(keys, credentials);
  const serviceByProvider = new Map(services.map((service) => [service.provider, service]));
  const successRate = usage.summary.requestCount ? Math.round((usage.summary.successCount / usage.summary.requestCount) * 100) : null;
  const untrackedRows = rows.filter((row) => row.enabled && row.budget.ledger === "untracked");
  const exhaustedRows = rows.filter((row) => row.enabled && row.budget.configured && row.budget.remainingMicros !== undefined && row.budget.remainingMicros !== null && row.budget.remainingMicros <= 0);
  const ledgerFailureRows = rows.filter((row) => row.enabled && (row.budget.ledger === "unavailable" || row.budget.ledger === "invalid_policy"));
  return (
    <div className="usageCanvas">
      <section className="usageSummaryGrid" aria-label="Usage summary">
        <Metric label="requests" value={formatCount(usage.summary.requestCount)} meta={`${formatCount(usage.summary.totalTokens)} tokens`} />
        <Metric label="success rate" value={successRate === null ? "—" : `${successRate}%`} meta={successRate === null ? "No requests in this period" : `${formatCount(usage.summary.successCount)} successful`} />
        <Metric label="errors" value={formatCount(usage.summary.errorCount)} meta="upstream and policy outcomes" />
        <Metric label="actual spend" value={formatMicros(usage.summary.actualCostMicros)} meta={`${usage.providers.length} active providers`} />
      </section>

      <section className="analyticsPanel usageTrafficPanel">
        <header className="analyticsPanelHeader">
          <div><span>Traffic</span><h2>Request activity</h2><p>Daily routed requests across every active policy.</p></div>
          <div className="analyticsPanelControls"><span className={`ledgerBadge ${usageLoaded ? "ready" : "unavailable"}`}>{usageLoaded ? "Live ledger" : "Ledger unavailable"}</span><span className="periodBadge"><CalendarDays aria-hidden="true" />Last 30 days · UTC</span></div>
        </header>
        <TrafficAreaChart usage={usage} />
      </section>

      <div className="usageInsightsGrid">
        <section className="analyticsPanel usageProviderPanel">
          <header className="analyticsPanelHeader"><div><span>Provider mix</span><h2>Traffic distribution</h2><p>Request volume, success, tokens, and actual spend.</p></div><small>{usage.providers.length} active</small></header>
          <ProviderUsageChart providers={usage.providers} services={services} />
        </section>

        <section className="analyticsPanel usageHealthPanel">
          <header className="analyticsPanelHeader"><div><span>Operational health</span><h2>Signals needing attention</h2><p>Configuration and budget conditions that can block traffic.</p></div><Activity aria-hidden="true" /></header>
          <div className="attentionGrid">
            <div className={blockedServices.length ? "attentionMetric warning" : "attentionMetric healthy"}><strong>{blockedServices.length}</strong><span>services need configuration</span></div>
            {usageLoaded ? <>
              <div className={untrackedRows.length ? "attentionMetric warning" : "attentionMetric healthy"}><strong>{untrackedRows.length}</strong><span>policies not reporting spend</span></div>
              <div className={ledgerFailureRows.length ? "attentionMetric danger" : "attentionMetric healthy"}><strong>{ledgerFailureRows.length}</strong><span>budget ledger failures</span></div>
            </> : <div className="attentionMetric danger"><strong>!</strong><span>live usage ledger unavailable</span></div>}
            <div className={exhaustedRows.length ? "attentionMetric danger" : "attentionMetric healthy"}><strong>{exhaustedRows.length}</strong><span>policies out of budget</span></div>
          </div>
          <div className="usageHealthFooter">
            <div><span>Executable services</span><strong>{readyServices}/{services.length}</strong></div>
            <div><span>Active policies</span><strong>{overview?.policiesActive ?? activePolicies.length}</strong></div>
            <div><span>Tenants</span><strong>{overview?.tenantsTotal ?? tenantRows.length}</strong></div>
          </div>
        </section>
      </div>

      {contentLoading ? <InlineNote>Loading retained request…</InlineNote> : null}
      {contentError ? <InlineError message={contentError} /> : null}
      {retainedContent ? <section className="analyticsPanel retainedContentPanel"><header className="analyticsPanelHeader"><div><span>Request content</span><h2>Retained request</h2><p>{retainedContent.requestId}</p></div><button type="button" className="buttonSecondary" onClick={() => setRetainedContent(null)}>Close</button></header><dl className="facts"><dt>identity</dt><dd>{retainedContent.principalId ?? "credential"}</dd><dt>service</dt><dd>{retainedContent.provider}</dd><dt>expires</dt><dd>{formatTimestamp(retainedContent.expiresAtMs, true)}</dd></dl><pre>{JSON.stringify(retainedContent.body, null, 2)}</pre></section> : null}

      <section className="analyticsPanel usageTablePanel">
        <div className="tableSectionHeader"><div><strong>Recent requests</strong><span>{usage.events.length} most recent audit events</span></div><span>{usageLoaded ? usage.ledger : "unavailable"}</span></div>
        <EntityTable
          columns={["time", "identity", "service", "operation", "outcome", "content", "cost"]}
          columnTemplate="92px minmax(170px, 1.2fr) minmax(145px, 1fr) minmax(150px, 1fr) 104px 90px 74px"
          rows={usage.events.map((event) => {
            const service = serviceByProvider.get(event.provider);
            const verifiedIdentity = event.principal_id ?? event.credential_id ?? event.policy_id ?? event.tenant_id;
            const agentIdentity = event.agent_id ? `agent ${event.agent_id}` : event.auth_type ?? "authenticated";
            const agentContext = [event.parent_agent_id && `parent ${event.parent_agent_id}`, event.client && `client ${event.client}`, event.project_id && `project ${event.project_id}`, event.session_id && `session ${event.session_id}`].filter(Boolean).join(" · ");
            return {
              id: event.id,
              cells: [
                <span className="auditTime" title={formatTimestamp(event.occurred_at_ms, true)}>{formatTimestamp(event.occurred_at_ms)}</span>,
                <span className="auditIdentity" title={[`authenticated ${verifiedIdentity}`, agentIdentity, agentContext].filter(Boolean).join(" · ")}><strong>{verifiedIdentity}</strong><small>{agentIdentity}</small>{agentContext ? <small>{agentContext}</small> : null}</span>,
                <EntityName brandIcon={service?.brandIcon} icon={ServerCog} title={service?.name ?? event.provider} subtitle={event.provider} />,
                <span className="auditOperation"><strong>{event.capability ?? event.type}</strong><small>{[event.model, event.cost_basis].filter(Boolean).join(" · ") || event.request_id || "request"}</small></span>,
                <Status label={event.status_code ? `${event.status_code} ${event.status}` : event.status} tone={usageEventTone(event)} />,
                event.content_retained ? <button type="button" className="tableAction" onClick={() => void inspectContent(event)}>View</button> : <span title={event.duration_ms ? `Latency ${formatDuration(event.duration_ms)}` : undefined}>not stored</span>,
                formatMicros(event.actual_cost_micros),
              ],
            };
          })}
        />
        {!usage.events.length ? <div className="emptyTable">No request audit events recorded yet.</div> : null}
      </section>

      <section className="analyticsPanel usageTablePanel budgetTablePanel">
        <div className="tableSectionHeader secondaryTableHeader"><div><strong>Policy budgets</strong><span>{rows.length} configured policies</span></div><span>{usageLoaded ? "live ledger" : "policy fallback"}</span></div>
        <EntityTable columns={["policy", "tenant", "budget usage", "services", "health"]} columnTemplate="minmax(210px, 1.15fr) minmax(120px, 0.7fr) minmax(250px, 1.45fr) 96px 120px" rows={rows.map((row) => ({ id: usagePolicyId(row), cells: [<EntityName icon={KeyRound} title={usagePolicyId(row)} subtitle={row.tokenRole ?? "custom"} />, row.tenantId, <BudgetUsage row={row} />, effectiveProviderCount(row.providers, services), <UsageHealth row={row} />] }))} />
      </section>
    </div>
  );
}

export function Metric({ label, value, meta }: { label: string; value: string; meta: string }) {
  return <div className="metric"><span>{label}</span><strong>{value}</strong><small>{meta}</small></div>;
}

export function BudgetUsage({ row }: { row: AdminUsageRow }) {
  const limit = row.budget.limitMicros ?? row.monthlyBudgetMicros;
  const spent = row.budget.spentMicros;
  const blocked = row.budget.ledger === "blocked" || limit === 0;
  const percent = blocked ? 100 : limit !== undefined && limit !== null && spent !== undefined && spent !== null ? Math.min(100, Math.max(0, (spent / limit) * 100)) : null;
  const spendLabel = row.budget.ledger === "unavailable"
    ? "Ledger unavailable"
    : row.budget.ledger === "invalid_policy"
      ? "Invalid budget policy"
      : spent === undefined || spent === null
        ? "Spend unavailable"
        : `${formatMicros(spent)} spent`;
  return (
    <span className="budgetUsage">
      <span><strong>{spendLabel}</strong><small>{formatBudget(limit)} budget</small></span>
      <span className={`budgetTrack${blocked || (percent !== null && percent >= 100) ? " exhausted" : ""}`}><span style={{ width: `${percent ?? 0}%` }} /></span>
    </span>
  );
}

export function UsageHealth({ row }: { row: AdminUsageRow }) {
  if (!row.enabled) return <Status label="revoked" tone="revoked" />;
  if (row.budget.ledger === "unavailable") return <Status label="ledger unavailable" tone="revoked" />;
  if (row.budget.ledger === "invalid_policy") return <Status label="invalid policy" tone="revoked" />;
  if (row.budget.ledger === "blocked") return <Status label="budget blocked" tone="revoked" />;
  if (row.budget.ledger === "unmetered") return <Status label="unmetered" tone="neutral" />;
  if (row.budget.ledger === "untracked") return <Status label="untracked" tone="neutral" />;
  if (!row.budget.configured) return <Status label="untracked" tone="neutral" />;
  if (row.budget.remainingMicros !== undefined && row.budget.remainingMicros !== null && row.budget.remainingMicros <= 0) return <Status label="budget blocked" tone="revoked" />;
  if (row.budget.spentMicros === undefined || row.budget.spentMicros === null) return <Status label="awaiting usage" tone="neutral" />;
  return <Status label="healthy" tone="active" />;
}

export function EntityTable({ columns, columnTemplate, rows }: { columns: string[]; columnTemplate?: string; rows: Array<{ id: string; active?: boolean; onClick?: () => void; cells: React.ReactNode[] }> }) {
  return (
    <div className="entityTable" style={{ "--cols": columns.length, "--columns": columnTemplate } as React.CSSProperties}>
      <div className="tableHead">{columns.map((column) => <span key={column}>{column}</span>)}</div>
      <div className="tableBody">{rows.map((row) => {
        const content = row.cells.map((cell, index) => <span key={index} data-label={columns[index]}>{cell}</span>);
        const className = `tableRow${row.active ? " selected" : ""}${row.onClick ? " interactive" : ""}`;
        return row.onClick
          ? <button type="button" key={row.id} className={className} onClick={row.onClick}>{content}</button>
          : <div key={row.id} className={className}>{content}</div>;
      })}</div>
    </div>
  );
}
import React, { type FormEvent, useState } from "react";
import { Activity, CalendarDays, KeyRound, Plus, Search, ServerCog, ShieldCheck, Users } from "lucide-react";
import { bindingKey, effectiveAccess, errorMessage, policyUsageFallback, tenantSummaryFallback } from "../domain";
import { EntityName, InlineError, InlineNote, InspectorHeader, PanelTitle, Status, kindLabel } from "../components";
import { ProviderUsageChart, TrafficAreaChart } from "../analytics-charts";
import { budgetPercent, effectiveProviderCount, formatBudget, formatCount, formatDuration, formatMicros, formatTimestamp, providerBrandIcon, readyCount, request, usageEventTone, usagePolicyId } from "../ui-helpers";
import type { AccessForm,AccessPolicy,AccessRole,AccessTab,AccessUser,AdminOverview,AdminTenantSummary,AdminUsageRow,AssignmentRule,AssignmentRuleForm,BindingForm,BrandIcon,BudgetStatus,ContentRetention,CredentialForm,EntitlementsResponse,IconComponent,OutcomeTone,PlaygroundForm,PlaygroundHttpResponse,PlaygroundTurn,PolicyBinding,PolicyForm,ProviderAccess,ProviderConnection,ProviderReadiness,ProviderResponse,ProviderRow,ProviderUsageSummary,ProxyCredential,RefreshOptions,RetainedRequestContent,RouteCatalog,ServiceItem,ServiceOutcome,SessionResponse,UpstreamGrant,UpstreamGrantForm,UsageAuditEvent,UsageSnapshot,UsageSummary,View } from "../ui-types";
