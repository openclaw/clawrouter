import { usageTokenFields } from '../../../shared/usage-report';
import { useEffect, useState, type FormEvent } from 'react';
import type { CompleteUsageReport, CompleteUsageQuery, CompleteUsageGroup, UsageAdditives } from '../../../shared/usage-report';
import type { CompleteUsageData as PersonalUsageData } from '../hooks/use-personal-usage';
import { usageCaveats, eventFields, prepareUsageFile, prepareUsageGroupsFile, downloadUsageFile, usageQueryTemplate } from '../complete-usage';
import { usageMoney, type UsageKeyName } from '../personal-usage';
import { PersonalUsageTimeSeries } from '../analytics-charts';
const iso=(n:number)=>new Date(n).toISOString();
const count=(n:number|null)=>n===null?'Not reported':n.toLocaleString('en-US');
const filterLabels = {user: 'User', model: 'Model', provider: 'Provider', status: 'Status', lane: 'Billing lane', costClass: 'Price quality'} as const;

function filterDescription({key, ...filters}: CompleteUsageQuery['filters']) {
  const parts = [key ? 'Key: ' + (key.kind === 'session' ? 'Dashboard session' : key.id) : 'All keys and dashboard sessions'];
  for (const field of Object.keys(filterLabels) as Array<keyof typeof filterLabels>) {
    if (filters[field] !== undefined) parts.push(filterLabels[field] + ': ' + filters[field]);
  }
  return parts.join(' · ');
}

function ReportScope({report, label = 'Displayed report scope', onClearKey}: {report: CompleteUsageReport; label?: string; onClearKey?: (button: HTMLButtonElement) => void}) {
  const {query, coverage} = report;
  const clipped = coverage.clippedFrom !== null && query.from === coverage.effectiveFrom;
  const dates = new Intl.DateTimeFormat('en', {dateStyle: 'medium', timeStyle: 'short', timeZone: query.timezone});
  return <div className="personalActions personalActiveFilters" role="group" aria-label={label}>
    <strong>{filterDescription(query.filters)}</strong>
    <span>{clipped ? 'Retained interval: ' : ''}{dates.formatRange(query.from, query.to)} · {query.timezone} (end exclusive)</span>
    {query.filters.key && onClearKey ? <button type="button" className="buttonSecondary" onClick={event => onClearKey(event.currentTarget)}>Clear key filter</button> : null}
  </div>;
}
function Recorded({value}:{value:UsageAdditives}) {return <><strong>{value.chargeReportedCalls?usageMoney(value.recordedChargeMicros):'Not reported'}</strong>{' '}<small className="personalNote">{count(value.chargeReportedCalls)}/{count(value.metrics.calls)} rows with a valid recorded accounting field</small></>;}
export function UsageCoverage({value}:{value:CompleteUsageReport}) {
  const c=value.coverage;
  return <><details className="personalNote personalRange"><summary>Report scope and capture dates</summary>
    <p>Reported interval: {iso(value.query.from)} → {iso(value.query.to)} (end exclusive) · {value.query.timezone}</p>
    <p>Captured between {iso(c.capturedBetween.from)} and {iso(c.capturedBetween.to)}. This is a read boundary, not settlement freshness.</p>
    {c.clippedFrom!==null?<p>Start clipped from {iso(c.clippedFrom)} to retained data at {iso(c.effectiveFrom)}.</p>:null}
    <p>Location tracking started {iso(c.captureAudit.startedAt)}; verified since {iso(c.captureAudit.verifiedSince)}.</p>
    {value.query.from<c.captureAudit.verifiedSince?<p>This range predates the verified tracking interval; the audit does not quantify missing usage.</p>:null}
  </details>{c.captureAudit.captureGapObserved?<p className="personalNote" role="status">Location tracking had a gap or incomplete capture; affected usage is unknown.</p>:null}</>;
}
export function PersonalUsageSummary({data,onOpen}:{data:PersonalUsageData;onOpen?:()=>void;keys?:readonly UsageKeyName[]}) {
  const value=data.report.value;
  return <section className="dashboardPanel personalUsageSummary">
    <header className="personalSectionHeader"><h2>{data.audience==='admin'?'Usage in discovered locations':'For your current access'}</h2>{onOpen?<button type="button" onClick={onOpen}>Open My usage</button>:null}</header>
    <p>{usageCaveats[data.audience]}</p>
    {data.report.loading?<p role="status">Loading complete usage…</p>:null}
    {data.report.error?<div role="alert"><p>{data.report.error}</p>{value?<p>Old displayed data; Refresh required before continuing.</p>:null}<button type="button" onClick={data.reload}>Refresh report</button></div>:null}
    {value?<><UsageCoverage value={value}/><dl className="personalGlance">
      <div><dt>Model calls</dt><dd>{count(value.metrics.calls)}</dd><dd className="personalGlanceMeta">{count(value.metrics.generationCalls)} generation · {count(value.metrics.utilityCalls)} utility</dd><dd className="personalGlanceMeta">{count(value.metrics.errorCalls)} errors · {count(value.metrics.deniedCalls)} denied</dd></div>
      <div><dt>Input / output tokens</dt><dd>{value.metrics.inputReportedCalls?count(value.metrics.inputTokens):'Not reported'} / {value.metrics.outputReportedCalls?count(value.metrics.outputTokens):'Not reported'}</dd><dd className="personalGlanceMeta">{count(value.metrics.inputReportedCalls)} / {count(value.metrics.outputReportedCalls)} calls with each field</dd></div>
      <div><dt>Recorded accounting amount</dt><dd><Recorded value={value}/></dd></div>
    </dl><p>{usageCaveats.accounting}</p>{value.metrics.calls===0?<p>No calls in discovered locations for this range{data.audience==='personal'?' for your current access':''}.</p>:null}</>:null}
  </section>;
}
function Controls({data,keys}:{data:PersonalUsageData;keys:readonly UsageKeyName[]}) {
  const q=data.query??data.requestedQuery,selectedFrom=data.rangeInput?.from??(q?iso(data.selectedQuery?.from??q.from):''),selectedTo=data.rangeInput?.to??(q?iso(data.selectedQuery?.to??q.to):'');
  const [draft,setDraft]=useState(()=>q??data.queryTemplate??usageQueryTemplate(data.audience)),[from,setFrom]=useState(selectedFrom),[to,setTo]=useState(selectedTo);
  useEffect(()=>{setDraft(q??data.queryTemplate??usageQueryTemplate(data.audience));setFrom(selectedFrom);setTo(selectedTo);},[q,data.queryTemplate,data.audience,selectedFrom,selectedTo]);
  function refine(next:typeof draft){setDraft(next);if(data.query&&!data.report.error)data.refine({...data.query,...next});}
  function apply(event:FormEvent,openNew=false){event.preventDefault();if(draft)data.customRange(draft,{from,to,timezone:draft.timezone},openNew);}
  const groups = data.audience === 'admin' ? ['user','key','model','provider'] as const : ['key','model','provider'] as const;
  const report = data.query;
  function clearKey(button: HTMLButtonElement) {
    if (!report) return;
    // The clear action disappears with its filter; leave focus on the active comparison.
    button.form?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]')?.focus();
    const filters = {...report.filters};
    delete filters.key;
    data.refine({...report, filters, rankOffset: 0});
  }
  return <form className="dashboardPanel personalControls personalCompactControls" onSubmit={apply} aria-label="Usage filters">
    <div className="personalSectionHeader">
      <div className="personalControlRow">
        <strong>Compare usage</strong>
        <div className="personalActions" role="group" aria-label="Compare usage">{groups.map(group => <button type="button" key={group} className="buttonSecondary" aria-pressed={q?.groupBy === group}
          disabled={!q || !!data.report.error} aria-disabled={!report || !!data.report.error}
          onClick={() => report && report.groupBy !== group && data.refine({...report, groupBy: group, rankOffset: 0})}>By {group}</button>)}</div>
      </div>
      <div className="personalActions">
        <button type="button" className="buttonSecondary" onClick={()=>data.preset(7,draft)}>Last 7 days</button><button type="button" className="buttonSecondary" onClick={()=>data.preset(30,draft)}>Last 30 days</button><button type="button" className="buttonSecondary" onClick={data.reload}>Refresh report</button><button type="button" className="buttonSecondary" disabled={!report || !!data.report.error} onClick={data.back}>Back to base</button>
      </div>
    </div>
    {data.report.value ? <ReportScope report={data.report.value} onClearKey={data.report.error ? undefined : clearKey}/> : null}
    {draft?<details className="personalAdvanced"><summary>Custom interval and exact filters</summary><p>Calendar dates in the chosen IANA timezone or RFC3339 instants; end exclusive. Widening opens a new base. Maximum 30 days; minute grain requires at most 24 hours.</p><div className="personalFilterGrid">
    <label>Group by<select value={draft.groupBy} onChange={e=>refine({...draft,groupBy:e.target.value as CompleteUsageQuery['groupBy'],rankOffset:0})}>{groups.map(k=><option key={k}>{k}</option>)}</select></label>
    <label>Rank by<select value={draft.rankBy} onChange={e=>refine({...draft,rankBy:e.target.value as CompleteUsageQuery['rankBy'],rankOffset:0})}><option value="calls">Calls</option><option value="tokens">Reported input + output tokens</option><option value="recordedAmount">Recorded accounting amount</option></select></label>
    {data.audience==='personal'?<label>Current own-key selector<select value={draft.filters.key?.kind==='session'?'session':draft.filters.key?.kind==='credential'?'key:'+draft.filters.key.id:''} onChange={e=>{const filters={...draft.filters};delete filters.key;if(e.target.value==='session')filters.key={kind:'session'};else if(e.target.value)filters.key={kind:'credential',id:e.target.value.slice(4)};refine({...draft,filters,rankOffset:0});}}><option value="">All keys in this base</option><option value="session">Dashboard session</option>{keys.map(k=><option key={k.credentialId} value={'key:'+k.credentialId}>{k.name? 'Current name: '+k.name+' — ':''}{k.credentialId}</option>)}</select></label>:null}
    <label>Start<input required value={from} onChange={e=>setFrom(e.target.value)}/></label><label>End<input required value={to} onChange={e=>setTo(e.target.value)}/></label>
    <label>Timezone<input required value={draft.timezone} onChange={e=>setDraft({...draft,timezone:e.target.value})}/></label><label>Grain<select value={draft.grain} onChange={e=>setDraft({...draft,grain:e.target.value as 'day'|'minute'})}><option>day</option><option>minute</option></select></label>
    {(data.audience==='admin'?['user','model','provider','status','lane','costClass'] as const:['model','provider','status','lane','costClass'] as const).map(k=><label key={k}>{k} (exact)<input maxLength={512} value={draft.filters[k]??''} onChange={e=>{const filters={...draft.filters};if(e.target.value)filters[k]=e.target.value;else delete filters[k];setDraft({...draft,filters});}}/></label>)}
  </div><button type="submit">Apply refinement</button><button type="button" onClick={event=>apply(event,true)}>Open as new base</button></details>:null}</form>;
}
function selectGroup(data:PersonalUsageData,group:CompleteUsageGroup) {
  const q=data.query;if(!q || data.report.error)return;const filters={...q.filters};
  if(q.groupBy==='user'){if(group.identity.value===null)return;filters.user=group.identity.value;data.refine({...q,filters,groupBy:'key',rankOffset:0});}
  else if(q.groupBy==='key'){if(data.audience==='admin'){if(group.identity.owner===null)return;filters.user=group.identity.owner;}filters.key=group.identity.value===null?{kind:'session'}:{kind:'credential',id:group.identity.value};data.refine({...q,filters,rankOffset:0});data.showEvents(true);}
  else if(group.identity.value!==null){filters[q.groupBy]=group.identity.value;data.refine({...q,filters,rankOffset:0});}
}
function DetailTotals({value}:{value:UsageAdditives}) {return <><dl className="personalTokenStats">{usageTokenFields.map(([k,presenceKey])=>{const present=value.metrics[presenceKey];return <div key={k}><dt>{k}</dt><dd>{present?count(value.metrics[k]):'Not reported'}</dd><dd>{count(present)}/{count(value.metrics.calls)} calls with field</dd></div>;})}</dl><ul>{value.costs.map(c=><li key={c.lane+':'+c.costClass}>{c.lane} · {c.costClass}: {c.costClass==='unknown'?'Price unknown':usageMoney(c.amountMicros)} · {count(c.calls)} calls</li>)}</ul><p>{usageCaveats.missingness} Subscription amounts are usage equivalents, not additional charges.</p></>;}
export function ExactRanking({data}:{data:PersonalUsageData}) {
  const value=data.report.value,q=value?.query;if(!value||!q)return null;
  const stale = Boolean(data.report.error);
  const byKey = q.groupBy === 'key';
  return (<section className="dashboardPanel personalSection">
      <header className="personalSectionHeader">
        <div><h2>Exact ranking by {q.groupBy}</h2><p>{count(value.rank.distinctGroups)} retained {value.rank.distinctGroups === 1 ? 'identity' : 'identities'}. Historical keys use retained IDs, not current names.</p></div>
        <div className="personalControlRow">
          <label>Rank&nbsp;by<select disabled={stale} value={q.rankBy} onChange={e => data.refine({...q, rankBy: e.target.value as CompleteUsageQuery['rankBy'], rankOffset: 0})}>
            <option value="calls">Calls</option><option value="tokens">Reported input + output tokens</option><option value="recordedAmount">Recorded accounting amount</option>
          </select></label>
          <button type="button" className="buttonSecondary" disabled={stale} onClick={() => downloadUsageFile(prepareUsageGroupsFile(value,data.audience))}>Export current rank page CSV</button>
        </div>
      </header>
      <p className="personalNote">{filterDescription(q.filters)}{stale ? ' · Last successful report. Retry the report to use this ranking.' : q.groupBy === 'key' && !q.filters.key ? ' · Select a key to filter the report and its events.' : ''}</p>
      <div className="personalTableWrap" tabIndex={0} role="region" aria-label="Retained usage ranking">
        <table className={byKey ? 'personalTable retainedKeyRanking' : 'personalTable'}>
          <thead><tr><th>Retained identity</th><th>Model calls</th><th>Input / output tokens</th><th>Recorded accounting amount</th></tr></thead>
          <tbody>{value.groups.map(g => <tr key={JSON.stringify(g.identity)}>
            <th scope="row"><button type="button" className={byKey ? 'buttonSecondary' : undefined}
              disabled={stale || (!byKey && g.identity.value === null) || (byKey && data.audience === 'admin' && g.identity.owner === null)}
              onClick={() => selectGroup(data,g)}>
              {byKey ? (g.identity.owner ?? 'Unavailable owner') + ' · ' + (g.identity.value ?? 'Dashboard session') : (g.identity.value ?? 'Unavailable identity')}
            </button></th>
            <td>{count(g.metrics.calls)}</td>
            <td>{g.metrics.inputReportedCalls ? count(g.metrics.inputTokens) : 'Not reported'} / {g.metrics.outputReportedCalls ? count(g.metrics.outputTokens) : 'Not reported'}</td>
            <td><Recorded value={g}/></td>
          </tr>)}</tbody>
        </table>
      </div>
      <p>Exact remainder outside this rank page: {count(value.remainder.metrics.calls)} calls.</p><details><summary>Remainder field and money coverage</summary><Recorded value={value.remainder}/><DetailTotals value={value.remainder}/></details>
      <div className="personalActions"><button type="button" disabled={stale || !value.rank.offset} onClick={()=>data.refine({...q,rankOffset:Math.max(0,value.rank.offset-100)})}>Previous ranks</button><button type="button" disabled={stale || !value.rank.hasMore} onClick={()=>data.refine({...q,rankOffset:value.rank.offset+100})}>Next ranks</button><button type="button" disabled={stale && !data.eventsShown} onClick={()=>data.showEvents(!data.eventsShown)}>{data.eventsShown?'Hide':'Show'} events</button></div>
    </section>);
}
export function CompleteUsageScreen({data,keys=[]}:{data:PersonalUsageData;keys?:readonly UsageKeyName[]}) {
  const value=data.report.value,q=value?.query,events=data.events.value;
  useEffect(()=>()=>data.showEvents(false),[data.showEvents]);
  return <div className="personalUsageCanvas"><Controls data={data} keys={keys}/><PersonalUsageSummary data={data}/>
    {value&&q?<><ExactRanking data={data}/><section className="dashboardPanel personalSection"><h2>Exact usage over time</h2><PersonalUsageTimeSeries label={'Calls by '+q.grain} formatValue={n=>count(n)} points={value.buckets.map(b=>({start:b.start,end:b.end,label:b.label,value:b.metrics.calls,partial:false}))}/><details><summary>Time bucket data</summary>{value.buckets.map(b=><p key={b.start}>{b.label}: {count(b.metrics.calls)} calls ({iso(b.start)} → {iso(b.end)})</p>)}</details></section>
    <section className="dashboardPanel personalSection"><h2>Fields and cost quality</h2><DetailTotals value={value}/></section>
    {data.eventsShown?<section className="dashboardPanel personalSection"><h2>Retained events</h2>{data.events.loading?<p role="status">Loading events…</p>:null}{data.events.error?<div role="alert"><p>{data.events.error}</p><p>Old displayed report; Refresh required. It is not a current usable snapshot.</p><button type="button" onClick={data.retryEvents}>Retry event page</button><button type="button" onClick={data.reload}>Refresh report</button></div>:null}
      {events?<><p>Page {data.page} · at most 100 events · metadata only</p><div className="personalTableWrap" tabIndex={0} role="region" aria-label="Retained events"><table className="personalTable"><thead><tr><th>Time</th><th>Model / key</th><th>Outcome</th><th>Input / output</th><th>Recorded accounting amount</th></tr></thead><tbody>{events.events.map((e,i)=><tr key={i+':'+e.id}><td>{iso(e.occurredAt)}</td><td>{e.model??'Unavailable model'} · {e.keyId??'Dashboard session'}<details><summary>Call details</summary><dl className="personalEventDetails">{eventFields.map(k=><div key={k}><dt>{k==='recordedChargeMicros'?'Recorded accounting amount (micros)':k}</dt><dd>{e[k]??'Not reported'}</dd></div>)}</dl></details></td><td>{e.status}</td><td>{count(e.inputTokens)} / {count(e.outputTokens)}</td><td>{usageMoney(e.recordedChargeMicros)}</td></tr>)}</tbody></table></div><div className="personalActions"><button type="button" disabled={!data.canPrevious} onClick={data.previousPage}>Previous page</button><button type="button" disabled={!events.nextCursor} onClick={data.nextPage}>Next page</button><button type="button" onClick={()=>downloadUsageFile(prepareUsageFile(value,events.events,data.audience,'csv','current page '+data.page))}>Export current page CSV</button></div></>:null}
    </section>:null}
    <CompleteExport data={data}/></>:null}
  </div>;
}

export function CompleteExport({data}: {data: PersonalUsageData}) {
  const {busy, message, report: exported} = data.exportState;
  const stale = Boolean(data.report.error && data.report.value);
  const disabled = busy || !data.query || Boolean(data.report.error);
  return <section className="dashboardPanel personalSection">
    <h2>Export refreshed snapshot</h2>
    {stale ? <p className="personalNote">Last successful report. Retry the report before starting another export.</p>
      : <p>Same selected range and filters; captures current usage again. Every matching retained event in the disclosed discovered scope, not all global history. Totals may differ from the displayed report. Up to 50,000 events / 16 MiB.</p>}
    <div className="personalActions">
      <button type="button" disabled={disabled} onClick={() => void data.startExport('csv')}>Export refreshed snapshot CSV</button>
      <button type="button" disabled={disabled} onClick={() => void data.startExport('json')}>Export refreshed snapshot JSON</button>
      {busy ? <button type="button" onClick={data.cancelExport}>Cancel export</button> : null}
    </div>
    <p role="status">{message}</p>
    {exported ? <><h3>Fresh export snapshot</h3><ReportScope report={exported} label="Export snapshot scope"/>
      <p>{count(exported.metrics.calls)} calls · <Recorded value={exported}/></p>
      <p>{usageCaveats[data.audience]}</p><UsageCoverage value={exported}/></> : null}
  </section>;
}
