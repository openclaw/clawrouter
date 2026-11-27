import assert from 'node:assert/strict';
import test from 'node:test';
import {completeFixture,complete} from './usage-complete-fixture.mjs';
import {asOf,day,member,seedPersonalReportVolume} from './usage-personal-report-volume-fixture.mjs';
import {insertUsageReportEvent,withUsageReportPair} from '../usage-report-store.ts';
import {completeUsageLimits as limits} from '../usage-report-protocol.ts';

// Exercise the actual multi-policy coordinator without allocating twelve copies of the same
// 50k-event database. Give each synthetic policy an identical workload: every capture, page
// and validation runs the production shard dispatcher against the same read-only event history.
// No responses, probe sizes, allowances or clocks measuring elapsed time are substituted.
async function identicalWorkloads(t,count,source) {
  const f=await completeFixture(t,count),ids=[...f.shards.values()].map(s=>s.policyId),captures=[],pages=[];
  await f.personal(ids);
  f.env.USAGE_LEDGER.get=()=>({async fetch(url,init) {
    const input=JSON.parse(init.body);
    assert.ok(ids.includes(input.policyId));assert.equal(input.tenantId,source.tenantId);
    const response=await source.ledger.fetch(new Request(url,{...init,body:JSON.stringify({...input,policyId:source.policyId})}));
    if(input.action==='capture'||input.action==='groups') {
      const result=await response.clone().json();assert.equal(result.kind,'complete',JSON.stringify(result).slice(0,160));
      if(input.action==='capture')captures.push(result.value);else pages.push(result.value.work);
    }
    return response;
  }});
  return {f,captures,pages};
}
const query=(f,days)=>({...f.query,from:asOf-days*day,to:asOf});

test('initial personal 7/30d model reports bound rejected probes and handle sparse rowid tails',{timeout:120000},async t=>{
  let clock=asOf-900001;t.mock.method(Date,'now',()=>clock);
  const seed=await completeFixture(t,1),[s]=seed.shards.values(),data=await seedPersonalReportVolume(seed);
  clock=asOf;await seed.personal([s.policyId]);
  // Measure a complete projected raw range before any folding, not an estimate of scalar widths.
  const projectedRaw=new Map();
  for(const days of [7,30]) {
    seed.hook=async(call,response)=>{if(call.body.action==='capture') projectedRaw.set(days,(await response.clone().json()).value.work);};
    complete(await seed.read({query:query(seed,days)}));assert.equal(projectedRaw.get(days).plan,'raw');
  }
  seed.hook=undefined;await data.partlyFold();
  // Model a surviving high rowid after deletion. This foreign-owner arrival must not enter totals
  // or invalidate the paired projection; it changes the rowid span without adding a dense tail.
  const e=seed.event('after-rowid-gap',{principal_id:'bob@example.com',model:'foreign-only-model'});
  s.transactionSync(()=>withUsageReportPair(s.sql,()=>{
    s.sql.exec('INSERT INTO usage_events(rowid,id,occurred_at_ms,tenant_id,policy_id,provider,status,actual_cost_micros,principal_id,principal_key,event_json) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      3*data.rowsPerShard,e.id,e.occurred_at_ms,e.tenant_id,e.policy_id,e.provider,e.status,e.actual_cost_micros,e.principal_id,e.principal_id,JSON.stringify(e));
    assert.equal(insertUsageReportEvent(s.sql,e),true);
  }));
  const {folded_rowid:folded}=s.sql.exec('SELECT folded_rowid FROM usage_report_cell_state')[0];
  const {span,actual}=s.sql.exec('SELECT MAX(rowid)-? AS span, COUNT(*) AS actual FROM usage_events WHERE rowid>?',folded,folded)[0];
  for(const raw of projectedRaw.values())assert.ok(actual<raw.rows&&raw.rows<span,'rowid span and real tail must imply opposite plan choices');

  for(const [source,count] of [['projection',5],['retained_ledger',12]]) {
    if(source==='retained_ledger')s.sql.exec('UPDATE usage_report_events SET report_format_version=1');
    const {f,captures,pages}=await identicalWorkloads(t,count,s);
    for(const days of [7,30])await t.test(source+' / '+days+' days',async()=>{
      captures.length=0;pages.length=0;
      const truth=data.truth.get(days);
      const report=complete(await f.read({intent:'browse',query:query(f,days)}));
      assert.deepEqual(report.query.filters,{user:member});assert.equal(report.query.from,truth.from);assert.ok(report.cut);
      assert.equal(report.metrics.calls,truth.total.metrics.calls*count);
      assert.deepEqual(Object.fromEntries(report.groups.map(g=>[g.identity.value,g.metrics.calls])),
        Object.fromEntries([...truth.groups].map(([model,g])=>[model,g.metrics.calls*count])));
      assert.equal(captures.length,count);assert.equal(pages.length,count);
      assert.ok(captures.every(({cut,work})=>cut.source===source&&work.plan==='cells'));
      assert.ok(pages.every(w=>w.plan==='cells'&&w.rows===actual));
      const selectedBytes=pages.reduce((n,w)=>n+w.bytes,0);
      assert.ok(selectedBytes<=limits.inputBytes);
      assert.ok(captures.reduce((n,c)=>n+c.work.probe.bytes,0)+2*selectedBytes<=limits.classifiedBytes);
      if(source==='projection') {
        assert.ok(count*projectedRaw.get(days).bytes>limits.inputBytes,'choosing raw for the rowid gap must overflow the shared input budget');
      } else {
        const {bytes}=s.sql.exec('SELECT SUM(length(CAST(event_json AS BLOB))) AS bytes FROM usage_events WHERE tenant_id=? AND policy_id=? AND principal_key=? AND occurred_at_ms>=? AND occurred_at_ms<?',s.tenantId,s.policyId,member,truth.from,asOf)[0];
        // Capture charged both measurements: the full rejected raw scan AND the chosen cells scan.
        assert.ok(bytes*count+selectedBytes>limits.classifiedBytes,'unbounded alternative probes must exhaust the cumulative byte cap');
      }
      complete(await f.continuation({kind:'release',cut:report.cut,query:report.query}));
    });
  }
});
