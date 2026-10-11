import { Status } from "../components";
import { canProbeGrant, modelHeadroom, planLabel, policyGrants, quotaFree, resetLabel, subscriptionFamilies } from "../subscriptions-data";
import type { useSubscriptions } from "../hooks/use-subscriptions";
import type { AccessPolicy, ProviderRow, UpstreamGrant } from "../ui-types";

const number = (value: number) => value.toLocaleString();
const money = (micros: number) => new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(micros / 1e6);
const familyLabel = (family: string) => family.charAt(0).toUpperCase() + family.slice(1);

export function SubscriptionsScreen({ data, policies, grants, providers, refreshQuota, busy, actionError }: {
  data: ReturnType<typeof useSubscriptions>; policies: AccessPolicy[]; grants: UpstreamGrant[]; providers: ProviderRow[];
  refreshQuota: (grant: UpstreamGrant) => Promise<void>; busy: boolean; actionError: string;
}) {
  const policy = policies.find(policy => policy.policyId === data.policyId);
  const pool = policyGrants(policy, grants);
  const subscriptions = pool.filter(grant => grant.provider === "anthropic" && (grant.kind === "subscription" || grant.kind === "oauth"));
  const families = subscriptionFamilies(subscriptions);
  const lanes = data.usage?.lanes.filter(lane => lane.provider === "anthropic");
  const included = lanes?.filter(lane => lane.grantLane === "subscription").reduce((sum, lane) => sum + lane.requests, 0);
  const fallback = lanes?.filter(lane => lane.grantLane === "environment" || lane.grantLane === "api_key").reduce((sum, lane) => ({ requests: sum.requests + lane.requests, costMicros: sum.costMicros + lane.costMicros }), { requests: 0, costMicros: 0 });
  return <div className="subscriptionsScreen">
    <section className="panel subscriptionSummary">
      <div className="subscriptionToolbar">
        <label>Policy<select value={data.policyId} onChange={event => data.setPolicyId(event.target.value)} aria-label="Subscription policy">{policies.map(policy => <option key={policy.policyId} value={policy.policyId}>{policy.policyId}</option>)}</select></label>
        <label>Usage range<select value={data.days} onChange={event => data.setDays(Number(event.target.value))}><option value={1}>24 hours</option><option value={7}>7 days</option><option value={14}>14 days</option><option value={30}>30 days</option><option value={31}>31 days</option></select></label>
        <button type="button" className="buttonSecondary" disabled={data.loading} onClick={data.refresh}>Refresh usage</button>
      </div>
      <h2>Claude included quota first</h2>
      <p>Reserve {policy?.grantRouting.includedQuotaReservePercent ?? 0}% · Paid environment fallback {policy?.grantRouting.environmentFallback ? "enabled" : "disabled"}. Quota is the latest provider reading; in-flight requests can cross the reserve.</p>
      <div className="subscriptionHeadroom">{policy && families.map(family => {
        const headroom = subscriptions.map(grant => modelHeadroom(grant, family, policy));
        const eligible = headroom.filter(row => row.eligible);
        const known = eligible.flatMap(row => row.free === null ? [] : [row.free]);
        return <div key={family}><strong>{familyLabel(family)}</strong><span>{eligible.length}/{subscriptions.length} subs eligible</span><small>{known.length ? `Best ${Math.round(Math.max(...known))}% free` : eligible.length ? "Quota not observed" : "No eligible accounts"}</small></div>;
      })}</div>
      <div className="subscriptionMetrics"><span><strong>{data.usage ? number(included ?? 0) : "—"}</strong> included requests</span><span><strong>{data.usage ? number(fallback?.requests ?? 0) : "—"}</strong> paid fallback requests</span><span><strong>{data.usage ? money(fallback?.costMicros ?? 0) : "—"}</strong> paid fallback cost</span></div>
      {data.loading ? <p role="status">Loading usage…</p> : null}
      {data.error ? <p role="alert">Usage unavailable: {data.error}{data.usage ? " Displayed usage may be stale." : ""}</p> : null}
      {data.usage && data.days > data.usage.retentionDays ? <p>Usage is retained for {data.usage.retentionDays} days; the oldest requested day may be incomplete.</p> : null}
      {actionError ? <p role="alert">{actionError}</p> : null}
    </section>
    {!policies.length ? <section className="panel"><h2>No policies yet</h2><p>Create a policy in Access, then attach Claude subscriptions.</p></section>
      : !subscriptions.length ? <section className="panel"><h2>No Claude subscriptions in this policy</h2><p>Add a subscription grant in Access or choose another policy.</p></section> : null}
    <div className="subscriptionGrid">{pool.map(grant => {
      const totals = data.usage?.grants.find(row => row.grantKey === grant.key);
      const canRefresh = canProbeGrant(grant, providers.find(provider => provider.id === grant.provider));
      return <section className="panel subscriptionCard" key={grant.key}>
        <header><div><h2>{grant.label || grant.tokenRef}</h2><p>{grant.account?.email ?? "Account not observed"}</p></div><Status label={grant.credentialStatus === "reauth_required" ? "reauth required" : grant.usable ? "active" : "unavailable"} tone={grant.usable ? "active" : "revoked"} /></header>
        <p>{planLabel(grant.account?.rateLimitTier)} · {grant.provider} · {grant.account?.subscriptionStatus ?? "Status unknown"} · {grant.enabled ? "enabled" : "disabled"} · {grant.kind === "api_key" ? "api_key" : "subscription"} lane</p>
        <div className="subscriptionQuota">{grant.quotaWindows.filter(window => window.kind === "subscription").map(window => {
          const free = quotaFree(window);
          const label = window.models?.length ? `${window.models.map(familyLabel).join(" / ")} weekly` : window.window === "five_hour" ? "5-hour" : "Weekly";
          return <div key={window.id}><div className="quotaLabel"><strong>{label}</strong><span>{free === null ? "Unknown" : `${Math.round(free)}% free`}</span></div><progress max={100} value={free ?? 0} aria-label={`${label} percent free`} /><small>{resetLabel(window.resetAt)}{window.resetAt ? <> · <time dateTime={window.resetAt}>{new Date(window.resetAt).toLocaleString()}</time></> : null}</small></div>;
        })}{!grant.quotaWindows.some(window => window.kind === "subscription") ? <p>Quota not yet observed.</p> : null}</div>
        <p className="subscriptionEligibility">{policy && grant.provider === "anthropic" && families.map(family => { const value = modelHeadroom(grant, family, policy); return <span key={family}>{familyLabel(family)}: {value.eligible ? "eligible" : "unavailable"}{value.stale ? " (stale quota)" : value.free === null ? " (quota unknown)" : ""}</span>; })}</p>
        <p>Extra usage: {grant.extraUsage?.enabled ?? grant.account?.extraUsageEnabled ? "enabled" : "disabled / unknown"}{grant.extraUsage ? ` · ${creditMoney(grant.extraUsage.usedCredits, grant.extraUsage.currency)} / ${creditMoney(grant.extraUsage.monthlyLimit, grant.extraUsage.currency)}${grant.extraUsage.spendLimitReached ? " · limit reached" : ""}` : ""}</p>
        <div className="subscriptionMetrics"><span><strong>{data.usage ? number(totals?.requests ?? 0) : "—"}</strong> requests</span><span><strong>{data.usage ? number((totals?.inputTokens ?? 0) + (totals?.outputTokens ?? 0)) : "—"}</strong> tokens</span><span><strong>{data.usage ? money(totals?.costMicros ?? 0) : "—"}</strong> API-equivalent value</span></div>
        <p><small>Last selected: {grant.lastSelectedAt ? new Date(grant.lastSelectedAt).toLocaleString() : "Never"} · Quota observed: {grant.quotaObservedAt ? new Date(grant.quotaObservedAt).toLocaleString() : "Never"}</small></p>
        <button type="button" className="buttonSecondary" disabled={busy || !canRefresh} onClick={() => void refreshQuota(grant)}>Refresh quota</button>
        {!canRefresh ? <small> Quota probing is unavailable for this credential; inference headers can still supply quota readings.</small> : null}
      </section>;
    })}</div>
  </div>;
}

function creditMoney(value?: number, currency?: string) {
  if (value === undefined) return "unknown";
  try { return new Intl.NumberFormat(undefined, { style: "currency", currency: currency ?? "USD" }).format(value / 100); }
  catch { return `${(value / 100).toFixed(2)} ${currency ?? "USD"}`; }
}
