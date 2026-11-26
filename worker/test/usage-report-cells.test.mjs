import assert from 'node:assert/strict';
import test from 'node:test';
import {completeFixture,complete} from './usage-complete-fixture.mjs';
import {withUsageRetention} from '../usage-report-visibility.ts';
import {maintainUsageReportCells} from '../usage-report-cells.ts';

const ttl=15*60000,hour=3600000;
const cellState=s=>s.sql.exec('SELECT folded_rowid AS folded, target_rowid AS target, target_at AS at, healthy FROM usage_report_cell_state')[0];
const maxRowid=s=>s.sql.exec('SELECT COALESCE(MAX(rowid),0) AS n FROM usage_events')[0].n;
const cellCalls=s=>s.sql.exec('SELECT COALESCE(SUM(calls),0) AS n FROM usage_report_cells')[0].n;
// Production's large shards predate the typed projection, so their cuts read the retained ledger.
const retained=s=>s.sql.exec('UPDATE usage_report_events SET report_format_version = 1');
const plans=f=>f.calls.filter(c=>c.body.action==='groups').map(c=>c.body.allowance.plan);
const strip=({coverage,cut,...rest})=>rest;
/** Movable wall clock for the real alarm handler; the fold fence opens only after a cut TTL. */
function clock(t,start=Date.now()){let at=start;t.mock.method(Date,'now',()=>at);return {get now(){return at},set now(v){at=v}};}
async function fold(c,shard){
 for(let i=0;i<5000;i++){
  const before=cellState(shard);await shard.ledger.alarm();const after=cellState(shard);
  if(after.healthy&&after.folded===after.target&&after.target>=maxRowid(shard))return;
  if(before.folded===after.folded&&before.target===after.target)c.now+=ttl+1;
 }
 assert.fail('fold did not converge');
}
const event=(f,id,at,extra={})=>f.event(id,{occurred_at_ms:at,...extra});
// From the test's original start until the (advanced) test clock.
const recent=(f,c)=>({query:{...f.query,from:f.now-2*hour,to:c.now}});

test('cells reproduce raw reports exactly across zones, groupings, filters and unaligned edges',{timeout:120000},async t=>{
 const c=clock(t),f=await completeFixture(t,2),shards=[...f.shards.values()];let seed=7;const rand=n=>(seed=(seed*1103515245+12345)%2147483648)%n;
 const start=c.now-5*86400000,classes=[{cost_basis:'manifest_pricing'},{cost_basis:'policy_fixed'},{cost_basis:'unpriced_usage',actual_cost_micros:9},{cost_basis:'unpriced_usage',actual_cost_micros:0,reporting_estimated_cost_micros:4,reporting_estimate_reason:'est'},{cost_basis:'none',actual_cost_micros:0}];
 for(let i=0;i<600;i++){
  // Some rows sit exactly on quarter-hour and local-midnight boundaries.
  const at=i%50===0?Math.floor((start+rand(5*86400000))/900000)*900000:start+rand(5*86400000);
  await f.ingest(i%2,event(f,'e'+i,at,{model:i%11?'m'+rand(3):null,provider:['openai','anthropic'][rand(2)],principal_id:'u'+rand(4)+'@example.com',credential_id:rand(5)?'k'+rand(3):null,status:['success','success','provider_error','denied'][rand(4)],grant_lane:['api_key','subscription',null][rand(3)],input_tokens:rand(4)?rand(900):null,output_tokens:rand(9),cached_input_tokens:rand(3)?rand(300):null,...classes[rand(5)]}));
 }
 shards.forEach(retained);
 const queries=[];
 for(const timezone of ['UTC','Asia/Kathmandu','Pacific/Chatham','America/New_York'])for(const groupBy of ['user','key','model','provider'])
  queries.push({...f.query,timezone,groupBy,from:start+4321,to:c.now-777});
 for(const filters of [{user:'u1@example.com'},{key:{kind:'credential',id:'k1'}},{key:{kind:'session'}},{model:'m2'},{provider:'anthropic'},{status:'denied'},{lane:'subscription'},{costClass:'estimated'}])
  queries.push({...f.query,timezone:'Asia/Kathmandu',groupBy:'key',from:start+4321,to:c.now-777,filters});
 queries.push({...f.query,from:start+86400000,to:start+86400000+7*900000}); // exact quarter-hour endpoints
 queries.push({...f.query,from:start+86400000+60000,to:start+86400000+600000}); // no full slot: raw only
 const raw=[];for(const query of queries){f.calls.length=0;raw.push(complete(await f.read({query})));assert.ok(plans(f).every(p=>p==='raw'));}
 for(const s of shards)await fold(c,s);
 for(const [i,query] of queries.entries()){
  f.calls.length=0;const cells=complete(await f.read({query}));
  assert.deepEqual(strip(cells),strip(raw[i]),JSON.stringify(query));
  assert.deepEqual(plans(f),i===queries.length-1?['raw','raw']:['cells','cells']);
 }
 assert.equal(raw[0].metrics.calls,600);assert.ok(raw.some(r=>r.costs.length>4));
});

test('folding during a cut never changes its pages; late rows stay out of cells until a later target',async t=>{
 const c=clock(t),f=await completeFixture(t,1),s=[...f.shards.values()][0];
 for(let i=0;i<30;i++)await f.ingest(0,event(f,'a'+i,c.now-2*hour+i*60000,{model:'m'+i%3}));
 retained(s);await fold(c,s);const T=cellState(s).target;
 // New rows after the target, then a cut, then the next target's fence opens mid-cut.
 for(let i=0;i<5;i++)await f.ingest(0,event(f,'b'+i,c.now-hour+i,{model:'m9'}));
 await s.ledger.alarm();const next=cellState(s);assert.ok(next.target>T);assert.equal(next.folded,T);
 const query={...f.query,from:c.now-3*hour,to:c.now,groupBy:'model'};
 c.now=next.at+ttl-1000;const base=complete(await f.read({intent:'browse',query}));assert.equal(base.metrics.calls,35);
 for(let i=0;i<4;i++)await f.ingest(0,event(f,'late'+i,c.now-hour+10+i,{model:i%2?'m0':'m-late'}));
 c.now=next.at+ttl+1;await s.ledger.alarm();assert.equal(cellState(s).folded,next.target);
 assert.equal(cellCalls(s),35,'only rows chosen a full cut TTL ago are folded');
 f.calls.length=0;const again=complete(await f.continuation({kind:'report',intent:'browse',cut:base.cut,query:base.query}));
 assert.deepEqual(plans(f),['cells']);assert.deepEqual(strip(again),strip(base));assert.ok(!again.groups.some(g=>g.identity.value==='m-late'));
 const fresh=complete(await f.read({query}));assert.equal(fresh.metrics.calls,39);
});

test('canonical deletes, updates and reused rowids only flag cells; the alarm rebuilds them',async t=>{
 const c=clock(t),f=await completeFixture(t,1),s=[...f.shards.values()][0];
 const oldest=c.now-30*86400000+2*hour;
 await f.ingest(0,event(f,'expiring',oldest));for(let i=0;i<10;i++)await f.ingest(0,event(f,'r'+i,c.now-hour+i));
 retained(s);await fold(c,s);assert.equal(cellCalls(s),11);
 // A retention delete is below every cut floor: no flag, and expired cells are pruned later.
 s.transactionSync(()=>withUsageRetention(s.sql,oldest+1,()=>s.sql.exec('DELETE FROM usage_events WHERE occurred_at_ms < ?',oldest+1)));
 assert.equal(cellState(s).healthy,1);
 // A late row with an old timestamp takes the max rowid; retention deletes it and its rowid is reused.
 await f.ingest(0,event(f,'old-late',oldest+hour));await s.ledger.alarm();c.now=cellState(s).at+ttl+1;await fold(c,s);
 const reused=maxRowid(s);s.transactionSync(()=>withUsageRetention(s.sql,oldest+hour+1,()=>s.sql.exec('DELETE FROM usage_events WHERE id = ?','old-late')));
 assert.equal(cellState(s).healthy,1);await f.ingest(0,event(f,'reuses-rowid',c.now-1000));
 assert.equal(s.sql.exec("SELECT rowid FROM usage_events WHERE id = 'reuses-rowid'")[0].rowid,reused);assert.equal(cellState(s).healthy,0);
 f.calls.length=0;assert.equal(complete(await f.read(recent(f,c))).metrics.calls,11);assert.deepEqual(plans(f),['raw']);
 // The next alarm drops the cells and restarts the fold from rowid 0 behind a fresh fence.
 await s.ledger.alarm();assert.deepEqual({...cellState(s),at:0},{folded:0,target:maxRowid(s),at:0,healthy:1});assert.equal(cellCalls(s),0);
 await fold(c,s);assert.equal(cellCalls(s),11);
 for(const mutate of ["DELETE FROM usage_events WHERE id = 'r3'","UPDATE usage_events SET status = 'denied' WHERE id = 'r4'"]){
  s.sql.exec(mutate);assert.equal(cellState(s).healthy,0,mutate);await s.ledger.alarm();await fold(c,s);
 }
 f.calls.length=0;const r=complete(await f.read(recent(f,c)));assert.deepEqual(plans(f),['cells']);assert.equal(r.metrics.calls,10);assert.equal(r.metrics.deniedCalls,1);
});

test('fold batches commit with their cursor; storage pressure sheds cells without touching ingest',async t=>{
 const c=clock(t),f=await completeFixture(t,1),s=[...f.shards.values()][0];
 for(let i=0;i<3;i++)await f.ingest(0,event(f,'p'+i,c.now-hour+i));retained(s);
 await s.ledger.alarm();c.now=cellState(s).at+ttl+1;const before=cellState(s);
 s.sql.exec("CREATE TRIGGER fail_fold BEFORE UPDATE OF folded_rowid ON usage_report_cell_state BEGIN SELECT RAISE(ABORT, 'synthetic'); END");
 assert.throws(()=>s.transactionSync(()=>maintainUsageReportCells(s.sql,c.now)),/synthetic/);
 assert.deepEqual(cellState(s),before);assert.equal(cellCalls(s),0);s.sql.exec('DROP TRIGGER fail_fold');
 await fold(c,s);assert.equal(cellCalls(s),3);
 const sql=s.sql;s.sql={exec:sql.exec,databaseSize:9*1024**3};
 assert.equal(s.transactionSync(()=>maintainUsageReportCells(s.sql,c.now)),null);s.sql=sql;
 assert.equal(cellCalls(s),0);assert.equal(cellState(s).folded,0);
 await f.ingest(0,event(f,'during-pressure',c.now-10));f.calls.length=0;assert.equal(complete(await f.read(recent(f,c))).metrics.calls,4);assert.deepEqual(plans(f),['raw']);
});

test('cells expire with their rows when the shard stops receiving usage',async t=>{
 const c=clock(t),f=await completeFixture(t,1),s=[...f.shards.values()][0],day=86400000,slot=900000;
 const count=table=>s.sql.exec('SELECT COUNT(*) AS n FROM '+table)[0].n;
 // The last row sits 1 minute before its slot ends, so retention removes it before the slot expires.
 const last=Math.floor((c.now-2*hour)/slot)*slot+14*60000;
 await f.ingest(0,event(f,'old',c.now-30*day+hour));await f.ingest(0,event(f,'last',last));await fold(c,s);assert.equal(cellCalls(s),2);
 // No further ingest: the ordinary alarm's retention cleanup removes 'old', and its whole slot goes too.
 c.now+=2*hour;await s.ledger.alarm();assert.equal(count('usage_events'),1);assert.equal(cellCalls(s),1);
 // The alarm that deletes the last row schedules no other, so it must clear the cells itself.
 const alarms=[];s.ledger.state.storage.setAlarm=async at=>{alarms.push(at);};
 c.now=last+30*day+1;await s.ledger.alarm();
 assert.equal(count('usage_events'),0);assert.deepEqual(alarms,[]);
 assert.equal(count('usage_report_cells'),0);assert.deepEqual({...cellState(s)},{folded:0,target:0,at:0,healthy:1});
});

test('a retained shard over the raw limits reports 7 days through cells and a key drilldown',{timeout:120000},async t=>{
 const c=clock(t),f=await completeFixture(t,1),s=[...f.shards.values()][0];
 // 300,000 canonical rows over 7 days (more than the 250,000 raw-row limit), agent-like locality:
 // runs of 50 calls share a user/key/model.
 s.sql.exec('UPDATE usage_report_visibility SET usable=0');
 s.sql.exec(`WITH RECURSIVE n(i) AS (VALUES(0) UNION ALL SELECT i+1 FROM n WHERE i+1<300000)
  INSERT INTO usage_events(id,occurred_at_ms,tenant_id,policy_id,provider,status,actual_cost_micros,event_json,principal_key,credential_id)
  SELECT 'v'||i, ? + i*2000, 'tenant','p0','openai',CASE WHEN i%97=0 THEN 'provider_error' ELSE 'success' END,3,
   json_object('model','m'||((i/50)%7),'credential_id','k'||((i/50)%40),'input_tokens',i%100,'actual_cost_micros',3,'cost_basis','manifest_pricing','grant_lane','api_key'),
   'u'||((i/50)%20)||'@example.com','k'||((i/50)%40) FROM n`,c.now-7*86400000+60000);
 const query={...f.query,from:c.now-7*86400000,to:c.now,groupBy:'user'};
 assert.deepEqual(await f.read({query}),{kind:'unavailable',reason:'migration'});
 const started=performance.now();await fold(c,s);const foldMs=performance.now()-started;
 const at=performance.now(),r=complete(await f.read({query})),readMs=performance.now()-at;
 assert.equal(r.metrics.calls,300000);assert.equal(r.rank.distinctGroups,20);assert.equal(r.metrics.inputTokens,300000/100*4950);assert.equal(r.metrics.errorCalls,Math.ceil(300000/97));
 const drill=complete(await f.read({query:{...query,groupBy:'key',filters:{user:r.groups[0].identity.value}}}));
 assert.equal(drill.metrics.calls,r.groups[0].metrics.calls);assert.ok(plans(f).every(p=>p==='cells'));
 t.diagnostic(JSON.stringify({rows:300000,cells:s.sql.exec('SELECT COUNT(*) AS n FROM usage_report_cells')[0].n,foldMs:Math.round(foldMs),reportMs:Math.round(readMs)}));
});

test('a storage-paused shard stays on the ordinary alarm cadence and resumes folding when pressure clears',async t=>{
 const c=clock(t),f=await completeFixture(t,1),s=[...f.shards.values()][0],day=86_400_000;
 const alarms=[];s.ledger.state.storage.setAlarm=async at=>{alarms.push(at-c.now);};
 await f.ingest(0,event(f,'a',c.now-hour));retained(s);await fold(c,s);
 const sql=s.ledger.sql;s.ledger.sql={exec:sql.exec,databaseSize:9*1024**3};
 await s.ledger.alarm();assert.equal(cellCalls(s),0);
 // Repeated ingest and report reads never pull a paused shard back to the 500 ms fold cadence.
 alarms.length=0;for(let i=0;i<3;i++){await f.ingest(0,event(f,'p'+i,c.now-10));complete(await f.read(recent(f,c)));}
 assert.ok(alarms.length>0);assert.ok(alarms.every(delay=>delay===day),JSON.stringify(alarms));
 s.ledger.sql=sql;alarms.length=0;await f.ingest(0,event(f,'resume',c.now-10));assert.deepEqual(alarms,[500]);
 await fold(c,s);assert.equal(cellCalls(s),5);
});

/** Bulk canonical rows outside the arrival log (as ingest does after an overflow drains). */
function bulk(s,count,at,padding=0,principal='alice@example.com'){
 s.sql.exec('UPDATE usage_report_visibility SET usable=0');
 s.sql.exec("WITH RECURSIVE n(i) AS (VALUES(0) UNION ALL SELECT i+1 FROM n WHERE i+1<?) INSERT INTO usage_events(id,occurred_at_ms,tenant_id,policy_id,provider,status,actual_cost_micros,event_json,principal_key) SELECT 'bulk-'||i,?,?,?,'openai','success',0,json_object('model','g','metadata',?),? FROM n",count,at,s.tenantId,s.policyId,'x'.repeat(padding),principal);
}
test('a rejected cells probe is charged to the report even when the raw plan is chosen',{timeout:60000},async t=>{
 const c=clock(t),f=await completeFixture(t,1),s=[...f.shards.values()][0];
 await f.ingest(0,event(f,'a',c.now-hour/2));retained(s);await fold(c,s);
 // A 250,001-row unfolded tail outside the requested hour makes the cells plan too large to run.
 bulk(s,250001,c.now-3*hour);
 const captured=[];f.hook=async(call,response)=>{if(call.body.action==='capture')captured.push((await response.clone().json()).value.work);return response;};
 f.calls.length=0;const r=complete(await f.read({query:{...f.query,from:c.now-hour,to:c.now}}));
 assert.equal(r.metrics.calls,1);assert.deepEqual(plans(f),['raw']);
 assert.equal(captured[0].plan,'raw');assert.ok(captured[0].probe.rows>250000,JSON.stringify(captured[0]));
});

test('a narrow personal read while cells catch up takes the indexed raw plan, not the shared row budget',{timeout:120000},async t=>{
 const c=clock(t),f=await completeFixture(t,5),shards=[...f.shards.values()];
 for(const s of shards){await f.ingest(s,event(f,'a-'+s.policyId,c.now-10*60000));retained(s);await fold(c,s);}
 // 210,000 unfolded rows of another user per shard: each cells plan fits alone, all five exceed the 1,000,000 shared rows.
 for(const s of shards)bulk(s,210000,c.now-5*60000,0,'bob@example.com');
 const captured=[];f.hook=async(call,response)=>{if(call.body.action==='capture')captured.push((await response.clone().json()).value.work);return response;};
 await f.personal(shards.map(s=>s.policyId));f.calls.length=0;
 const r=complete(await f.read(recent(f,c)));
 assert.equal(r.metrics.calls,5);assert.deepEqual(plans(f),Array(5).fill('raw'));
 // Each shard is charged its rejected cells probe (the whole tail) and the raw plan it runs.
 for(const w of captured){assert.equal(w.plan,'raw');assert.equal(w.rows,1);assert.ok(w.probe.rows>210000+w.rows,JSON.stringify(w));}
});

test('raw edges that alone exceed the limits are capacity even while a fold target is pending',{timeout:60000},async t=>{
 const c=clock(t),f=await completeFixture(t,1),s=[...f.shards.values()][0];
 await f.ingest(0,event(f,'a',c.now-hour/2));retained(s);await fold(c,s);
 // 1,025 rows of 64 KiB in the range's trailing partial slot, which always stays raw.
 bulk(s,1025,c.now-1000,65536);await s.ledger.alarm();
 assert.ok(cellState(s).folded<cellState(s).target,'a new fold target is pending');
 assert.deepEqual(await f.read({query:{...f.query,from:c.now-hour,to:c.now}}),{kind:'unavailable',reason:'capacity'});
});
