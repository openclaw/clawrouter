import assert from 'node:assert/strict';
import test from 'node:test';
import { visualUsageReport } from '../browser/fixtures/personal-usage-visual.ts';
const sumCosts=rows=>{const r={};for(const c of rows){const k=c.lane+':'+c.costClass;r[k]??={calls:0,amountMicros:0};r[k].calls+=c.calls;r[k].amountMicros+=c.amountMicros;}return r;};
for(const days of [7,30])for(const groupBy of ['model','provider','key'])test('varied visual fixture reconciles '+days+'d/'+groupBy,()=>{
 const p=visualUsageReport(new URLSearchParams({days:String(days),groupBy}));
 for(const key of Object.keys(p.metrics)){assert.equal(p.groups.reduce((s,g)=>s+g.metrics[key],0),p.metrics[key],key+' groups');assert.equal(p.buckets.reduce((s,b)=>s+b.metrics[key],0),p.metrics[key],key+' buckets');}
 assert.deepEqual(sumCosts(p.groups.flatMap(g=>g.costs)),sumCosts(p.costs));assert.deepEqual(sumCosts(p.buckets.flatMap(g=>g.costs)),sumCosts(p.costs));
 for(const g of [...p.groups,...p.buckets]){assert.equal(g.costs.reduce((s,c)=>s+c.calls,0),g.metrics.calls);assert.ok(g.metrics.cachedInputTokens+g.metrics.cacheWriteInputTokens<=g.metrics.inputTokens);assert.ok(g.metrics.reasoningOutputTokens<=g.metrics.outputTokens);for(const k of ['inputReportedCalls','outputReportedCalls','cacheReadReportedCalls','cacheWriteReportedCalls','reasoningReportedCalls'])assert.ok(g.metrics[k]<=g.metrics.calls);}
 assert.ok(p.buckets.some(b=>b.costs.some(c=>c.lane==='api'&&c.costClass==='unknown')&&!b.costs.some(c=>c.lane==='api'&&['calculated','fixed','no_charge'].includes(c.costClass))),'unknown-only API day supports genuine gap');
});
