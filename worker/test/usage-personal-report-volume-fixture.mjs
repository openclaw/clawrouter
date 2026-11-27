import assert from 'node:assert/strict';
import {emptyUsageMetrics} from '../../shared/usage-report.ts';
import {insertUsageReportEvent, withUsageReportPair} from '../usage-report-store.ts';

// One busy member across two shared policies, with agent-like runs of 48 calls
// sharing a model and key. Detail consists solely of real projection fields.
export const day = 86_400_000, asOf = Date.UTC(2026, 10, 26), member = 'alice@example.com';
const old = 4000, recent = 46000, rowsPerShard = old + recent;
const models = [ ['openai', 'gpt-5.1-codex-max'], ['anthropic', 'claude-sonnet-4-5-20250929'],
  ['google', 'gemini-2.5-pro'], ['openai', 'gpt-5.1-codex-mini'], ['anthropic', 'claude-haiku-4-5-20251001'] ];
function eventFor(f, shard, i) {
  const run = Math.floor(i / 48), principal = i % 19 === 0 ? 'bob@example.com' : i % 41 === 0 ? null : member;
  const [provider, model] = models[(run + shard) % models.length];
  const id = String(i).padStart(8, '0'), requestId = '8846d3e1-b176-487d-b9f8-' + (shard + id).padStart(12,'0');
  const at = i < old ? asOf - 29*day + Math.floor(i*21*day/old) : asOf-7*day+Math.floor((i-old)*(7*day-1800000)/recent);
  const estimated = run % 4 === 0, denied = i % 101 === 0, error = !denied && i % 97 === 0;
  const input = 1200 + i % 1600, output = 40 + i % 190;
  return f.event('usage-' + requestId, {occurred_at_ms:at+shard, policy_id:'p'+shard, key_id:'p'+shard,
    principal_id:principal, credential_id:'cred_'+shard+'_engineering_'+(run%17), provider, model:principal===member?model:'foreign-only-model',
    capability:'llm.chat', request_format:'openai.responses', status:denied?'denied':error?'provider_error':'success',
    status_code:denied?403:error?502:200, duration_ms:320+i%1234, input_tokens:input, output_tokens:output,
    total_tokens:input+output, cached_input_tokens:80+i%40, cache_write_input_tokens:null, reasoning_output_tokens:i%5===0?null:i%31,
    actual_cost_micros:estimated?0:90+i%50, cost_basis:estimated?'unpriced_usage':'manifest_pricing',
    grant_lane:estimated?'subscription':'api_key', reporting_estimated_cost_micros:estimated?30+i%20:null,
    reporting_estimate_reason:estimated?'reference API price for subscription traffic':null,
    pricing_ref:'manifest:'+provider+'/'+model+':text:input-output-cache-read:2026-11-01:sha256:5b992c8a8df77a537ce4690d4b62716b723f764d68db5784026e7ca1a0369fa9',
    requested_service_tier:'auto', served_service_tier:'default',compound_request_id:'compound-'+requestId,
    compound_request_stage:'generation'});
}
const empty = () => ({metrics:emptyUsageMetrics(),chargeReportedCalls:0,recordedChargeMicros:0,costs:[]});
function count(sum,e) {
  const m=sum.metrics; m.calls++; m.generationCalls++;
  m[e.status==='denied'?'deniedCalls':e.status==='success'?'successfulCalls':'errorCalls']++;
  m.inputTokens+=e.input_tokens; m.inputReportedCalls++; m.outputTokens+=e.output_tokens; m.outputReportedCalls++;
  m.cachedInputTokens+=e.cached_input_tokens; m.cacheReadReportedCalls++;
  if(e.reasoning_output_tokens!==null) { m.reasoningOutputTokens+=e.reasoning_output_tokens; m.reasoningReportedCalls++; }
  sum.chargeReportedCalls++; sum.recordedChargeMicros+=e.actual_cost_micros;
  const estimated=e.cost_basis==='unpriced_usage', lane=estimated?'subscription':'api', costClass=estimated?'estimated':'calculated';
  let cost=sum.costs.find(c=>c.lane===lane);
  if(!cost){cost={lane,costClass,calls:0,amountMicros:0};sum.costs.push(cost);sum.costs.sort((a,b)=>a.lane.localeCompare(b.lane));}
  cost.calls++;cost.amountMicros+=estimated?e.reporting_estimated_cost_micros:e.actual_cost_micros;
}
function truthFor(days) {
  const from=asOf-days*day+(days===30?900000:0), buckets=[];
  for(let start=from;start<asOf;) {const end=(Math.floor(start/day)+1)*day; buckets.push({start,end,label:new Date(start).toISOString().slice(0,10),...empty()});start=end;}
  return {from,buckets,groups:new Map(),total:empty()};
}
/** Batch setup rather than 100,000 Request/Response objects. Canonical insert triggers,
 * production projection writer and paired coverage acknowledgement all run in SQLite. */
export async function seedPersonalReportVolume(f) {
  const truth = new Map([7,30].map(days=>[days,truthFor(days)])), latest=[];
  const shards=[...f.shards.values()];
  for(const [index,s] of shards.entries()) {
    const canonical=s.db.prepare('INSERT INTO usage_events(id,occurred_at_ms,tenant_id,policy_id,provider,status,status_code,input_tokens,output_tokens,total_tokens,actual_cost_micros,event_json,grant_lane,principal_id,principal_key,credential_id,cost_basis) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    const statements=new Map(), sql={exec(query,...args){if(!statements.has(query))statements.set(query,s.db.prepare(query));return statements.get(query).all(...args);}};
    s.transactionSync(()=>withUsageReportPair(s.sql,()=>{
      for(let i=0;i<rowsPerShard;i++){
        const e=eventFor(f,index,i);
        canonical.run(e.id,e.occurred_at_ms,e.tenant_id,e.policy_id,e.provider,e.status,e.status_code,e.input_tokens,e.output_tokens,e.total_tokens,e.actual_cost_micros,JSON.stringify(e),e.grant_lane,e.principal_id,e.principal_id,e.credential_id,e.cost_basis);
        assert.equal(insertUsageReportEvent(sql,e),true);
        if(e.principal_id!==member)continue;
        if(i>=rowsPerShard-250)latest.push({id:e.id,at:e.occurred_at_ms});
        for(const {from,buckets,groups,total} of truth.values()){
          if(e.occurred_at_ms<from)continue;
          if(!groups.has(e.model))groups.set(e.model,{identity:{owner:null,value:e.model},...empty()});
          count(total,e);count(buckets[Math.floor(e.occurred_at_ms/day)-Math.floor(from/day)],e);count(groups.get(e.model),e);
        }
      }
    }));
    await s.ledger.alarm(); // Choose the target; not a single row may fold until its cut TTL elapses.
    assert.deepEqual({...s.sql.exec('SELECT folded_rowid,target_rowid FROM usage_report_cell_state')[0]}, {folded_rowid:0,target_rowid:rowsPerShard});
  }
  // The same signed-in identity also has a retained event under an inaccessible policy.
  assert.equal((await f.direct('/policies/put',{policyId:'p2',policy:{tenantId:'tenant',enabled:true,providers:[]}})).status,200);
  await f.ingest(f.addShard('tenant','p2'),f.event('unbound-member',{model:'unbound-only-model',occurred_at_ms:asOf-1600000}));
  const bytesFor=from=>shards.map(s=>s.sql.exec('SELECT SUM(length(CAST(detail_json AS BLOB))) AS bytes FROM usage_report_events WHERE tenant_id=? AND policy_id=? AND principal_key=? AND occurred_at_ms>=? AND occurred_at_ms<?',s.tenantId,s.policyId,member,from,asOf)[0].bytes);
  return {truth,bytesFor,latest:latest.sort((a,b)=>b.at-a.at).slice(0,200).map(e=>e.id),rowsPerShard,
    async partlyFold(){for(const s of shards){for(let i=0;i<24;i++)await s.ledger.alarm();
      const state=s.sql.exec('SELECT folded_rowid,target_rowid,healthy FROM usage_report_cell_state')[0];
      assert.equal(state.healthy,1);assert.ok(state.folded_rowid>rowsPerShard*0.90 && state.folded_rowid<state.target_rowid,JSON.stringify(state));
    }} };
}
