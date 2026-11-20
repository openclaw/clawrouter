import { useEffect, useState, type FormEvent } from 'react';
import type { CompleteUsageReport, CompleteUsageQuery, CompleteUsageGroup, UsageAdditives } from '../../../shared/usage-report';
import type { CompleteUsageData as PersonalUsageData } from '../hooks/use-personal-usage';
import { usageCaveats, eventFields, prepareUsageFile, prepareUsageGroupsFile, downloadUsageFile, usageQueryTemplate } from '../complete-usage';
import { usageMoney, type UsageKeyName } from '../personal-usage';
import { PersonalUsageTimeSeries } from '../analytics-charts';
const iso=(n:number)=>new Date(n).toISOString();
const count=(n:number|null)=>n===null?'Not reported':n.toLocaleString('en-US');
function Recorded({value}:{value:UsageAdditives}) {return <><strong>{value.chargeReportedCalls?usageMoney(value.recordedChargeMicros):'Not reported'}</strong><small>{count(value.chargeReportedCalls)}/{count(value.metrics.calls)} rows with a valid recorded accounting field</small></>;}
export function UsageCoverage({value}:{value:CompleteUsageReport}) {
  const c=value.coverage;
  return <><details className="personalNote personalRange"><summary>Report scope and capture dates</summary>
    <p>Selected interval: {iso(value.query.from)} → {iso(value.query.to)} (end exclusive) · {value.query.timezone}</p>
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
      <div><dt>Model calls</dt><dd>{count(value.metrics.calls)}</dd><dd><small>{count(value.metrics.generationCalls)} generation · {count(value.metrics.utilityCalls)} utility</small></dd></div>
      <div><dt>Input / output tokens</dt><dd>{value.metrics.inputReportedCalls?count(value.metrics.inputTokens):'Not reported'} / {value.metrics.outputReportedCalls?count(value.metrics.outputTokens):'Not reported'}</dd><dd><small>{count(value.metrics.inputReportedCalls)} / {count(value.metrics.outputReportedCalls)} calls with each field</small></dd></div>
      <div><dt>Recorded accounting amount</dt><dd><Recorded value={value}/></dd></div>
      <div><dt>Errors / denied</dt><dd>{count(value.metrics.errorCalls)} / {count(value.metrics.deniedCalls)}</dd></div>
    </dl><p>{usageCaveats.accounting}</p>{value.metrics.calls===0?<p>No calls in discovered locations for this range{data.audience==='personal'?' for your current access':''}.</p>:null}</>:null}
  </section>;
}
function Controls({data,keys}:{data:PersonalUsageData;keys:readonly UsageKeyName[]}) {
  const q=data.query??data.requestedQuery,selectedFrom=data.rangeInput?.from??(q?iso(data.selectedQuery?.from??q.from):''),selectedTo=data.rangeInput?.to??(q?iso(data.selectedQuery?.to??q.to):'');
  const [draft,setDraft]=useState(()=>q??data.queryTemplate??usageQueryTemplate(data.audience)),[from,setFrom]=useState(selectedFrom),[to,setTo]=useState(selectedTo);
  useEffect(()=>{setDraft(q??data.queryTemplate??usageQueryTemplate(data.audience));setFrom(selectedFrom);setTo(selectedTo);},[q,data.queryTemplate,data.audience,selectedFrom,selectedTo]);
  function refine(next:typeof draft){setDraft(next);if(data.query&&!data.report.error)data.refine({...data.query,...next});}
  function apply(event:FormEvent,openNew=false){event.preventDefault();if(draft)data.customRange(draft,{from,to,timezone:draft.timezone},openNew);}
  return <form className="dashboardPanel personalControls" onSubmit={apply} aria-label="Usage filters"><div className="personalActions">
    <button type="button" onClick={()=>data.preset(7,draft)}>Last 7 days</button><button type="button" onClick={()=>data.preset(30,draft)}>Last 30 days</button><button type="button" onClick={data.reload}>Refresh report</button><button type="button" disabled={!q} onClick={data.back}>Back to base</button>
  </div>{draft?<><div className="personalFilterGrid">
    <label>Group by<select value={draft.groupBy} onChange={e=>refine({...draft,groupBy:e.target.value as CompleteUsageQuery['groupBy'],rankOffset:0})}>{(data.audience==='admin'?['user','key','model','provider']:['key','model','provider']).map(k=><option key={k}>{k}</option>)}</select></label>
    <label>Rank by<select value={draft.rankBy} onChange={e=>refine({...draft,rankBy:e.target.value as CompleteUsageQuery['rankBy'],rankOffset:0})}><option value="calls">Calls</option><option value="tokens">Reported input + output tokens</option><option value="recordedAmount">Recorded accounting amount</option></select></label>
    {data.audience==='personal'?<label>Current own-key selector<select value={draft.filters.key?.kind==='session'?'session':draft.filters.key?.kind==='credential'?'key:'+draft.filters.key.id:''} onChange={e=>{const filters={...draft.filters};delete filters.key;if(e.target.value==='session')filters.key={kind:'session'};else if(e.target.value)filters.key={kind:'credential',id:e.target.value.slice(4)};refine({...draft,filters,rankOffset:0});}}><option value="">All keys in this base</option><option value="session">Dashboard session</option>{keys.map(k=><option key={k.credentialId} value={'key:'+k.credentialId}>{k.name? 'Current name: '+k.name+' — ':''}{k.credentialId}</option>)}</select></label>:null}
  </div><details><summary>Custom interval and exact filters</summary><p>Calendar dates in the chosen IANA timezone or RFC3339 instants; end exclusive. Widening opens a new base. Maximum 30 days; minute grain requires at most 24 hours.</p><div className="personalFilterGrid">
    <label>Start<input required value={from} onChange={e=>setFrom(e.target.value)}/></label><label>End<input required value={to} onChange={e=>setTo(e.target.value)}/></label>
    <label>Timezone<input required value={draft.timezone} onChange={e=>setDraft({...draft,timezone:e.target.value})}/></label><label>Grain<select value={draft.grain} onChange={e=>setDraft({...draft,grain:e.target.value as 'day'|'minute'})}><option>day</option><option>minute</option></select></label>
    {(data.audience==='admin'?['user','model','provider','status','lane','costClass'] as const:['model','provider','status','lane','costClass'] as const).map(k=><label key={k}>{k} (exact)<input maxLength={512} value={draft.filters[k]??''} onChange={e=>{const filters={...draft.filters};if(e.target.value)filters[k]=e.target.value;else delete filters[k];setDraft({...draft,filters});}}/></label>)}
  </div><button type="submit">Apply refinement</button><button type="button" onClick={event=>apply(event,true)}>Open as new base</button></details></>:null}</form>;
}
function selectGroup(data:PersonalUsageData,group:CompleteUsageGroup) {
  const q=data.query;if(!q)return;const filters={...q.filters};
  if(q.groupBy==='user'){if(group.identity.value===null)return;filters.user=group.identity.value;data.refine({...q,filters,groupBy:'key',rankOffset:0});}
  else if(q.groupBy==='key'){if(data.audience==='admin'){if(group.identity.owner===null)return;filters.user=group.identity.owner;}filters.key=group.identity.value===null?{kind:'session'}:{kind:'credential',id:group.identity.value};data.refine({...q,filters,rankOffset:0});data.showEvents(true);}
  else if(group.identity.value!==null){filters[q.groupBy]=group.identity.value;data.refine({...q,filters,rankOffset:0});}
}
function DetailTotals({value}:{value:UsageAdditives}) {return <><dl className="personalTokenStats">{(['inputTokens','outputTokens','cachedInputTokens','cacheWriteInputTokens','reasoningOutputTokens'] as const).map((k,i)=>{const present=value.metrics[(['inputReportedCalls','outputReportedCalls','cacheReadReportedCalls','cacheWriteReportedCalls','reasoningReportedCalls'] as const)[i]];return <div key={k}><dt>{k}</dt><dd>{present?count(value.metrics[k]):'Not reported'}</dd><dd>{count(present)}/{count(value.metrics.calls)} calls with field</dd></div>;})}</dl><ul>{value.costs.map(c=><li key={c.lane+':'+c.costClass}>{c.lane} · {c.costClass}: {c.costClass==='unknown'?'Price unknown':usageMoney(c.amountMicros)} · {count(c.calls)} calls</li>)}</ul><p>{usageCaveats.missingness} Subscription amounts are usage equivalents, not additional charges.</p></>;}
export function ExactRanking({data}:{data:PersonalUsageData}) {
  const value=data.report.value,q=value?.query;if(!value||!q)return null;
  return (<section className="dashboardPanel personalSection"><h2>Exact ranking by {q.groupBy}</h2><button type="button" onClick={()=>downloadUsageFile(prepareUsageGroupsFile(value,data.audience))}>Export current rank page CSV</button><label>Rank by<select value={q.rankBy} onChange={e=>data.refine({...q,rankBy:e.target.value as CompleteUsageQuery['rankBy'],rankOffset:0})}><option value="calls">Calls</option><option value="tokens">Reported input + output tokens</option><option value="recordedAmount">Recorded accounting amount</option></select></label><p>{value.rank.distinctGroups} retained identities. Historical keys use retained IDs only; current names do not rename historical events.</p><p>Filters: {JSON.stringify(q.filters)}</p>
      <div className="personalTableWrap" tabIndex={0} role="region" aria-label="Retained usage ranking"><table className="personalTable"><thead><tr><th>Retained identity</th><th>Calls</th><th>Input / output</th><th>Recorded accounting amount</th></tr></thead><tbody>{value.groups.map(g=><tr key={JSON.stringify(g.identity)}><th scope="row"><button type="button" disabled={q.groupBy==='user'&&g.identity.value===null||q.groupBy==='key'&&data.audience==='admin'&&g.identity.owner===null} onClick={()=>selectGroup(data,g)}>{q.groupBy==='key'?(g.identity.owner??'Unavailable owner')+' · '+(g.identity.value??'Dashboard session'):(g.identity.value??'Unavailable identity')}</button></th><td>{count(g.metrics.calls)}</td><td>{g.metrics.inputReportedCalls?count(g.metrics.inputTokens):'Not reported'} / {g.metrics.outputReportedCalls?count(g.metrics.outputTokens):'Not reported'}</td><td><Recorded value={g}/></td></tr>)}</tbody></table></div>
      <p>Exact remainder outside this rank page: {count(value.remainder.metrics.calls)} calls.</p><details><summary>Remainder field and money coverage</summary><Recorded value={value.remainder}/><DetailTotals value={value.remainder}/></details>
      <div className="personalActions"><button type="button" disabled={!value.rank.offset} onClick={()=>data.refine({...q,rankOffset:Math.max(0,value.rank.offset-100)})}>Previous ranks</button><button type="button" disabled={!value.rank.hasMore} onClick={()=>data.refine({...q,rankOffset:value.rank.offset+100})}>Next ranks</button><button type="button" onClick={()=>data.showEvents(!data.eventsShown)}>{data.eventsShown?'Hide':'Show'} events</button></div>
    </section>);
}
export function CompleteUsageScreen({data,keys=[]}:{data:PersonalUsageData;keys?:readonly UsageKeyName[]}) {
  const value=data.report.value,q=value?.query,events=data.events.value;
  useEffect(()=>()=>data.showEvents(false),[data.showEvents]);
  return <div className="personalUsageCanvas"><Controls data={data} keys={keys}/><PersonalUsageSummary data={data}/>
    {value&&q?<><section className="dashboardPanel personalSection"><h2>Exact usage over time</h2><PersonalUsageTimeSeries label={'Calls by '+q.grain} formatValue={n=>count(n)} points={value.buckets.map(b=>({start:b.start,end:b.end,label:b.label,value:b.metrics.calls,partial:false}))}/><details><summary>Time bucket data</summary>{value.buckets.map(b=><p key={b.start}>{b.label}: {count(b.metrics.calls)} calls ({iso(b.start)} → {iso(b.end)})</p>)}</details></section>
    <ExactRanking data={data}/><section className="dashboardPanel personalSection"><h2>Fields and cost quality</h2><DetailTotals value={value}/></section>
    {data.eventsShown?<section className="dashboardPanel personalSection"><h2>Retained events</h2>{data.events.loading?<p role="status">Loading events…</p>:null}{data.events.error?<div role="alert"><p>{data.events.error}</p><p>Old displayed report; Refresh required. It is not a current usable snapshot.</p><button type="button" onClick={data.retryEvents}>Retry event page</button><button type="button" onClick={data.reload}>Refresh report</button></div>:null}
      {events?<><p>Page {data.page} · at most 100 events · metadata only</p><div className="personalTableWrap" tabIndex={0} role="region" aria-label="Retained events"><table className="personalTable"><thead><tr><th>Time</th><th>Model / key</th><th>Outcome</th><th>Input / output</th><th>Recorded accounting amount</th></tr></thead><tbody>{events.events.map((e,i)=><tr key={i+':'+e.id}><td>{iso(e.occurredAt)}</td><td>{e.model??'Unavailable model'} · {e.keyId??'Dashboard session'}<details><summary>Call details</summary><dl className="personalEventDetails">{eventFields.map(k=><div key={k}><dt>{k==='recordedChargeMicros'?'Recorded accounting amount (micros)':k}</dt><dd>{e[k]??'Not reported'}</dd></div>)}</dl></details></td><td>{e.status}</td><td>{count(e.inputTokens)} / {count(e.outputTokens)}</td><td>{usageMoney(e.recordedChargeMicros)}</td></tr>)}</tbody></table></div><div className="personalActions"><button type="button" disabled={!data.canPrevious} onClick={data.previousPage}>Previous page</button><button type="button" disabled={!events.nextCursor} onClick={data.nextPage}>Next page</button><button type="button" onClick={()=>downloadUsageFile(prepareUsageFile(value,events.events,data.audience,'csv','current page '+data.page))}>Export current page CSV</button></div></>:null}
    </section>:null}
    <CompleteExport data={data}/></>:null}
  </div>;
}

export function CompleteExport({data}:{data:PersonalUsageData}) { return (<section className="dashboardPanel personalSection"><h2>Export refreshed snapshot</h2><p>Same selected range and filters; captures current usage again. Every matching retained event in the disclosed discovered scope, not all global history. Totals may differ from the displayed report. Up to 50,000 events / 16 MiB.</p><div className="personalActions"><button type="button" disabled={data.exportState.busy||!data.query} onClick={()=>void data.startExport('csv')}>Export refreshed snapshot CSV</button><button type="button" disabled={data.exportState.busy||!data.query} onClick={()=>void data.startExport('json')}>Export refreshed snapshot JSON</button>{data.exportState.busy?<button type="button" onClick={data.cancelExport}>Cancel export</button>:null}</div><p role="status">{data.exportState.message}</p>{data.exportState.report?<><h3>Fresh export snapshot</h3><p>{count(data.exportState.report.metrics.calls)} calls · <Recorded value={data.exportState.report}/></p><p>{usageCaveats[data.audience]}</p><UsageCoverage value={data.exportState.report}/></>:null}</section>); }
