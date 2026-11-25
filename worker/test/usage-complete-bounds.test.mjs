import assert from 'node:assert/strict';
import test from 'node:test';
import {completeFixture,complete} from './usage-complete-fixture.mjs';

// Synthetic old-writer rows, through real canonical SQL/triggers. Visibility was
// disabled before the batch; the production read must drain/rebase it itself.
function oldRows(shard,count,now,groups=1,padding=0){
 shard.sql.exec('UPDATE usage_report_visibility SET usable=0');
 shard.sql.exec("WITH RECURSIVE n(i) AS (VALUES(0) UNION ALL SELECT i+1 FROM n WHERE i+1<?) INSERT INTO usage_events(id,occurred_at_ms,tenant_id,policy_id,provider,status,actual_cost_micros,event_json,principal_key) SELECT 'bulk-'||i,?, ?,?,'openai','success',0,json_object('model','g'||(i % ?),'metadata',?), 'alice@example.com' FROM n",count,now-1000,shard.tenantId,shard.policyId,groups,'x'.repeat(padding));
}

test('250000 candidate boundary preflights lengths before parsing; 250001 fails whole',{timeout:60000},async t=>{
 const f=await completeFixture(t,1),s=[...f.shards.values()][0],start=performance.now();oldRows(s,250000,f.now);
 const r=complete(await f.read());assert.equal(r.metrics.calls,250000);assert.equal(r.chargeReportedCalls,0);
 s.sql.exec("INSERT INTO usage_events(id,occurred_at_ms,tenant_id,policy_id,provider,status,actual_cost_micros,event_json,principal_key) VALUES('over',?,'tenant','p0','openai','success',0,'{}','alice@example.com')",f.now-1000);
 const before=f.calls.length;assert.deepEqual(await f.read(),{kind:'unavailable',reason:'capacity'});assert.equal(f.calls.slice(before).some(c=>c.body.action==='groups'),false);
 t.diagnostic(JSON.stringify({rows:250000,source:'retained',elapsedMs:Math.round(performance.now()-start),heapUsed:process.memoryUsage().heapUsed}));
});

test('one million report candidates cap applies across shards before aggregation',{timeout:60000},async t=>{
 const f=await completeFixture(t,5);for(const s of f.shards.values())oldRows(s,200001,f.now);
 assert.deepEqual(await f.read({intent:'browse'}),{kind:'unavailable',reason:'capacity'});assert.equal(f.calls.some(c=>c.body.action==='groups'),false);assert.equal(f.owner.usageCuts.roots.size,0);
});

test('retained input metadata length ceiling fails before any JSON scalar work',async t=>{
 const f=await completeFixture(t,1);oldRows([...f.shards.values()][0],1025,f.now,1,65536);
 assert.deepEqual(await f.read(),{kind:'unavailable',reason:'capacity'});assert.equal(f.calls.some(c=>c.body.action==='groups'),false);
});

test('64-shard success uses <=8 fanout; 65 fails discovery, cumulative RPC includes final checks',{timeout:60000},async t=>{
 const f=await completeFixture(t,64),start=performance.now();
 const empty=complete(await f.read());assert.equal(empty.metrics.calls,0);assert.equal(f.calls.filter(c=>c.body.action==='validate').length,64);assert.ok(f.peak<=8);
 t.diagnostic(JSON.stringify({shards:64,emptyReportMs:Math.round(performance.now()-start),calls:f.calls.length,peakFanout:f.peak}));
 for(const s of f.shards.values())oldRows(s,257,f.now,257);
 const before=f.calls.length;assert.deepEqual(await f.read(),{kind:'unavailable',reason:'capacity'});const calls=f.calls.slice(before);assert.ok(calls.length<=256);assert.ok(calls.some(c=>c.body.action==='validate'));assert.ok(calls.filter(c=>c.body.action==='validate').length<64);
 await f.direct('/policies/put',{policyId:'65',policy:{tenantId:'tenant'}});const n=f.calls.length;assert.deepEqual(await f.read(),{kind:'unavailable',reason:'capacity'});assert.equal(f.calls.slice(n).some(c=>c.path==='/complete-usage'),false);
});

test('cumulative classified bytes are charged again on each group page',{timeout:60000},async t=>{
 const f=await completeFixture(t,1),s=[...f.shards.values()][0];oldRows(s,9000,f.now,9000,1900);
 const size=s.sql.exec('SELECT SUM(length(CAST(event_json AS BLOB))) AS n FROM usage_events')[0].n,start=performance.now();
 const r=await f.read(),pages=f.calls.filter(c=>c.body.action==='groups').length;
 assert.deepEqual(r,{kind:'unavailable',reason:'capacity'});assert.ok(pages<Math.ceil(9000/256));assert.ok(pages*size<=512*1024*1024);assert.ok((pages+1)*size>512*1024*1024);
 t.diagnostic(JSON.stringify({classifiedBytesPerPage:size,issuedPages:pages,chargedBytes:pages*size,elapsedMs:Math.round(performance.now()-start)}));
});

test('cumulative row visits do not reset at identity page boundaries',{timeout:60000},async t=>{
 const f=await completeFixture(t,1);oldRows([...f.shards.values()][0],100001,f.now,21000);
 // Freeze only this operation's elapsed clock to isolate the row-work guard;
 // ordinary deadlines are exercised independently, not claimed waived in production.
 const elapsed=performance.now.bind(performance),start=elapsed();t.mock.timers.enable({apis:['setTimeout']});t.mock.method(performance,'now',()=>0);
 const result=await f.read(),pages=f.calls.filter(c=>c.body.action==='groups').length;
 assert.deepEqual(result,{kind:'unavailable',reason:'capacity'});assert.equal(pages,79);
 t.diagnostic(JSON.stringify({rows:100001,pages,visits:100001*pages,elapsedMs:Math.round(elapsed()-start),elapsedClockFrozen:true}));
});

test('actual projection/retained owner and all-principal SQL plans are time-bounded and fence-indexed',async t=>{
 const f=await completeFixture(t,1),s=[...f.shards.values()][0];await f.ingest(0,f.event('one'));
 const statements=[],exec=s.sql.exec;s.sql.exec=(sql,...args)=>{if(sql.startsWith('WITH ')||sql.includes('length(CAST(')&&sql.includes('LIMIT'))statements.push({sql,args});return exec(sql,...args);};
 const plans=[];
 for(const retained of [false,true]){
  if(retained)s.sql.exec('UPDATE usage_report_events SET report_format_version=1');
  for(const user of [undefined,'alice@example.com']){
   const r=complete(await f.read({intent:'browse',query:{...f.query,filters:user?{user}:{}}}));complete(await f.continuation({kind:'events',cut:r.cut,query:r.query,pageSize:100}));
   const latest=statements.at(-1),plan=s.db.prepare('EXPLAIN QUERY PLAN '+latest.sql).all(...latest.args),index=retained?user?'usage_events_report_owner':'usage_events_report_scope':user?'usage_report_owner_range':'usage_report_scope_range';
   assert.ok(plan.some(p=>p.detail.includes(index)&&p.detail.includes('occurred_at_ms>?')));assert.ok(plan.some(p=>p.detail.includes('usage_report_arrivals')&&p.detail.includes('id=?')));assert.equal(plan.some(p=>p.detail.includes('TEMP B-TREE')),false);
   plans.push({source:retained?'retained':'projection',owner:!!user,plan});
  }
 }
 t.diagnostic(JSON.stringify({plans}));
});

test('representative 5000-row export and three-index rebuild cost use real paired ingestion',{timeout:60000},async t=>{
 const f=await completeFixture(t,1),s=[...f.shards.values()][0],start=performance.now();
 for(let i=0;i<5000;i++)await f.ingest(0,f.event('e'+String(i).padStart(5,'0'),{model:'m'+(i%100)}));
 const ingestMs=performance.now()-start;
 for(const name of ['usage_report_scope_range','usage_events_report_scope','usage_events_report_owner'])s.sql.exec('DROP INDEX '+name);
 const pages=()=>s.sql.exec('PRAGMA page_count')[0].page_count-s.sql.exec('PRAGMA freelist_count')[0].freelist_count,before=pages(),at=performance.now();
 const {ensureUsageReportSchema}=await import('../usage-report-store.ts');s.transactionSync(()=>ensureUsageReportSchema(s.sql));
 const indexBuildMs=performance.now()-at,indexBytes=(pages()-before)*s.sql.exec('PRAGMA page_size')[0].page_size;
 assert.equal(s.sql.exec('SELECT COUNT(*) AS n FROM usage_events')[0].n,5000);assert.equal(s.sql.exec('SELECT COUNT(*) AS n FROM usage_report_events')[0].n,5000);assert.ok(indexBytes>0);
 const opened=performance.now(),result=complete(await f.export()),exportMs=performance.now()-opened;
 assert.equal(result.events.length,5000);assert.equal(result.report.metrics.calls,5000);assert.equal(result.report.recordedChargeMicros,35000);assert.equal(result.report.metrics.inputTokens,5000);assert.equal(f.owner.usageCuts.roots.size,0);
 t.diagnostic(JSON.stringify({qualification:'Node SQLite single-run, not DO capacity or speedup',rows:5000,groups:100,ingestMs:Math.round(ingestMs),indexBuildMs:Math.round(indexBuildMs),indexLivePageBytes:indexBytes,exportMs:Math.round(exportMs),exportBytes:Buffer.byteLength(JSON.stringify(result)),heapUsed:process.memoryUsage().heapUsed,privateCalls:f.calls.length}));
});
