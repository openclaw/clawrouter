import { useEffect, useRef, useState } from "react";
import { Activity, CalendarDays, KeyRound, ServerCog, Users } from "lucide-react";
import { errorMessage, policyUsageFallback, tenantSummaryFallback } from "../domain";
import { EntityTable, Metric, EntityName, InlineError, InlineNote, Status } from "../components";
import { UsageFreshness, ProviderUsageChart, TrafficAreaChart } from "../analytics-charts";
import type { ConsoleRequest } from "../dashboard-fetch";
import { usageEventGroups, type UsageEventGroup } from "../usage-analytics";
import { presentAccountedSpend, presentAllowanceWindows, presentBudget, presentCost, presentPolicyBudget } from "../cost-presentation";
import {
  effectiveProviderCount,
  formatCount,
  formatDuration,
  formatTimestamp,
  readyCount,
  usageEventTone,
  usagePolicyId,
} from "../ui-helpers";
import type {
  AccessPolicy,
  AdminOverview,
  AdminTenantSummary,
  AdminUsageRow,
  PrincipalUsage,
  ProxyCredential,
  RetainedRequestContent,
  ServiceItem,
  UsageAuditEvent,
  UsageSnapshot,
} from "../ui-types";

export function UsageScreen({ request, keys, credentials, services, overview, tenants, usageRows, usage, usageLoaded, usageStale, usageError, usageUpdatedAt }: { request: ConsoleRequest; keys: AccessPolicy[]; credentials: ProxyCredential[]; services: ServiceItem[]; overview: AdminOverview | null; tenants: AdminTenantSummary[]; usageRows: AdminUsageRow[]; usage: UsageSnapshot; usageLoaded: boolean; usageStale: boolean; usageError: string; usageUpdatedAt: number | null }) {
  const [retainedContent, setRetainedContent] = useState<RetainedRequestContent | null>(null);
  const [contentError, setContentError] = useState("");
  const [contentLoading, setContentLoading] = useState(false);
  const [expandedRequestId, setExpandedRequestId] = useState<string | null>(null);
  const contentFeedbackRef = useRef<HTMLDivElement>(null);
  const contentOperationRef = useRef<AbortController | null>(null);
  function retireContentRead() {
    const operation = contentOperationRef.current;
    // Revoke publication before aborting: cancellation may race a completed read.
    contentOperationRef.current = null;
    operation?.abort();
  }
  useEffect(() => retireContentRead, []);
  useEffect(() => {
    if (contentLoading || contentError || retainedContent) contentFeedbackRef.current?.scrollIntoView({ block: "nearest" });
  }, [contentError, contentLoading, retainedContent]);
  function closeContent() {
    retireContentRead();
    setRetainedContent(null);
    setContentError("");
    setContentLoading(false);
  }
  async function inspectContent(event: UsageAuditEvent) {
    if (!event.content_ref) return;
    retireContentRead();
    const operation = new AbortController();
    contentOperationRef.current = operation;
    setRetainedContent(null);
    setContentLoading(true);
    setContentError("");
    try {
      const content = await request<RetainedRequestContent>(window.location.origin, `/v1/admin/content?tenant=${encodeURIComponent(event.tenant_id)}&ref=${encodeURIComponent(event.content_ref)}`, { signal: operation.signal });
      if (contentOperationRef.current === operation) setRetainedContent(content);
    } catch (error) {
      if (contentOperationRef.current !== operation) return;
      setContentError(errorMessage(error));
    } finally {
      if (contentOperationRef.current === operation) {
        contentOperationRef.current = null;
        setContentLoading(false);
      }
    }
  }
  const activePolicies = keys.filter((key) => key.enabled);
  const readyServices = readyCount(services);
  const blockedServices = services.filter((service) => service.readiness && !service.readiness.executable);
  const rows = usageRows.length ? usageRows : keys.map(policyUsageFallback);
  const tenantRows = tenants.length ? tenants : tenantSummaryFallback(keys, credentials);
  const serviceByProvider = new Map(services.map((service) => [service.provider, service]));
  const successRate = usage.summary.requestCount ? Math.round((usage.summary.successCount / usage.summary.requestCount) * 100) : null;
  const successCaption = successRate === null ? "—" : successRate === 0 && usage.summary.successCount > 0 ? "<1%" : successRate === 100 && usage.summary.successCount < usage.summary.requestCount ? ">99%" : `${successRate}%`;
  const untrackedRows = rows.filter((row) => row.enabled && row.budget.ledger === "untracked");
  const exhaustedRows = rows.filter((row) => row.enabled && row.budget.configured && row.budget.remainingMicros !== undefined && row.budget.remainingMicros !== null && row.budget.remainingMicros <= 0);
  const ledgerFailureRows = rows.filter((row) => row.enabled && (row.budget.ledger === "unavailable" || row.budget.ledger === "invalid_policy"));
  const requestGroups = usageEventGroups(usage.events);
  const spend = presentAccountedSpend(usage.summary);
  return (
    <div className="usageCanvas">
      <UsageFreshness loaded={usageLoaded} stale={usageStale} error={usageError} updatedAt={usageUpdatedAt} />
      <section className="usageSummaryGrid" aria-label="Usage summary">
        <Metric label="requests" value={usageLoaded ? formatCount(usage.summary.requestCount) : "—"} meta={usageLoaded ? `${formatCount(usage.summary.totalTokens)} tokens` : "Usage unavailable"} />
        <Metric label="success rate" value={successCaption} meta={!usageLoaded ? "Usage unavailable" : successRate === null ? "No requests in this period" : `${formatCount(usage.summary.successCount)} successful`} />
        <Metric label="errors" value={usageLoaded ? formatCount(usage.summary.errorCount) : "—"} meta="upstream and policy outcomes" />
        <Metric label={spend.label} value={usageLoaded ? spend.value : "—"} meta={usageLoaded ? `Last 30 days · ${spend.note}` : "Usage unavailable"} />
      </section>

      <section className="analyticsPanel usageTrafficPanel">
        <header className="analyticsPanelHeader">
          <div><span>Traffic</span><h2>Request activity</h2><p>Daily routed requests across every active policy.</p></div>
          <div className="analyticsPanelControls"><span className={`ledgerBadge ${usageLoaded && !usageStale ? "ready" : "unavailable"}`}>{usageLoaded ? usageStale ? "Last known ledger" : "Live ledger" : "Ledger unavailable"}</span><span className="periodBadge"><CalendarDays aria-hidden="true" />Last 30 days · UTC</span></div>
        </header>
        {usageLoaded ? <TrafficAreaChart usage={usage} /> : <InlineNote>Request activity unavailable.</InlineNote>}
      </section>

      <div className="usageInsightsGrid">
        <section className="analyticsPanel usageProviderPanel">
          <header className="analyticsPanelHeader"><div><span>Provider mix</span><h2>Traffic distribution</h2><p>Request volume, success, tokens, and accounted spend.</p></div><small>{usageLoaded ? `${usage.providers.length} active` : "unavailable"}</small></header>
          {usageLoaded ? <ProviderUsageChart providers={usage.providers} services={services} /> : <InlineNote>Provider usage unavailable.</InlineNote>}
        </section>

        <section className="analyticsPanel usageHealthPanel">
          <header className="analyticsPanelHeader"><div><span>Operational health</span><h2>Signals needing attention</h2><p>Configuration and budget conditions that can block traffic.</p></div><Activity aria-hidden="true" /></header>
          <div className="attentionGrid">
            <div className={blockedServices.length ? "attentionMetric warning" : "attentionMetric healthy"}><strong>{blockedServices.length}</strong><span>services need configuration</span></div>
            {usageLoaded ? <>
              <div className={untrackedRows.length ? "attentionMetric warning" : "attentionMetric healthy"}><strong>{untrackedRows.length}</strong><span>policies not reporting spend</span></div>
              <div className={ledgerFailureRows.length ? "attentionMetric danger" : "attentionMetric healthy"}><strong>{ledgerFailureRows.length}</strong><span>budget ledger failures</span></div>
            </> : <div className="attentionMetric danger"><strong>!</strong><span>live usage ledger unavailable</span></div>}
            <div className={exhaustedRows.length ? "attentionMetric danger" : usageLoaded ? "attentionMetric healthy" : "attentionMetric"}><strong>{usageLoaded ? exhaustedRows.length : "—"}</strong><span>policies out of budget</span></div>
          </div>
          <div className="usageHealthFooter">
            <div><span>Executable services</span><strong>{readyServices}/{services.length}</strong></div>
            <div><span>Active policies</span><strong>{overview?.policiesActive ?? activePolicies.length}</strong></div>
            <div><span>Tenants</span><strong>{overview?.tenantsTotal ?? tenantRows.length}</strong></div>
          </div>
        </section>
      </div>

      {contentLoading || contentError || retainedContent ? <div ref={contentFeedbackRef} className="retainedContentFeedback" aria-live="polite">
        <section className="analyticsPanel retainedContentPanel"><header className="analyticsPanelHeader"><div><span>Request content</span><h2>Retained request</h2>{retainedContent ? <p>{retainedContent.requestId}</p> : null}</div><button type="button" className="buttonSecondary" onClick={closeContent}>Close</button></header>
        {contentLoading ? <InlineNote>Loading retained request…</InlineNote> : null}
        {contentError ? <InlineError message={contentError} /> : null}
        {retainedContent ? <><dl className="facts"><dt>identity</dt><dd>{retainedContent.principalId ?? "credential"}</dd><dt>service</dt><dd>{retainedContent.provider}</dd><dt>expires</dt><dd>{formatTimestamp(retainedContent.expiresAtMs, true)}</dd></dl><pre>{JSON.stringify(retainedContent.body, null, 2)}</pre></> : null}
        </section>
      </div> : null}

      <section className="analyticsPanel usageTablePanel">
        <div className="tableSectionHeader"><div><strong>Recent requests</strong><span>{usageLoaded ? `${requestGroups.length} requests · ${usage.events.length} recorded calls` : "Request history unavailable"}</span></div><span>{usageLoaded ? usageStale ? "last known" : usage.ledger : "unavailable"}</span></div>
        <EntityTable
          columns={["time", "identity", "service", "operation", "outcome", "content", "cost"]}
          columnTemplate="92px minmax(170px, 1.2fr) minmax(145px, 1fr) minmax(150px, 1fr) 104px 90px minmax(165px, 1fr)"
          rows={requestGroups.map((group) => {
            const event = group.primary;
            const service = group.compound ? undefined : serviceByProvider.get(event.provider);
            const verifiedIdentity = event.principal_id ?? event.credential_id ?? event.policy_id ?? event.tenant_id;
            const agentIdentity = event.agent_id ? `agent ${event.agent_id}` : event.auth_type ?? "authenticated";
            const agentContext = [event.parent_agent_id && `parent ${event.parent_agent_id}`, event.client && `client ${event.client}`, event.project_id && `project ${event.project_id}`, event.session_id && `session ${event.session_id}`].filter(Boolean).join(" · ");
            const cost = group.compound
              ? presentAccountedSpend({ requestCount: group.events.length, actualCostMicros: group.actualCostMicros, unpricedRequestCount: group.unpricedRequestCount }, group.complete)
              : presentCost(event.actual_cost_micros, event.cost_basis);
            return {
              id: group.id,
              cells: [
                <span className="auditTime" title={formatTimestamp(group.occurredAtMs, true)}>{formatTimestamp(group.occurredAtMs)}</span>,
                <span className="auditIdentity" title={[`authenticated ${verifiedIdentity}`, agentIdentity, agentContext].filter(Boolean).join(" · ")}><strong>{verifiedIdentity}</strong><small>{agentIdentity}</small>{agentContext ? <small>{agentContext}</small> : null}</span>,
                <EntityName brandIcon={service?.brandIcon} icon={ServerCog} title={group.compound ? "ClawRouter Fusion" : service?.name ?? event.provider} subtitle={group.compound ? `${group.events.length} model calls` : event.provider} />,
                group.compound
                  ? <button type="button" className="compoundRequestToggle" aria-expanded={expandedRequestId === group.id} onClick={() => setExpandedRequestId((current) => current === group.id ? null : group.id)}><strong>Fusion ensemble</strong><small>{group.complete ? `${group.events.length} calls` : `${group.events.length}/${group.expectedCallCount} calls · partial`}</small></button>
                  : <span className="auditOperation"><strong>{event.capability ?? event.type}</strong><small>{event.model || event.request_id || "request"}</small></span>,
                <Status label={group.compound ? `${group.successCount}/${group.events.length} succeeded` : event.status_code ? `${event.status_code} ${event.status}` : event.status} tone={usageEventTone(event)} />,
                group.compound
                  ? <span title={group.durationMs != null ? `End-to-end latency ${formatDuration(group.durationMs)}` : undefined}>{group.events.filter((item) => item.content_retained).length} stored</span>
                  : event.content_retained ? <button type="button" className="tableAction" onClick={() => void inspectContent(event)}>View</button> : <span title={event.duration_ms ? `Latency ${formatDuration(event.duration_ms)}` : undefined}>not stored</span>,
                <span className="auditCost"><strong>{cost.value}</strong><small>{cost.label}</small></span>,
              ],
              detail: group.compound && expandedRequestId === group.id ? <CompoundRequestCalls group={group} onInspect={inspectContent} /> : undefined,
            };
          })}
        />
        {!usage.events.length ? <div className="emptyTable">{usageLoaded ? "No request audit events recorded yet." : "Request audit events unavailable."}</div> : null}
      </section>

      {usage.principals ? <PrincipalUsageTable principals={usage.principals} loaded={usageLoaded} stale={usageStale} /> : null}

      <section className="analyticsPanel usageTablePanel budgetTablePanel">
        <div className="tableSectionHeader secondaryTableHeader"><div><strong>Policy budgets</strong><span>{rows.length} configured policies</span></div><span>{usageLoaded ? usageStale ? "last known ledger" : "live ledger" : "policy limits only"}</span></div>
        <p className="panelIntro">UTC calendar month · Used includes reservations. Other policy or provider limits still apply.</p>
        <EntityTable columns={["policy", "tenant", "budget usage", "services", "health"]} columnTemplate="minmax(210px, 1.15fr) minmax(120px, 0.7fr) minmax(250px, 1.45fr) 96px 120px" rows={rows.map((row) => ({ id: usagePolicyId(row), cells: [<EntityName icon={KeyRound} title={usagePolicyId(row)} subtitle={row.tokenRole ?? "custom"} />, row.tenantId, <BudgetUsage row={row} />, effectiveProviderCount(row.providers, services), <UsageHealth row={row} />], detail: [row.budget, row.budget.daily, row.budget.weekly].some(window => window?.ledger === "per_principal") ? <BudgetBreakdown row={row} /> : undefined }))} />
      </section>
    </div>
  );
}

function CompoundRequestCalls({ group, onInspect }: { group: UsageEventGroup; onInspect: (event: UsageAuditEvent) => Promise<void> }) {
  const cost = presentAccountedSpend({ requestCount: group.events.length, actualCostMicros: group.actualCostMicros, unpricedRequestCount: group.unpricedRequestCount }, group.complete);
  return (
    <div className="compoundRequest" aria-label="Fusion recorded calls">
      <div className="compoundRequestHeader"><strong>{group.complete ? "Model call detail" : "Partial model call detail"}</strong><span>{group.durationMs != null ? `${group.complete ? "End-to-end" : "Visible span"} ${formatDuration(group.durationMs)}` : "Latency unavailable"} · {cost.label}: {cost.value}</span></div>
      <p className="compoundRequestWarning">{cost.note}</p>
      <div className="compoundRequestCalls">
        {group.events.map((event) => { const callCost = presentCost(event.actual_cost_micros, event.cost_basis); return <div key={event.id}>
          <span><strong>{compoundStage(event)}</strong><small>{event.provider} · {event.model ?? event.capability ?? "request"}</small></span>
          <span><small>{event.duration_ms != null ? formatDuration(event.duration_ms) : "—"} · {callCost.value}</small><small>{callCost.label}</small>{event.content_retained ? <button type="button" className="tableAction" onClick={() => void onInspect(event)}>View</button> : null}</span>
        </div>; })}
      </div>
      {!group.complete ? <p className="compoundRequestWarning">This recent-event window contains {group.events.length} of {group.expectedCallCount} calls. Totals cover only the visible calls.</p> : null}
    </div>
  );
}

function compoundStage(event: UsageAuditEvent) {
  return event.compound_request_stage === "fusion_synthesizer" ? "Synthesizer" : `Adviser ${event.compound_request_index ?? ""}`.trim();
}

export function BudgetUsage({ row }: { row: AdminUsageRow }) {
  const budget = presentPolicyBudget(row);
  return (
    <span className="budgetUsage" title={budget.note}>
      <span><strong>{budget.used}</strong><small>{budget.limit}</small></span>
      <small>{budget.remaining} · {budget.scopeLabel}</small>
      {presentAllowanceWindows(row.budget).filter(window => window.label !== "This month").map(window => <small key={window.label}>{window.text}</small>)}
      <span className={`budgetTrack${budget.exhausted ? " exhausted" : ""}`}><span style={{ width: `${budget.percent ?? 0}%` }} /></span>
    </span>
  );
}

// Thirty-day totals per user across every policy, with unattributed service-key traffic listed by credential.
function PrincipalUsageTable({ principals, loaded, stale }: { principals: PrincipalUsage[]; loaded: boolean; stale: boolean }) {
  return (
    <section className="analyticsPanel usageTablePanel">
      <div className="tableSectionHeader secondaryTableHeader"><div><strong>Usage by user</strong><span>{principals.length} identities · last 30 days</span></div><span>{loaded ? stale ? "last known ledger" : "live ledger" : "ledger unavailable"}</span></div>
      <EntityTable
        columns={["user", "requests", "tokens", "errors", "accounted spend"]}
        columnTemplate="minmax(220px, 1.4fr) 110px 140px 90px minmax(160px, 1fr)"
        rows={principals.map((row) => ({
          id: JSON.stringify([row.principalId, row.credentialId]),
          cells: [
            <EntityName icon={Users} title={row.principalId ?? (row.credentialId ? `service key ${row.credentialId}` : "unattributed")} subtitle={row.principalId ? "user" : "no principal"} />,
            formatCount(row.summary.requestCount),
            formatCount(row.summary.totalTokens),
            formatCount(row.summary.errorCount),
            presentAccountedSpend(row.summary).value,
          ],
        }))}
      />
      {!principals.length ? <div className="emptyTable">No requests recorded in this period.</div> : null}
    </section>
  );
}

function BudgetBreakdown({ row }: { row: AdminUsageRow }) {
  const windows = [["Monthly", row.budget], ["Daily", row.budget.daily], ["Weekly", row.budget.weekly]] as const;
  const breakdown = windows.flatMap(([label, window]) => window?.configured ? (window.breakdown ?? []).map(item => ({ label, item })) : []);
  return <div className="budgetBreakdown"><strong>Per principal</strong>{breakdown.length ? breakdown.map(({ label, item }) => { const budget = presentBudget(item, "principal"); return <div key={label + item.principal}><span>{item.principal} · {label}</span><span>{budget.used}</span><span>{budget.remaining}</span></div>; }) : <span>No principal balances reported</span>}</div>;
}

export function UsageHealth({ row }: { row: AdminUsageRow }) {
  return <Status {...presentPolicyBudget(row).health} />;
}
