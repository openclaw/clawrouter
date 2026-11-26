import assert from 'node:assert/strict';
import test from 'node:test';
import {completeFixture,complete} from './usage-complete-fixture.mjs';

// Synthetic signed-in member, one shared retained-ledger shard. The latest week
// has twice the traffic of the preceding 23 days. No live identities or data.
test('7/30 day personal browse, filtered activity and export at volume',{timeout:120000},async t=>{
 const day=86400000,now=Math.floor(Date.now()/900000)*900000;let clock=now;
 t.mock.method(Date,'now',()=>clock);
 const f=await completeFixture(t,1),s=[...f.shards.values()][0]; await f.personal();
 s.sql.exec('UPDATE usage_report_visibility SET usable=0');
 s.sql.exec(`WITH RECURSIVE n(i) AS (VALUES(0) UNION ALL SELECT i+1 FROM n WHERE i<119999),
 rows AS (SELECT i,'e'||i AS id, CASE WHEN i<40000 THEN ?+i*45000 ELSE ?+(i-40000)*7000 END AS at,
 CASE WHEN i%10=0 THEN 'bob@example.com' ELSE 'alice@example.com' END AS owner FROM n)
 INSERT INTO usage_events(id,occurred_at_ms,tenant_id,policy_id,provider,status,actual_cost_micros,event_json,principal_key)
 SELECT id,at,'tenant','p0','openai','success',3,json_object('id',id,'occurred_at_ms',at,'provider','openai','status','success','model','m'||(i%4),'input_tokens',5,'actual_cost_micros',3,'cost_basis','manifest_pricing','grant_lane','api_key','padding',?),owner FROM rows`,now-29*day,now-7*day,'x'.repeat(850));
 await s.ledger.alarm();clock+=900001;
 for(let i=0;i<62;i++)await s.ledger.alarm();
 for(const days of [7,30]){
  const query={...f.query,from:clock-days*day,to:clock};
  const truth=s.sql.exec("SELECT COUNT(*) AS n FROM usage_events WHERE principal_key='alice@example.com' AND occurred_at_ms>=?",query.from)[0].n;
  const work=[];f.hook=async(call,response)=>{if(['groups','events'].includes(call.body.action))work.push((await response.clone().json()).value.work);return response;};
  let start=performance.now(); const r=complete(await f.read({intent:'browse',query})),reportMs=performance.now()-start;
  assert.equal(r.metrics.calls,truth);assert.equal(r.metrics.inputTokens,5*truth);
  for(const model of [null,'m1']){
   const q=model?{...r.query,filters:{...r.query.filters,model}}:r.query;
   start=performance.now();const result=await f.continuation({kind:'events',query:q,cut:r.cut,pageSize:100});
   t.diagnostic(JSON.stringify({days,model,calls:truth,reportMs:Math.round(reportMs),activityMs:Math.round(performance.now()-start),outcome:result.kind,reportWork:work[0],pageWork:work.at(-1)}));
   const page=complete(result);assert.equal(work.at(-1).rows,model?512:101);assert.equal(page.events.length,100);assert.ok(page.nextCursor);
   assert.ok(page.events.every(e=>e.user==='alice@example.com'&&(!model||e.model===model)));
   const next=complete(await f.continuation({kind:'events',query:q,cut:r.cut,cursor:page.nextCursor,pageSize:100}));
   assert.equal(next.events.length,100);assert.ok(next.events[0].occurredAt<page.events.at(-1).occurredAt);
  }
  // A rare/nonexistent filter still fails whole if proving exhaustion needs too much JSON.
  assert.deepEqual(await f.continuation({kind:'events',query:{...r.query,filters:{...r.query.filters,model:'absent'}},cut:r.cut,pageSize:100}),{kind:'unavailable',reason:'capacity'});
  f.hook=undefined;
  assert.deepEqual(await f.read({intent:'export',query}),{kind:'unavailable',reason:'capacity'});
 }
});

test('new day reports on fully projected shards can use cells; existing cuts keep their source',async t=>{
 let clock=Date.now();t.mock.method(Date,'now',()=>clock);
 const f=await completeFixture(t,1),s=[...f.shards.values()][0];await f.personal();
 for(let i=0;i<750;i++)await f.ingest(s,f.event('paired-'+i,{occurred_at_ms:clock-3600000+i,model:i===749?'rare':'m'+i%3,principal_id:i%5?'alice@example.com':'bob@example.com'}));
 await s.ledger.alarm();clock+=899000;
 const query={...f.query,from:f.now-7*86400000,to:clock};
 const first=complete(await f.read({query,intent:'browse'}));
 assert.equal(f.calls.find(c=>c.body.action==='groups').body.cut.source,'projection');
 clock+=2000;await s.ledger.alarm();f.calls.length=0;
 const fresh=complete(await f.read({query,intent:'browse'}));
 assert.equal(f.calls.find(c=>c.body.action==='groups').body.allowance.plan,'cells');
 for(const field of ['metrics','costs','groups','buckets','rank'])assert.deepEqual(fresh[field],first[field]);
 for(const report of [first,fresh]){
  const q={...report.query,filters:{...report.query.filters,model:'m1'}};
  const page=complete(await f.continuation({kind:'events',query:q,cut:report.cut,pageSize:100}));
  assert.equal(f.calls.filter(c=>c.body.action==='events').at(-1).body.cut.source,'projection');assert.equal(page.events.length,100);assert.ok(page.nextCursor);assert.ok(page.events.every(e=>e.model==='m1'&&e.user==='alice@example.com'));
  complete(await f.continuation({kind:'release',cut:report.cut,query:report.query}));
 }
 const exported=complete(await f.export({...query,filters:{model:'rare'}}));
 assert.equal(exported.events.length,1);assert.equal(exported.events[0].id,'paired-749');
 assert.equal(f.calls.filter(c=>c.body.action==='events').at(-1).body.cut.source,'projection');
 // A second owner's unfolded tail cannot make a small owner report choose cells.
 for(let i=0;i<32;i++)await f.ingest(s,f.event('tail-'+i,{principal_id:'bob@example.com',occurred_at_ms:query.to-1}));
 f.calls.length=0;const tail=complete(await f.read({query}));assert.deepEqual(tail.metrics,first.metrics);
 assert.equal(f.calls.find(c=>c.body.action==='groups').body.allowance.plan,'raw');
});
