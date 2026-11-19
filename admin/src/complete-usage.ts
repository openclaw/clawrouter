import type { CompleteUsageQuery, CompleteUsageReport, CompleteUsageEvents, CompleteUsageEvent, CompleteUsageOutcome, UsageAdditives, UsageMetrics, UsageCostLane, UsageCostClass } from '../../shared/usage-report';
import type { ConsoleRequest } from './dashboard-fetch';
import { parseUsageRangeInput, type UsageRangeInput } from './usage-range';
export type UsageAudience = 'admin' | 'personal';
export type UsageQueryTemplate = Omit<CompleteUsageQuery,'from'|'to'>;
/** Controls can exist before data; no invented interval, report or capability. */
export function usageQueryTemplate(audience:UsageAudience):UsageQueryTemplate {
  return {timezone:'UTC',grain:'day',groupBy:audience==='admin'?'user':'model',rankBy:'calls',rankOffset:0,filters:{}};
}
export const usageCaveats = {
  admin: "Includes current policy locations and former locations still tracked within the authority's 30-day window. Other former locations may contain retained calls, including calls recorded after a move. Not all historical locations have been assessed.",
  personal: 'For your current access. Earlier access and locations are not claimed covered. Other former locations may contain retained calls, including calls recorded after a move. Not all historical locations have been assessed.',
  accounting: 'Value retained in the usage ledger; not proof of upstream price or completed budget settlement. Settlement-confirmation evidence is unavailable.',
  missingness: 'Missing token or monetary fields are not inferred zeros. Presence counts describe retained fields, not provider confirmation. Reporting costs remain separate by lane and price class; unknown is not free.',
};
export const metricKeys = ['calls','generationCalls','utilityCalls','successfulCalls','errorCalls','deniedCalls','inputTokens','outputTokens','cachedInputTokens','cacheWriteInputTokens','reasoningOutputTokens','inputReportedCalls','outputReportedCalls','cacheReadReportedCalls','cacheWriteReportedCalls','reasoningReportedCalls'] as const;
export const eventFields = ['id','occurredAt','user','provider','model','keyId','capability','callKind','status','statusCode','durationMs','inputTokens','outputTokens','cachedInputTokens','cacheWriteInputTokens','reasoningOutputTokens','lane','costClass','reportingCostMicros','estimateReason','recordedChargeMicros','costBasis','pricingRef','requestedTier','servedTier','compoundRequestId','compoundStage'] as const;
const lanes = ['api','subscription','unattributed'], classes = ['calculated','fixed','estimated','upper_bound','partial','unknown','no_charge'];
const bytes = (s: string) => new TextEncoder().encode(s).length;
const bound = 16*1024*1024;
function fail(message = 'Export did not reconcile; no file was created'): never { throw new Error(message); }
function safe(value: unknown): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) fail(); return value; }
function plus(a: number,b: number) { return safe(safe(a)+safe(b)); }
export function usageEndpoint(audience: UsageAudience) { return audience === 'admin' ? '/v1/admin/usage' : '/v1/session/usage'; }
/** Original date-only syntax is for fresh reads only; continuations use numeric bounds. */
export function completeQueryString(query: CompleteUsageQuery, audience: UsageAudience, rangeInput?: UsageRangeInput): URLSearchParams {
  const p = new URLSearchParams({from:new Date(query.from).toISOString(),to:new Date(query.to).toISOString(),timezone:query.timezone,grain:query.grain,groupBy:query.groupBy,rankBy:query.rankBy,rankOffset:String(query.rankOffset??0)});
  if(rangeInput&&/^\d{4}-\d{2}-\d{2}$/.test(rangeInput.from)&&/^\d{4}-\d{2}-\d{2}$/.test(rangeInput.to)){
    const range=parseUsageRangeInput(rangeInput);
    if(rangeInput.timezone!==query.timezone||range.from!==query.from||range.to!==query.to)fail('Selected calendar range does not match query');
    p.set('from',rangeInput.from);p.set('to',rangeInput.to);
  }
  for (const [key,value] of Object.entries(query.filters)) {
    if (key === 'user' && audience === 'personal') continue;
    if (key === 'key') { const k=query.filters.key!; p.set('keyKind',k.kind); if(k.kind==='credential')p.set('key',k.id); }
    else if (value !== undefined) p.set(key,String(value));
  }
  return p;
}
export function completeValue<T>(outcome: CompleteUsageOutcome<T>): T {
  if (outcome.kind === 'complete') return outcome.value;
  fail(outcome.kind === 'no_access' ? 'No current access' : outcome.kind === 'outside_retained_range' ? 'Outside retained range' : outcome.kind === 'restart' ? 'Refresh required' : 'Usage unavailable; no file was created');
}
export async function releaseUsage(request: ConsoleRequest, origin: string, audience: UsageAudience, cut: string) {
  try { await request(origin,usageEndpoint(audience)+'/report?'+new URLSearchParams({cut}),{method:'DELETE',keepalive:true}); } catch { /* Fixed server TTL bounds lost cleanup. */ }
}
function empty(): UsageAdditives { return {metrics:Object.fromEntries(metricKeys.map(k=>[k,0])) as unknown as UsageMetrics,recordedChargeMicros:0,chargeReportedCalls:0,costs:[]}; }
function cost(total: UsageAdditives,lane: string,costClass: string,calls: number,amount: number) {
  if(!lanes.includes(lane)||!classes.includes(costClass))fail();
  let c=total.costs.find(c=>c.lane===lane&&c.costClass===costClass);
  if(!c){ c={lane:lane as UsageCostLane,costClass:costClass as UsageCostClass,calls:0,amountMicros:0}; total.costs.push(c); }
  c.calls=plus(c.calls,calls);c.amountMicros=plus(c.amountMicros,amount);
}
function addEvent(total: UsageAdditives,e: CompleteUsageEvent) {
  if(!['generation','utility'].includes(e.callKind)||typeof e.status!=='string'||typeof e.id!=='string'||!e.id)fail();
  const m=total.metrics;
  m.calls=plus(m.calls,1);m.generationCalls=plus(m.generationCalls,Number(e.callKind==='generation'));m.utilityCalls=plus(m.utilityCalls,Number(e.callKind==='utility'));
  m.successfulCalls=plus(m.successfulCalls,Number(e.status==='success'));m.deniedCalls=plus(m.deniedCalls,Number(e.status==='denied'));m.errorCalls=plus(m.errorCalls,Number(e.status!=='success'&&e.status!=='denied'));
  for(const [field,present] of [['inputTokens','inputReportedCalls'],['outputTokens','outputReportedCalls'],['cachedInputTokens','cacheReadReportedCalls'],['cacheWriteInputTokens','cacheWriteReportedCalls'],['reasoningOutputTokens','reasoningReportedCalls']] as const)if(e[field]!==null){m[field]=plus(m[field],safe(e[field]));m[present]=plus(m[present],1);}
  if(e.recordedChargeMicros!==null){total.recordedChargeMicros=plus(total.recordedChargeMicros,safe(e.recordedChargeMicros));total.chargeReportedCalls=plus(total.chargeReportedCalls,1);}
  if(e.costClass==='unknown'?e.reportingCostMicros!==null:e.reportingCostMicros===null)fail();
  cost(total,e.lane,e.costClass,1,e.reportingCostMicros===null?0:safe(e.reportingCostMicros));
}
function vector(total: UsageAdditives): string {
  const costs=empty();for(const c of total.costs)cost(costs,c.lane,c.costClass,safe(c.calls),safe(c.amountMicros));
  return JSON.stringify([metricKeys.map(k=>safe(total.metrics[k])),safe(total.recordedChargeMicros),safe(total.chargeReportedCalls),costs.costs.sort((a,b)=>(a.lane+':'+a.costClass).localeCompare(b.lane+':'+b.costClass))]);
}
function binary(a: string,b: string) { const x=new TextEncoder().encode(a),y=new TextEncoder().encode(b);for(let i=0;i<Math.min(x.length,y.length);i++)if(x[i]!==y[i])return x[i]-y[i];return x.length-y.length; }
/** Explicit projection: never serialize response spreads/capabilities/private metadata. */
export function exportMetadata(report: CompleteUsageReport,audience: UsageAudience,kind='refreshed snapshot') {
  const c=report.coverage,q=report.query;
  return {kind,scope:audience==='admin'?'Usage in discovered locations':'For your current access',caveats:[usageCaveats[audience],usageCaveats.accounting,usageCaveats.missingness],
    range:{from:q.from,to:q.to,timezone:q.timezone},filters:{...(q.filters.user!==undefined?{user:q.filters.user}:{}),...(q.filters.key?{key:q.filters.key.kind==='session'?{kind:'session'}:{kind:'credential',id:q.filters.key.id}}:{}),...Object.fromEntries(['model','provider','status','lane','costClass'].filter(k=>Object.hasOwn(q.filters,k)).map(k=>[k,q.filters[k as keyof typeof q.filters]]))},
    coverage:{authority:c.authority,scope:c.scope,discoveredScopeEnumeration:c.discoveredScopeEnumeration,allDiscoveredSourcesAnswered:c.allDiscoveredSourcesAnswered,retainedAttributionComplete:c.retainedAttributionComplete,historicalLocations:c.historicalLocations,formerLocationLateWrites:c.formerLocationLateWrites,captureAudit:{startedAt:c.captureAudit.startedAt,verifiedSince:c.captureAudit.verifiedSince,captureGapObserved:c.captureAudit.captureGapObserved},effectiveFrom:c.effectiveFrom,clippedFrom:c.clippedFrom,capturedBetween:{from:c.capturedBetween.from,to:c.capturedBetween.to}},
    totals:{metrics:Object.fromEntries(metricKeys.map(k=>[k,report.metrics[k]])),recordedChargeMicros:report.recordedChargeMicros,chargeReportedCalls:report.chargeReportedCalls,costs:report.costs.map(c=>({lane:c.lane,costClass:c.costClass,calls:c.calls,amountMicros:c.amountMicros}))}};
}
function csvCell(value: unknown) { let s=value==null?'':typeof value==='object'?JSON.stringify(value):String(value);if(/^[\s]*[=+@-]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"'; }
export function prepareUsageFile(report: CompleteUsageReport,events: CompleteUsageEvent[],audience: UsageAudience,format:'csv'|'json',kind='refreshed snapshot') {
  const metadata=exportMetadata(report,audience,kind),rows=events.map(e=>Object.fromEntries(eventFields.map(k=>[k,e[k]??null])));
  const content=format==='json'?JSON.stringify({metadata,events:rows}):[['metadata',JSON.stringify(metadata)].map(csvCell).join(',')+'\r\n',eventFields.map(csvCell).join(',')+'\r\n',...rows.map(e=>eventFields.map(k=>csvCell(e[k])).join(',')+'\r\n')].join('');
  if(bytes(content)>bound)fail('Export exceeds 16 MiB; narrow the range or filters');
  return {content,type:format==='json'?'application/json':'text/csv;charset=utf-8',filename:'usage-'+kind.replaceAll(' ','-')+'.'+format,metadata};
}
/** Current rank page only, explicitly distinct from the refreshed full event export. */
export function prepareUsageGroupsFile(report:CompleteUsageReport,audience:UsageAudience) {
  const metadata={...exportMetadata(report,audience,'current rank page'),rank:{offset:report.rank.offset,distinctGroups:report.rank.distinctGroups,hasMore:report.rank.hasMore}};
  const headers=['owner','identity',...metricKeys,'recordedChargeMicros','chargeReportedCalls',...lanes.flatMap(l=>classes.flatMap(c=>[l+'_'+c+'_calls',l+'_'+c+'_amountMicros']))];
  const rows=report.groups.map(g=>[g.identity.owner,g.identity.value,...metricKeys.map(k=>g.metrics[k]),g.recordedChargeMicros,g.chargeReportedCalls,...lanes.flatMap(l=>classes.flatMap(c=>{const v=g.costs.find(v=>v.lane===l&&v.costClass===c);return [v?.calls??0,c==='unknown'?null:v?.amountMicros??null];}))]);
  const newline=String.fromCharCode(13,10);
  const content=[['metadata',JSON.stringify(metadata)],headers,...rows].map(row=>row.map(csvCell).join(',')).join(newline)+newline;
  if(bytes(content)>bound)fail('Export exceeds 16 MiB; narrow the range or filters');
  return {content,type:'text/csv;charset=utf-8',filename:'usage-current-rank-page.csv',metadata};
}
export async function exportRefreshedUsage({request,origin,audience,query,rangeInput,signal,isCurrent,onReport}:{request:ConsoleRequest;origin:string;audience:UsageAudience;query:CompleteUsageQuery;rangeInput?:UsageRangeInput;signal:AbortSignal;isCurrent:()=>boolean;onReport?:(report:CompleteUsageReport)=>void},format:'csv'|'json') {
  const frozen=structuredClone(query),frozenInput=rangeInput&&structuredClone(rangeInput),endpoint=usageEndpoint(audience);let report:CompleteUsageReport|undefined;
  const current=()=>{if(signal.aborted||!isCurrent())fail('Export cancelled; no file was created');};
  try {
    current();const p=completeQueryString(frozen,audience,frozenInput);p.set('intent','export');
    report=completeValue(await request<CompleteUsageOutcome<CompleteUsageReport>>(origin,endpoint+'/report?'+p,{signal}));
    current();if(!report.cut||!/^[A-Za-z0-9_-]{43}$/.test(report.cut))fail();
    if(safe(report.metrics.calls)>50000)fail('Export exceeds 50,000 events; narrow the range or filters');
    const expected=completeQueryString(frozen,audience),actual=completeQueryString(report.query,audience);
    // Retention may advance since the displayed report; only an explicitly disclosed clip is allowed.
    if(report.query.from<frozen.from||report.query.from!==report.coverage.effectiveFrom||report.coverage.clippedFrom!==(report.query.from===frozen.from?null:frozen.from))fail();
    if(report.coverage.authority!==(audience==='admin'?'admin_retained':'current_access')||report.coverage.scope!==(audience==='admin'?'admin_current_plus_tracked_retired':'personal_current_access'))fail();
    if(audience==='personal'&&frozen.filters.user!==undefined&&report.query.filters.user!==frozen.filters.user)fail();
    expected.set('from',actual.get('from')!);
    expected.sort();actual.sort();if(expected.toString()!==actual.toString())fail();
    onReport?.(report);
    const total=empty(),events:CompleteUsageEvent[]=[],seen=new Set<string>();let cursor:string|null=null,last:CompleteUsageEvent|undefined,size=bytes(JSON.stringify(exportMetadata(report,audience)));
    do {
      current();const pageQuery=completeQueryString(report.query,audience);pageQuery.set('cut',report.cut);pageQuery.set('limit','100');if(cursor)pageQuery.set('cursor',cursor);
      const page=completeValue(await request<CompleteUsageOutcome<CompleteUsageEvents>>(origin,endpoint+'/events?'+pageQuery,{signal}));current();
      if(!Array.isArray(page.events)||page.events.length>100||page.nextCursor!==null&&(typeof page.nextCursor!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(page.nextCursor)||seen.has(page.nextCursor)||page.events.length===0)||JSON.stringify(page.coverage)!==JSON.stringify(report.coverage))fail();
      for(const event of page.events){safe(event.occurredAt);if(event.occurredAt<report.query.from||event.occurredAt>=report.query.to||last&&(event.occurredAt>last.occurredAt||event.occurredAt===last.occurredAt&&binary(event.id,last.id)>0))fail();
        addEvent(total,event);size+=bytes(JSON.stringify(event))+1;if(events.length>=50000||size>bound)fail('Export capacity exceeded; no file was created');events.push(event);last=event;}
      cursor=page.nextCursor;if(cursor)seen.add(cursor);
    }while(cursor);
    if(vector(total)!==vector(report))fail();current();
    // Prepare bounded bytes, but do not create Blob/object URL or offer download yet.
    const file=prepareUsageFile(report,events,audience,format);
    const final=completeQueryString(report.query,audience);final.set('cut',report.cut);
    const validated=completeValue(await request<CompleteUsageOutcome<{valid:true}>>(origin,endpoint+'/validate?'+final,{signal}));
    current();if(validated.valid!==true)fail();return file;
  } finally { if(report?.cut)await releaseUsage(request,origin,audience,report.cut); }
}
export function downloadUsageFile(file: ReturnType<typeof prepareUsageFile>) {
  const url=URL.createObjectURL(new Blob([file.content],{type:file.type})),link=document.createElement('a');
  try{link.href=url;link.download=file.filename;link.click();}finally{URL.revokeObjectURL(url);}
}
