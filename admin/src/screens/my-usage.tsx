import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { Info } from 'lucide-react';
import type { PersonalUsageEvent, UsageCostSummary, UsageMetrics } from '../../../shared/usage-report';
import { UsageCoverage, CompleteExport, ExactRanking } from './complete-usage';
import { usageCaveats, prepareUsageFile, downloadUsageFile } from '../complete-usage';
import type { CompleteUsageReport } from '../../../shared/usage-report';
import type { PersonalUsageView as PersonalUsageReport } from '../personal-usage-view';
import type { PersonalUsageData } from '../hooks/use-personal-usage';
import { PersonalUsageTimeSeries } from '../analytics-charts';
import { formatCount } from '../ui-helpers';
import { knownLaneCost, personalHistoryComplete, personalGlanceMoney, personalSuccessCaption, personalMetricLabels, personalPeak, personalRankedGroups, personalTrendRows, safeUsageSum, tokenTotal, type PersonalUsageMetric } from '../personal-usage-view';
import { usageEventAnchor, costCell, costClasses, costClassLabel, costLanes, laneLabel, usageGroupLabel, usageKeyLabel, usageMoney, type PersonalUsageQuery, type UsageKeyName } from '../personal-usage';

const count = (value: number | null) => value === null ? 'Not reported' : value.toLocaleString('en-US');
const iso = (timestamp: number) => new Date(timestamp).toISOString();
const priceText = (costClass: string, micros: number | null) => costClass === 'unknown' ? 'Price unknown' : costClass === 'no_charge' ? 'No charge' : usageMoney(micros);
const tokenPair = (metrics: UsageMetrics, complete: boolean) => {
  const tokens = tokenTotal(metrics, complete);
  return count(tokens.input) + ' / ' + count(tokens.output);
};

function TokenStats({ metrics: m, complete }: { metrics: UsageMetrics; complete: boolean }) {
  const stats = [
    ['Input tokens', m.inputTokens, m.inputReportedCalls],
    ['Output tokens', m.outputTokens, m.outputReportedCalls],
    ['Cache read', m.cachedInputTokens, m.cacheReadReportedCalls],
    ['Cache write', m.cacheWriteInputTokens, m.cacheWriteReportedCalls],
    ['Reasoning', m.reasoningOutputTokens, m.reasoningReportedCalls],
  ] as const;
  return <dl className="personalTokenStats">
    {stats.map(([label, tokens, reported]) => <div key={label}>
      <dt>{label}</dt>
      <dd>{reported || (complete && m.calls === 0 && reported === 0 && tokens === 0) ? count(tokens) : 'Not reported'}</dd>
      <dd className="personalMetricNote"><small>{count(reported)}/{count(m.calls)} calls reported</small></dd>
    </div>)}
  </dl>;
}

function Costs({ costs }: { costs: UsageCostSummary[] }) {
  const rows = [
    { label: 'Calculated + fixed subtotal', classes: ['calculated', 'fixed'] as const },
    ...costClasses.filter(value => value !== 'calculated' && value !== 'fixed').map(value => ({ label: costClassLabel[value], classes: [value] })),
  ];
  return <div className="personalTableWrap" tabIndex={0} role="region" aria-label="Costs by billing lane">
    <table className="personalTable personalCosts">
      <caption>USD · lanes and price quality kept separate</caption>
      <thead><tr><th scope="col">Price quality</th>{costLanes.map(lane => <th scope="col" key={lane}>{laneLabel[lane]}</th>)}</tr></thead>
      <tbody>
        {rows.map(row => <tr key={row.label}>
          <th scope="row">{row.label}</th>
          {costLanes.map(lane => <td key={lane}>{costCell(costs, lane, [...row.classes])}</td>)}
        </tr>)}
      </tbody>
    </table>
  </div>;
}

function CostBreakdown({ costs }: { costs: UsageCostSummary[] }) {
  if (!costs.length) return <span className="personalNote">No cost entries</span>;
  return <ul className="personalCostList">
    {costs.map(cost => <li key={cost.lane + cost.costClass}>
      {laneLabel[cost.lane]} · {costClassLabel[cost.costClass]}: <strong>{priceText(cost.costClass, cost.amountMicros)}</strong> <small>({count(cost.calls)} calls)</small>
    </li>)}
  </ul>;
}

/** Keep an opened help popover inside the viewport. */
function clampHelp(details: HTMLDetailsElement | null) {
  const content = details?.querySelector<HTMLElement>('.personalHelpContent');
  if (!details?.open || !content) return;
  content.style.left = '';
  content.style.right = '';
  const bounds = content.getBoundingClientRect();
  const shift = Math.max(12 - bounds.left, Math.min(0, window.innerWidth - 12 - bounds.right));
  if (shift) {
    content.style.left = (bounds.left - details.getBoundingClientRect().left + shift) + 'px';
    content.style.right = 'auto';
  }
}

function UsageHelp({ label, children, attention = false, icon = false, ariaLabel = label }: { label: string; children: ReactNode; attention?: boolean; icon?: boolean; ariaLabel?: string }) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    function dismiss(event: PointerEvent) { if (ref.current?.open && !ref.current.contains(event.target as Node)) ref.current.open = false; }
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, []);
  function closeOnEscape(event: KeyboardEvent<HTMLDetailsElement>) {
    if (event.key !== 'Escape' || !ref.current?.open) return;
    ref.current.open = false;
    ref.current.querySelector('summary')?.focus();
    event.stopPropagation();
  }
  return <details ref={ref} className={'personalHelp' + (attention ? ' attention' : '') + (icon ? ' iconOnly' : '')} onToggle={() => clampHelp(ref.current)} onKeyDown={closeOnEscape}>
    <summary aria-label={icon ? ariaLabel : label + ': ' + ariaLabel}>{icon ? <Info aria-hidden="true" /> : label}</summary>
    <div className="personalHelpContent">{children}</div>
  </details>;
}

function ReportRange({ value, complete }: { value: PersonalUsageReport; complete?: CompleteUsageReport }) {
  return complete ? <UsageCoverage value={complete}/> : <p>Recorded interval: {iso(value.range.from)} → {iso(value.range.to)}. Historical locations have not been exhaustively assessed.</p>;
}

function MoneyValue({ label, micros }: { label: string; micros: number | null }) {
  return <dd title={usageMoney(micros)} aria-label={micros === null ? label + ' unavailable' : label + ' ' + usageMoney(micros)}>{personalGlanceMoney(micros)}</dd>;
}

export function PersonalUsageSummary({ data, onOpen, keys = [] }: { data: PersonalUsageData; onOpen?: () => void; keys?: readonly UsageKeyName[] }) {
  const { report, reload } = data, value = report.value;
  const complete = value ? personalHistoryComplete(value) : false;
  const tokens = value ? tokenTotal(value.metrics, complete) : null;
  const api = value ? knownLaneCost(value.costs, 'api', complete ? value.metrics.calls : undefined) : null;
  const noApiCalls = api?.value === 0 && !api.present;
  const subscription = value ? knownLaneCost(value.costs, 'subscription') : null;
  const filters = Object.entries(data.query.filters).filter(([, filter]) => filter);
  return <section className="dashboardPanel personalUsageSummary" aria-label="Your personal usage">
    <header className="personalSectionHeader">
      <div className="personalSummaryHeading">
        <h2>For your current access</h2>
        {value ? <ReportRange value={value} complete={data.complete?.report.value} /> : <p>Only your signed-in identity</p>}
      </div>
      {onOpen ? <button type="button" className="buttonSecondary" onClick={onOpen}>Open My usage</button> : null}
    </header>
    <p className="personalNote">{usageCaveats.personal}</p>
    {report.loading ? <p role="status">Loading your usage report…</p> : null}
    {report.error ? <div role="alert"><p>{report.error}</p>{value ? <p>Old displayed report; Refresh required before continuing.</p> : null}<button type="button" onClick={reload}>Retry report</button></div> : null}
    {value && tokens && api && subscription ? <>
      {filters.length ? <p className="personalActiveFilters">Exact filters: {filters.map(([key, filter]) => key + ' = ' + (key === 'key' ? usageKeyLabel(filter, keys) : filter)).join(' · ')}</p> : null}
      <dl className={'personalGlance' + (subscription.present ? ' withSubscription' : '')}>
        <div>
          <dt>Total tokens</dt>
          <dd>{tokens.value === null ? 'Not reported' : formatCount(tokens.value)}</dd>
          <dd className="personalGlanceMeta">
            {tokens.input === null ? 'Input not reported' : formatCount(tokens.input) + ' input'} · {tokens.output === null ? 'output not reported' : formatCount(tokens.output) + ' output'}{' '}
            <UsageHelp label={tokens.partial ? 'Partial coverage' : tokens.value === null ? 'Unavailable' : 'About tokens'} attention={tokens.partial || tokens.value === null} icon={!tokens.partial && tokens.value !== null} ariaLabel="Token totals and reporting coverage">
              <p>Input + output only. Cache and reasoning can overlap these fields and are not added again.</p>
              <p>{count(value.metrics.inputReportedCalls)} / {count(value.metrics.calls)} calls reported input; {count(value.metrics.outputReportedCalls)} / {count(value.metrics.calls)} reported output. Missing fields are not inferred zeros. Partial totals include reported fields only; inexact sums are unavailable.</p>
              <p>Exact reported total: {count(tokens.value)}.</p>
            </UsageHelp>
          </dd>
        </div>
        <div>
          <dt>Known API cost</dt>
          {noApiCalls ? <dd>No API calls</dd> : <MoneyValue label="Known API cost" micros={api.value} />}
          <dd className="personalGlanceMeta">
            Calculated + fixed · USD{' '}
            <UsageHelp label={api.value === null ? 'Unavailable' : api.partial ? 'Partial coverage' : 'Known prices'} attention={api.partial || api.value === null} icon={!api.partial && api.value !== null} ariaLabel="Known API cost and price coverage">
              <p>Calculated + fixed API subtotal, including genuine no-charge calls. {count(api.knownCalls)} / {count(api.totalCalls)} API calls have known prices.</p>
              <p>Estimates, upper bounds, partial and unknown prices are excluded. Missing cost is not free. Subscription and unattributed lanes stay separate. Reporting values are not an invoice.</p>
            </UsageHelp>
          </dd>
        </div>
        <div>
          <dt>Model calls</dt>
          <dd>{count(safeUsageSum([value.metrics.calls]))}</dd>
          <dd className="personalGlanceMeta">
            {personalSuccessCaption(value.metrics)}{' '}
            <UsageHelp label="About calls" icon ariaLabel="Model-call accounting and outcomes">
              <p>Model calls are not client requests. Fusion stages count separately. Failover attempts are not tracked. Utility calls remain included in usage and costs.</p>
              <p>{count(value.metrics.generationCalls)} generation · {count(value.metrics.utilityCalls)} utility. {count(value.metrics.successfulCalls)} successful · {count(value.metrics.errorCalls)} errors · {count(value.metrics.deniedCalls)} denied.</p>
            </UsageHelp>
          </dd>
        </div>
        {subscription.present ? <div className="personalSubscriptionMetric">
          <dt>Subscription equivalent</dt>
          <MoneyValue label="Subscription equivalent" micros={subscription.value} />
          <dd className="personalGlanceMeta">
            Usage equivalent · not an additional bill{' '}
            <UsageHelp label={subscription.value === null ? 'Unavailable' : subscription.partial ? 'Partial coverage' : 'About equivalent'} attention={subscription.partial || subscription.value === null} icon={!subscription.partial && subscription.value !== null} ariaLabel="Subscription usage equivalent and price coverage">
              <p>Calculated + fixed usage equivalent for the subscription lane. Not an additional bill or subscription charge. Estimates and other price qualities remain in Details.</p>
            </UsageHelp>
          </dd>
        </div> : null}
      </dl>
      {data.complete?.report.value ? <details className="personalAccounting personalNote"><summary>Recorded accounting amount: {data.complete.report.value.chargeReportedCalls ? usageMoney(data.complete.report.value.recordedChargeMicros) : 'Not reported'} · not a price or confirmed settlement</summary><p>{data.complete.report.value.chargeReportedCalls}/{value.metrics.calls} rows with a valid recorded accounting field.</p><p>{usageCaveats.accounting}</p></details> : null}
      {!value.metrics.calls ? <p className="personalEmpty">No calls in discovered locations for this range for your current access.</p> : null}
    </> : null}
  </section>;
}

function UsageControls({ query, onChange, onRefresh, onClear, onPreset, loading, children }: { children?: ReactNode; query: PersonalUsageQuery; onChange: (query: PersonalUsageQuery) => void; onRefresh: () => void; onClear: () => void; onPreset:(days:7|30,draft:PersonalUsageQuery)=>void; loading: boolean }) {
  const [draft, setDraft] = useState(query);
  useEffect(() => setDraft(query), [query]);
  const apply = (next: PersonalUsageQuery) => { setDraft(next); onChange(next); };
  const setFilter = (key: keyof PersonalUsageQuery['filters'], value: string) => setDraft({ ...draft, filters: { ...draft.filters, [key]: value } });
  function submit(event: FormEvent) {
    event.preventDefault();
    onChange(draft);
  }
  return <form className="dashboardPanel personalControls personalCompactControls" aria-label="Usage filters" onSubmit={submit}>
    <div className="personalControlRow">
      <h2 className="srOnly">Report controls</h2>
      <div className="personalActions">
        {([7, 30] as const).map(days => <button key={days} type="button" className="buttonSecondary" aria-pressed={query.rollingDays === days} onClick={() => onPreset(days,draft)}>Last {days} days</button>)}
        <button type="button" className="buttonSecondary" disabled={loading} onClick={onRefresh}>Refresh report</button>
      </div>
      <label>Group by<select value={draft.groupBy} onChange={event => apply({ ...draft, groupBy: event.target.value as PersonalUsageQuery['groupBy'] })}>
      <option value="model">Model</option><option value="provider">Provider</option><option value="key">Key</option>
    </select></label>
      {children}
    </div>
    <details className="personalAdvanced">
      <summary>Custom dates & exact filters</summary>
      <p className="personalNote">Start/end accept YYYY-MM-DD in the chosen IANA timezone, or RFC3339 instants with Z or an explicit UTC offset. End is exclusive. Maximum 30 days; server-confirmed boundaries appear below.</p>
      <div className="personalFilterGrid">
        <label>Start<input value={draft.from} onChange={event => setDraft({ ...draft, from: event.target.value, rollingDays: undefined })} required={!draft.rollingDays} /></label>
        <label>End (exclusive)<input value={draft.to} onChange={event => setDraft({ ...draft, to: event.target.value, rollingDays: undefined })} required={!draft.rollingDays} /></label>
        <label>Timezone<input value={draft.timezone} placeholder="Europe/Berlin" onChange={event => setDraft({ ...draft, timezone: event.target.value })} required /></label>
        {(['model', 'provider', 'key', 'status'] as const).map(key => <label key={key}>
          {key === 'key' ? 'Key ID' : key[0].toUpperCase() + key.slice(1)} (exact)
          <input value={draft.filters[key]} maxLength={256} onChange={event => setFilter(key, event.target.value)} />
        </label>)}
        <label>Price quality<select value={draft.filters.costClass} onChange={event => setFilter('costClass', event.target.value)}>
          <option value="">All price qualities</option>
          {costClasses.map(value => <option key={value} value={value}>{costClassLabel[value]}</option>)}
        </select></label>
        <label>Billing lane<select value={draft.filters.lane} onChange={event => setFilter('lane', event.target.value)}>
          <option value="">All billing lanes</option>
          {costLanes.map(value => <option key={value} value={value}>{laneLabel[value]}</option>)}
        </select></label>
      </div>
      <div className="personalActions">
        <button type="submit">Apply filters</button>
        <button type="button" className="buttonSecondary" onClick={onClear}>Clear filters</button>
      </div>
    </details>
  </form>;
}

function EventDetails({ event, peers, page, index }: { event: PersonalUsageEvent; peers: PersonalUsageEvent[]; keys: readonly UsageKeyName[]; page: number; index: number }) {
  const fields = {
    'Event ID': event.id,
    'Key ID': usageKeyLabel(event.keyId),
    Capability: event.capability,
    'Duration (ms)': event.durationMs,
    'HTTP status': event.statusCode,
    'Input tokens': count(event.inputTokens),
    'Output tokens': count(event.outputTokens),
    'Cache read': count(event.cachedInputTokens),
    'Cache write': count(event.cacheWriteInputTokens),
    Reasoning: count(event.reasoningOutputTokens),
    'Reporting-only price': event.costClass === 'unknown' ? 'Price unknown' : usageMoney(event.reportingCostMicros),
    'Recorded accounting amount': usageMoney(event.recordedChargeMicros),
    'Price basis': event.costBasis,
    'Estimate reason': event.estimateReason,
    'Pricing reference': event.pricingRef,
    'Requested tier': event.requestedTier,
    'Served tier': event.servedTier,
    'Fusion request': event.compoundRequestId,
    'Fusion stage': event.compoundStage,
  };
  const related = peers.map((peer, peerIndex) => ({ peer, peerIndex })).filter(({ peer, peerIndex }) => peer.compoundRequestId === event.compoundRequestId && peerIndex !== index);
  return <details>
    <summary>Call details</summary>
    <dl className="personalEventDetails">{Object.entries(fields).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value ?? 'Not reported'}</dd></div>)}</dl>
    <p>Value retained in the usage ledger; not proof of upstream price or completed budget settlement.</p>
    {event.estimateReason?.includes('max_declared_rate') ? <p className="personalWarning">Maximum declared rate used as a reporting-only estimate; not a guaranteed upper bound.</p> : null}
    {event.compoundRequestId ? <p>
      Related Fusion subcalls on this page: {related.map(({ peer, peerIndex }) => <a key={usageEventAnchor(page, peerIndex)} href={'#' + usageEventAnchor(page, peerIndex)}>{peer.compoundStage ?? peer.model ?? peer.id} </a>)} (other stages may be on another page).
    </p> : null}
  </details>;
}

function costAxis(micros: number) {
  return micros >= 100_000_000 ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 }).format(micros / 1_000_000) : usageMoney(micros);
}

function MetricSwitch({ metric, onChange }: { metric: PersonalUsageMetric; onChange: (metric: PersonalUsageMetric) => void }) {
  return <div className="personalMetricSwitch" role="group" aria-label="Chart metric">
    {(['tokens', 'apiCost', 'calls'] as const).map(value => <button key={value} type="button" aria-pressed={metric === value} onClick={() => onChange(value)}>{personalMetricLabels[value]}</button>)}
  </div>;
}

const chartHelp: Record<PersonalUsageMetric, string> = {
  tokens: 'Input + output only. Outlined points have partial token coverage.',
  apiCost: 'Known API subtotal only: calculated, fixed and no-charge. Outlined points exclude other price qualities. No subscription amounts are included.',
  calls: 'Generation and utility model calls, including separate Fusion stages.',
};
const legendLabel: Record<PersonalUsageMetric, string> = { tokens: 'Input + output tokens', apiCost: 'Known API cost', calls: 'Model calls' };

function UsageOverview({ value, query, setQuery, keys, metric, onMetricChange }: { value: PersonalUsageReport; query: PersonalUsageQuery; setQuery: (query: PersonalUsageQuery) => void; keys: readonly UsageKeyName[]; metric: PersonalUsageMetric; onMetricChange: (metric: PersonalUsageMetric) => void }) {
  const points = useMemo(() => personalTrendRows(value, metric), [value, metric]);
  const ranking = useMemo(() => personalRankedGroups(value, metric), [value, metric]);
  const peak = personalPeak(points);
  const maximum = Math.max(1, ...ranking.rows.map(row => row.value ?? 0));
  const format = (amount: number | null) => amount === null ? 'Not reported' : metric === 'apiCost' ? usageMoney(amount) : count(amount) + (metric === 'tokens' ? ' tokens' : ' calls');
  const groupNoun = value.groupBy === 'key' ? 'keys' : value.groupBy + 's';
  return <>
    <div className="personalOverviewToolbar"><MetricSwitch metric={metric} onChange={onMetricChange} /></div>
    <div className="personalChartsGrid">
      <section className="dashboardPanel personalTrendPanel" aria-label="Usage trend">
        <header className="personalChartHeader">
          <div>
            <h2>{personalMetricLabels[metric]} over time</h2>
            <p>{peak ? <>Peak reported {peak.label} · <strong>{format(peak.value)}</strong></> : 'Exact time buckets from this report'}</p>
          </div>
          <UsageHelp label="Chart info" icon ariaLabel="Chart metrics and coverage">
            <p>{chartHelp[metric]}</p>
            <p>Gaps mean no reported value, never free or zero usage. Bucket labels use {value.range.timezone}; inspect a point for exact clipped bounds. Only this period is available, so no previous-period comparison is inferred.</p>
          </UsageHelp>
        </header>
        <PersonalUsageTimeSeries points={points} label={personalMetricLabels[metric] + ' by bucket in ' + value.range.timezone} formatValue={format} formatAxis={amount => metric === 'apiCost' ? costAxis(amount) : formatCount(amount)} />
        <div className="personalChartLegend">
          <span><i />{legendLabel[metric]}</span>
          {points.some(point => point.partial && point.value !== null) ? <span><i className="partial" />Partial coverage</span> : null}
          {points.some(point => point.value === null) ? <span>Gaps: not reported</span> : null}
        </div>
      </section>
      <section className="dashboardPanel personalRanksPanel" aria-label="Usage breakdown">
        <header className="personalChartHeader">
          <div>
            <h2>{ranking.truncated ? 'Top returned groups' : 'Top ' + groupNoun}</h2>
            <p>Ranked by {metric === 'apiCost' ? 'known API cost' : personalMetricLabels[metric].toLowerCase()}</p>
          </div>
          <UsageHelp label="Ranking info" icon ariaLabel="Group ranking scope and coverage">
            <p>Uses only this report’s returned groups. {ranking.truncated ? 'Only the current rank page is shown here; these are not necessarily the global leaders for this chart metric. Use the exact ranking and page controls in Details.' : 'Select a named group to apply an exact filter.'}</p>
            <p>{ranking.missing ? count(ranking.missing) + ' returned groups have no reported value for this metric; they are not treated as zero.' : 'All returned groups have a reported value for this metric.'} Partial values include only reported tokens or known API prices. Full lane and price-quality breakdowns are in Details.</p>
          </UsageHelp>
        </header>
        {!ranking.rows.length ? <p className="personalRankEmpty">No groups in this period.</p> : <ol className="personalRankList">
          {ranking.rows.map(({ group, value: amount, partial, index }) => <li key={index}>
            <div className="personalRankLabel">
              {group.value === null
                ? <strong>{usageGroupLabel(value.groupBy, null)}</strong>
                : <button type="button" className="personalGroupButton" onClick={() => setQuery({ ...query, filters: { ...query.filters, [value.groupBy]: group.value! } })}>{value.groupBy === 'key' ? usageKeyLabel(group.value, keys) : group.value}</button>}
              <span>{amount === null ? 'Not reported' : metric === 'apiCost' ? usageMoney(amount) : formatCount(amount)}{partial && amount !== null ? <small>partial</small> : null}</span>
            </div>
            <div className={'personalRankTrack' + (amount === null ? ' missing' : '')} aria-hidden="true">{amount !== null ? <span style={{ width: (amount / maximum * 100) + '%' }} /> : null}</div>
          </li>)}
        </ol>}
        <p className="personalRankFooter">{ranking.rows.length} of {ranking.total} returned groups · select a name to filter</p>
      </section>
    </div>
  </>;
}

function UsageActivity({ data, timezone, keys }: { data: PersonalUsageData; timezone: string; keys: readonly UsageKeyName[] }) {
  const { events } = data, page = events.value;
  const time = (at: number) => new Date(at).toLocaleString('en-US', { timeZone: timezone, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  return <section className="dashboardPanel personalSection" aria-label="Recent model calls">
    <header className="personalSectionHeader"><div><h2>Recent model calls</h2><p>100 per page · metadata only · {timezone}</p></div></header>
    {events.loading ? <p role="status">Loading recent model calls…</p> : null}
    {events.error ? <div role="alert"><p>{events.error}</p><p>Old displayed report; Refresh required before continuing.</p><button type="button" onClick={data.retryEvents}>Retry recent calls</button></div> : null}
    {page && !events.loading ? <>
      <p className="personalNote">{usageCaveats.personal}</p>
      {!page.events.length ? <p>No recent model calls for these filters.</p> : <div className="personalTableWrap" tabIndex={0} role="region" aria-label="Recent calls table">
        <table className="personalTable personalActivityTable">
          <thead><tr><th scope="col">Time</th><th scope="col">Model / provider</th><th scope="col">Outcome</th><th scope="col">Input / output</th><th scope="col">Reporting cost</th></tr></thead>
          <tbody>
            {page.events.map((event, index) => <tr id={usageEventAnchor(data.page, index)} key={usageEventAnchor(data.page, index) + ':' + event.id}>
              <td><time dateTime={iso(event.occurredAt)}>{time(event.occurredAt)}</time></td>
              <th scope="row">
                <strong>{event.model ?? 'Unattributed model'}</strong>
                <small>{event.provider} · {event.callKind}</small>
                <EventDetails event={event} peers={page.events} keys={keys} page={data.page} index={index} />
              </th>
              <td>{event.status}</td>
              <td>{count(event.inputTokens)} / {count(event.outputTokens)}</td>
              <td><strong>{priceText(event.costClass, event.reportingCostMicros)}</strong><small>{laneLabel[event.lane]} · {costClassLabel[event.costClass]}</small></td>
            </tr>)}
          </tbody>
        </table>
      </div>}
      <div className="personalActions personalPagination">
        <button type="button" className="buttonSecondary" disabled={!data.canPrevious} onClick={data.previousPage}>Previous page</button>
        <span>Page {data.page}</span>
        <button type="button" className="buttonSecondary" disabled={!page.nextCursor} onClick={data.nextPage}>Next page</button>
      </div>
    </> : null}
  </section>;
}

function UsageDetails({ value, data }: { value: PersonalUsageReport; query: PersonalUsageQuery; setQuery: (query: PersonalUsageQuery) => void; keys: readonly UsageKeyName[]; data: PersonalUsageData }) {
  const page = data.events.value;
  const complete = personalHistoryComplete(value);
  return <div className="personalDetailsGrid">
    <div className="personalExportBar">
      <div><h2>Report details</h2><p className="personalNote">CSV exports use the exact report scope and the currently loaded activity page.</p></div>
      <button type="button" className="buttonSecondary" disabled={!page?.events.length || data.events.loading} onClick={() => data.complete.report.value && downloadUsageFile(prepareUsageFile(data.complete.report.value, data.complete.events.value!.events, 'personal', 'csv', 'current page '+data.page))}>Export activity page {data.page} CSV</button>
    </div>
    <section className="dashboardPanel personalSection">
      <header className="personalSectionHeader"><div><h2>Costs & field coverage</h2><p>Reporting values, not an invoice. No grand total across lanes.</p></div></header>
      <Costs costs={value.costs} />
      <TokenStats metrics={value.metrics} complete={complete} />
      <p className="personalNote">Coverage counts calls reporting each field, not inferred zeros. Cache and reasoning can overlap input/output. Subscription amounts are usage equivalents, not additional charges. Estimates, upper bounds, partial and unknown prices stay outside the known subtotal.</p>
    </section>
    <ExactRanking data={data.complete}/>
    <section className="dashboardPanel personalSection" aria-label="Time bucket data">
      <h2>Time bucket data</h2>
      <div className="personalTableWrap" tabIndex={0} role="region" aria-label="Time bucket model calls">
        <table className="personalTable">
          <caption>Exact clipped time buckets · {value.range.timezone}</caption>
          <thead><tr>{['Bucket', 'Model calls', 'Successful', 'Errors / denied', 'Input / output tokens', 'Reporting costs by lane & quality'].map(label => <th scope="col" key={label}>{label}</th>)}</tr></thead>
          <tbody>
            {value.buckets.map(bucket => <tr key={bucket.start}>
              <th scope="row"><time dateTime={iso(bucket.start)} title={iso(bucket.start) + ' → ' + iso(bucket.end)}>{bucket.label}</time></th>
              <td>{count(bucket.metrics.calls)}</td>
              <td>{count(bucket.metrics.successfulCalls)}</td>
              <td>{count(bucket.metrics.errorCalls)} / {count(bucket.metrics.deniedCalls)}</td>
              <td>{tokenPair(bucket.metrics, personalHistoryComplete(value, bucket.start, bucket.end))}</td>
              <td><CostBreakdown costs={bucket.costs} /></td>
            </tr>)}
          </tbody>
        </table>
      </div>
    </section>
  </div>;
}

const panels = ['overview', 'activity', 'details'] as const;
type Panel = typeof panels[number];

export function MyUsageScreen({ data, keys: currentKeys = [] }: { data: PersonalUsageData; keys?: readonly UsageKeyName[] }) {
  const { report, query, setQuery, showEvents } = data, value = report.value;
  const keys: readonly UsageKeyName[] = []; // Current names do not rename retained history.
  const [panel, setPanel] = useState<Panel>('overview');
  const [metric, setMetric] = useState<PersonalUsageMetric>('tokens');
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  const id = useId();
  // Event pages are read only for the views that display or export them.
  useEffect(() => { showEvents(panel !== 'overview'); }, [panel, showEvents]);
  useEffect(() => () => showEvents(false), [showEvents]);
  function moveFocus(event: KeyboardEvent<HTMLDivElement>) {
    const current = tabs.current.indexOf(document.activeElement as HTMLButtonElement);
    const next = { Home: 0, End: panels.length - 1, ArrowRight: (current + 1) % panels.length, ArrowLeft: (current + panels.length - 1) % panels.length }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    tabs.current[next]?.focus();
  }
  function panelContent(name: Panel) {
    if (name === 'activity' && value) return <UsageActivity data={data} timezone={value.range.timezone} keys={keys} />;
    if (!value) return <p className="personalNote">{report.loading ? 'Loading report…' : 'A usage report is needed for this view. Use Retry report above if the read failed.'}</p>;
    if (name === 'overview') return <UsageOverview value={value} query={query} setQuery={setQuery} keys={keys} metric={metric} onMetricChange={setMetric} />;
    return <UsageDetails value={value} query={query} setQuery={setQuery} keys={keys} data={data} />;
  }
  return <div className="personalUsageCanvas">
    <UsageControls query={query} onChange={setQuery} onRefresh={data.reload} onPreset={data.choosePreset} onClear={data.clearFilters} loading={report.loading}>
    {data.complete?.query ? <><button type="button" onClick={data.back}>Back to base</button><label>Grain<select value={data.complete.query.grain} onChange={event=>data.refine({...data.complete.query!,grain:event.target.value as 'day'|'minute',rankOffset:0})}><option value="day">Day</option><option value="minute">Minute (up to 24 hours)</option></select></label><label>Current own-key selector<select value={data.complete.query.filters.key?.kind === 'session' ? 'session' : data.complete.query.filters.key?.kind === 'credential' ? 'key:'+data.complete.query.filters.key.id : ''} onChange={event=>{const q=data.complete.query!,filters={...q.filters};delete filters.key;if(event.target.value==='session')filters.key={kind:'session'};else if(event.target.value)filters.key={kind:'credential',id:event.target.value.slice(4)};data.refine({...q,filters,rankOffset:0});}}><option value="">All keys in base</option><option value="session">Dashboard session</option>{data.complete.query.filters.key?.kind==='credential'&&!currentKeys.some(k=>k.credentialId===(data.complete.query!.filters.key as {id:string}).id)?<option value={'key:'+data.complete.query.filters.key.id}>Retained key: {data.complete.query.filters.key.id} (not in current own-key list)</option>:null}{currentKeys.map(key=><option key={key.credentialId} value={'key:'+key.credentialId}>{key.name?'Current name: '+key.name+' — ':''}{key.credentialId}</option>)}</select></label></> : null}
    </UsageControls>
    <PersonalUsageSummary data={data} keys={keys} />
    <div className="personalTabList" role="tablist" aria-label="Personal usage views" onKeyDown={moveFocus}>
      {panels.map((name, index) => <button type="button" role="tab" key={name} id={id + '-tab-' + name} aria-controls={id + '-panel-' + name} aria-selected={panel === name} tabIndex={panel === name ? 0 : -1} ref={element => { tabs.current[index] = element; }} onClick={() => setPanel(name)}>
        {name[0].toUpperCase() + name.slice(1)}{name === 'activity' && data.events.error ? ' · unavailable' : ''}
      </button>)}
    </div>
    {panels.map(name => <div key={name} role="tabpanel" id={id + '-panel-' + name} aria-labelledby={id + '-tab-' + name} hidden={panel !== name} tabIndex={0}>
      {panel === name ? panelContent(name) : null}
    </div>)}
    {data.complete ? <CompleteExport data={data.complete}/> : null}
  </div>;
}
