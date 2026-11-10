import type { PersonalUsageReport, UsageCostSummary, UsageMetrics } from '../../../shared/usage-report';
import { fixtureNow, fixtureEvents } from './personal-usage.ts';

// Synthetic display scenario, not provider billing/runtime evidence. Aggregate
// calls, tokens and per-lane/class costs reconcile across buckets and groups.
const models = ['openai/gpt-6.1-sol', 'anthropic/claude-sonnet-4-6', 'openai/gpt-5-mini', 'anthropic/claude-opus-5-5'];
const partition = (total: number, weights: number[]) => { const sum = weights.reduce((a,b)=>a+b,0); let before=0; return weights.map(w=>{const value=Math.floor(total*(before+w)/sum)-Math.floor(total*before/sum);before+=w;return value;}); };
const zero = (): UsageMetrics => ({calls:0,generationCalls:0,utilityCalls:0,successfulCalls:0,errorCalls:0,deniedCalls:0,inputTokens:0,outputTokens:0,cachedInputTokens:0,cacheWriteInputTokens:0,reasoningOutputTokens:0,inputReportedCalls:0,outputReportedCalls:0,cacheReadReportedCalls:0,cacheWriteReportedCalls:0,reasoningReportedCalls:0});
const addMetrics = (a: UsageMetrics,b: UsageMetrics) => { for(const key of Object.keys(a) as Array<keyof UsageMetrics>) a[key]+=b[key]; return a; };
function sumCosts(rows: UsageCostSummary[]): UsageCostSummary[] { const result=new Map<string,UsageCostSummary>();for(const c of rows){const key=c.lane+':'+c.costClass;const v=result.get(key)??{...c,calls:0,amountMicros:0};v.calls+=c.calls;v.amountMicros+=c.amountMicros;result.set(key,v);}return [...result.values()]; }
export function visualUsageReport(params=new URLSearchParams()): PersonalUsageReport {
 const to=params.has('to')?Date.parse(params.get('to')!):fixtureNow,from=params.has('from')?Date.parse(params.get('from')!):to-Number(params.get('days')??7)*86400000;
 const ranges: Array<{start:number;end:number;label:string}>=[];for(let start=from;start<to&&ranges.length<32;){const end=Math.min(to,(Math.floor(start/86400000)+1)*86400000);ranges.push({start,end,label:new Date(start).toISOString().slice(0,10)});start=end;}
 const wave=[270,560,940,460,1280,330,1030,440];
 const buckets=ranges.map((range,i)=>{
  const calls=wave[i%wave.length],input=calls*(620+i%5*95),output=calls*(150+i%4*37),errors=Math.floor(calls*(i%3+1)/100),denied=Math.floor(calls/160);
  const metrics:UsageMetrics={calls,generationCalls:calls,utilityCalls:0,successfulCalls:calls-errors-denied,errorCalls:errors,deniedCalls:denied,inputTokens:input,outputTokens:output,cachedInputTokens:Math.floor(input*.34),cacheWriteInputTokens:Math.floor(input*.06),reasoningOutputTokens:Math.floor(output*.18),inputReportedCalls:calls,outputReportedCalls:calls,cacheReadReportedCalls:Math.floor(calls*.8),cacheWriteReportedCalls:Math.floor(calls*.2),reasoningReportedCalls:Math.floor(calls*.5)};
  const subscription=Math.floor(calls*.16),api=calls-subscription,unknown=i%8===4?api:Math.floor(api*.035),estimated=i%8===4?0:Math.floor(api*.09),partial=i%8===4?0:Math.floor(api*.025),fixed=i%8===4?0:Math.floor(api*.04),free=i%8===4?0:Math.floor(api*.015),calculated=api-unknown-estimated-partial-fixed-free;
  const costs:UsageCostSummary[]=([{lane:'api',costClass:'calculated',calls:calculated,amountMicros:calculated*(4200+i%5*700)},{lane:'api',costClass:'fixed',calls:fixed,amountMicros:fixed*1700},{lane:'api',costClass:'estimated',calls:estimated,amountMicros:estimated*5100},{lane:'api',costClass:'partial',calls:partial,amountMicros:partial*700},{lane:'api',costClass:'unknown',calls:unknown,amountMicros:0},{lane:'api',costClass:'no_charge',calls:free,amountMicros:0},{lane:'subscription',costClass:'calculated',calls:subscription,amountMicros:subscription*(6700+i%3*1000)}] satisfies UsageCostSummary[]).filter(c=>c.calls);
  return {...range,metrics,costs};
 });
 const metrics=buckets.reduce((m,b)=>addMetrics(m,b.metrics),zero()),costs=sumCosts(buckets.flatMap(b=>b.costs));
 const callWeights=[27,23,44,6],tokenWeights=[50,27,17,6],priceWeights=[24,34,10,32];
 const groups=models.map(value=>({value,metrics:zero(),costs:[] as UsageCostSummary[]}));
 for(const field of Object.keys(metrics) as Array<keyof UsageMetrics>){const token=/Tokens$/.test(field);const values=partition(metrics[field],token?tokenWeights:callWeights);groups.forEach((g,i)=>g.metrics[field]=values[i]);}
 groups.forEach(g=>{g.metrics.generationCalls=g.metrics.calls;g.metrics.successfulCalls=g.metrics.calls-g.metrics.errorCalls-g.metrics.deniedCalls;});
 const capacity=groups.map(g=>g.metrics.calls);
 for(const cost of costs){const calls=partition(cost.calls,capacity),amounts=partition(cost.amountMicros,priceWeights.map((w,i)=>calls[i]?w:0));groups.forEach((g,i)=>{if(calls[i])g.costs.push({...cost,calls:calls[i],amountMicros:amounts[i]});capacity[i]-=calls[i];});}
 const groupBy=(params.get('groupBy')??'model') as PersonalUsageReport['groupBy'];
 const combined=new Map<string,typeof groups[number]>();
 groups.forEach((g,i)=>{const value=groupBy==='model'?g.value:groupBy==='provider'?g.value.split('/')[0]:i%2?'automation-key':'work-laptop';const row=combined.get(value)??{value,metrics:zero(),costs:[]};addMetrics(row.metrics,g.metrics);row.costs=sumCosts([...row.costs,...g.costs]);combined.set(value,row);});
 return {range:{from,to,timezone:params.get('timezone')??'UTC',retentionStart:fixtureNow-30*86400000,clampedStart:false,buckets:ranges},groupBy,metrics,costs,groups:[...combined.values()],buckets,groupsTruncated:false,historyComplete:true,projectionComplete:true,historySource:'projection',generatedAt:fixtureNow};
}
export function visualUsageEvents(params=new URLSearchParams()) { const source=fixtureEvents(params),second=params.has('cursor');return {...source,events:Array.from({length:second?5:25},(_,i)=>({...source.events[i%source.events.length],id:'visual-call-'+(i+(second?25:0)),model:models[i%models.length],provider:models[i%models.length].split('/')[0],occurredAt:fixtureNow-(i+(second?25:0)+1)*60000})),nextCursor:second?null:'visual-page-two'}; }
