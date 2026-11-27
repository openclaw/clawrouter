import type { CompleteUsageQuery, CompleteUsageReport, PersonalUsageReport, PersonalUsageEvents, UsageCoverage } from '../../../shared/usage-report';
import { fixtureNow } from './personal-usage';

// Display-only adapter for the older reusable chart scenarios. This is not an
// authority/cursor engine or export-reconciliation fixture. Runtime journeys use
// personal-usage-cursor.mjs, with real production query/registry/SQLite code.
export function fixtureCoverage(from:number,now=fixtureNow):UsageCoverage {
  return {authority:'current_access',scope:'personal_current_access',discoveredScopeEnumeration:'complete',allDiscoveredSourcesAnswered:true,retainedAttributionComplete:true,historicalLocations:'not_exhaustively_assessed',formerLocationLateWrites:'not_bounded',captureAudit:{startedAt:now-86400000,verifiedSince:now-3600000,captureGapObserved:false},effectiveFrom:from,clippedFrom:null,capturedBetween:{from:now,to:now}};
}
export function completeDisplayReport(value:PersonalUsageReport,params=new URLSearchParams()):CompleteUsageReport {
  const filters:CompleteUsageQuery['filters']={user:'member@example.com'};
  for(const key of ['model','provider','status','lane','costClass'] as const)if(params.has(key))filters[key]=params.get(key)!;
  if(params.get('keyKind')==='session')filters.key={kind:'session'};
  else if(params.has('key'))filters.key={kind:'credential',id:params.get('key')!};
  const money={recordedChargeMicros:0,chargeReportedCalls:0};
  const groups=value.groups.map(g=>({...money,identity:{owner:'member@example.com',value:g.value},metrics:g.metrics,costs:g.costs}));
  return {...money,metrics:value.metrics,costs:value.costs,query:{from:value.range.from,to:value.range.to,timezone:value.range.timezone,grain:params.get('grain')==='minute'?'minute':'day',groupBy:value.groupBy,rankBy:(params.get('rankBy')??'calls') as CompleteUsageQuery['rankBy'],rankOffset:Number(params.get('rankOffset')??0),filters},cut:params.get('intent')==='summary'?null:'b'.repeat(43),coverage:fixtureCoverage(value.range.from,value.generatedAt),groups,buckets:value.buckets.map(b=>({...b,...money})),remainder:{...money,metrics:Object.fromEntries(Object.keys(value.metrics).map(k=>[k,0])) as unknown as typeof value.metrics,costs:[]},rank:{exact:true,offset:0,distinctGroups:groups.length,hasMore:false}};
}
export function completeDisplayOutcome(value:unknown,url:URL):unknown {
  if(!value||typeof value!=='object'||'kind' in value||'error' in value)return value;
  if(url.pathname.endsWith('/report')&&'range' in value)return {kind:'complete',value:completeDisplayReport(value as PersonalUsageReport,url.searchParams)};
  if(url.pathname.endsWith('/events')&&'events' in value){const page=value as PersonalUsageEvents;return {kind:'complete',value:{events:page.events.map(e=>({...e,user:'member@example.com'})),nextCursor:page.nextCursor?'c'.repeat(43):null,coverage:fixtureCoverage(Date.parse(url.searchParams.get('from')??'')||fixtureNow-7*86400000)}};}
  return value;
}
