import './typescript-setup.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import {execFileSync} from 'node:child_process';
import {mkdir,mkdtemp,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {completeFixture,complete} from './usage-complete-fixture.mjs';
import {sqliteFixture} from './sqlite-storage.mjs';
const {UsageLedgerObject}=await import('../ledgers.ts');
import {requireBaselineCommit} from '../../test/helpers/personal-usage-baseline.mjs';

// The deployed complete-usage engine before report cells; gradual rollout mixes it with this one.
const baseline='fcdf6900c94ca71fa29411c3b239da8029c98321';
// The deployed ledger with report cells, which still writes every shard's projection.
const cellsRelease='ee02a155e0c3dbec3769ec5beb52fd792745aefc';
async function previous(t,commit=baseline){
 const scratch=resolve('.openclaw/tmp');await mkdir(scratch,{recursive:true});
 const dir=await mkdtemp(join(scratch,'usage-skew-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 execFileSync('tar',['-xf','-','-C',dir],{input:execFileSync('git',['archive',commit,'package.json','worker','shared','packages/provider-plugin-contract/src'],{maxBuffer:64*1024*1024})});
 return {Ledger:(await import(join(dir,'worker/ledgers.ts'))).UsageLedgerObject,read:(await import(join(dir,'worker/usage-report.ts'))).readCompleteUsage};
}
const ttl=15*60000;
/** Two retained shards with folded cells, each servable by the current or the previous ledger code. */
async function mixed(t){
 let at=Date.now();const start=at;t.mock.method(Date,'now',()=>at);
 const old=await previous(t),f=await completeFixture(t,2),shards=[...f.shards.values()];
 for(let i=0;i<24;i++)await f.ingest(i%2,f.event('e'+i,{occurred_at_ms:at-2*3600000+i*271000,model:'m'+i%3,principal_id:'u'+i%2+'@example.com'}));
 for(const s of shards){s.sql.exec('UPDATE usage_report_events SET report_format_version = 1');
  const storage={storage:{sql:s.sql,transactionSync:s.transactionSync,getAlarm:async()=>null,setAlarm:async()=>{}}};
  s.current=s.ledger;s.previous=new old.Ledger(storage);
  for(let i=0;i<4;i++){await s.current.alarm();at+=ttl+1;}}
 const query={...f.query,from:start-3*3600000,to:at,groupBy:'model'};
 return {f,shards,old,query,use:(s,which)=>{s.ledger=s[which];}};
}
const strip=({coverage,cut,...rest})=>rest;

test('either service version reads shards of either version with identical totals',{timeout:60000},async t=>{
 if(!requireBaselineCommit(t,baseline))return;
 const {f,shards,old,query,use}=await mixed(t);
 const expected=complete(await f.read({query}));assert.equal(expected.metrics.calls,24);
 assert.ok(f.calls.filter(c=>c.body.action==='groups').every(c=>c.body.allowance.plan==='cells'));
 // Previous service, current shards: no negotiation, so shards answer with the legacy measure.
 f.calls.length=0;const legacy=complete(await old.read(f.env,f.verify,{kind:'report',intent:'summary',query}));
 assert.deepEqual(strip(legacy),strip(expected));assert.ok(f.calls.filter(c=>c.path==='/complete-usage').every(c=>c.body.allowance?.plan===undefined));
 // Current service, previous shards (one or both): legacy pages, same exact report.
 use(shards[0],'previous');f.calls.length=0;assert.deepEqual(strip(complete(await f.read({query}))),strip(expected));
 use(shards[1],'previous');assert.deepEqual(strip(complete(await f.read({query}))),strip(expected));
});

test('a shard that changes version between capture and pages fails closed or stays legacy',{timeout:60000},async t=>{
 if(!requireBaselineCommit(t,baseline))return;
 const {f,shards,query,use}=await mixed(t);
 // Negotiated capture on current code, then the previous version serves groups: no plan echo.
 f.hook=(call,response)=>{if(call.body.action==='capture'&&call.name===[...f.shards.keys()][0])use(shards[0],'previous');return response;};
 assert.deepEqual(await f.read({query}),{kind:'unavailable',reason:'source'});
 // Legacy capture on previous code, then current code serves its legacy allowance unchanged.
 use(shards[0],'previous');
 f.hook=(call,response)=>{if(call.body.action==='capture')use(shards[0],'current');return response;};
 f.calls.length=0;const r=complete(await f.read({query}));assert.equal(r.metrics.calls,24);
 assert.equal(f.calls.find(c=>c.body.action==='groups'&&c.name===[...f.shards.keys()][0]).body.allowance.plan,undefined);
 // A forged plan echo from a current shard is also rejected.
 f.hook=async(call,response)=>{if(call.body.action!=='groups')return response;const body=await response.json();body.value.work.plan='raw';return Response.json(body);};
 assert.deepEqual(await f.read({query}),{kind:'unavailable',reason:'source'});
});

test('rollback writer inserts and retention deletes keep folded cells exact; roll-forward folds them',{timeout:60000},async t=>{
 if(!requireBaselineCommit(t,baseline))return;
 const {f,shards,query,use}=await mixed(t),s=shards[0],cells=()=>s.sql.exec('SELECT COALESCE(SUM(calls),0) AS n FROM usage_report_cells')[0].n;
 let at=Date.now();t.mock.method(Date,'now',()=>at);const step=async()=>{for(let i=0;i<4;i++){await s.ledger.alarm();at+=15*60000+1;}};
 // A folded row close to retention, so the rollback writer's own cleanup deletes it below every cut floor.
 // (It is not the newest rowid: deleting that one would make the next insert reuse it and flag the cells.)
 await f.ingest(s,f.event('near-expiry',{occurred_at_ms:at-30*86400000+2*3600000}));await f.ingest(s,f.event('recent',{occurred_at_ms:query.from+7200000}));await step();
 const folded=cells();assert.equal(folded,14);
 use(s,'previous');at+=2*3600000;
 for(let i=0;i<5;i++)await f.ingest(s,f.event('rollback-'+i,{occurred_at_ms:query.from+3600000+i,model:'m'+i%2}));
 assert.equal(s.sql.exec("SELECT COUNT(*) AS n FROM usage_events WHERE id = 'near-expiry'")[0].n,0);
 assert.equal(s.sql.exec('SELECT healthy FROM usage_report_cell_state')[0].healthy,1);assert.equal(cells(),folded);
 use(s,'current');const later={...query,to:at};
 f.calls.length=0;const r=complete(await f.read({query:later}));assert.equal(r.metrics.calls,24+1+5);
 assert.ok(f.calls.filter(c=>c.body.action==='groups').every(c=>c.body.allowance.plan==='cells'));
 await step();assert.equal(cells(),folded+5-1,'roll-forward folds the rollback rows and prunes the expired cell');
 assert.equal(complete(await f.read({query:later})).metrics.calls,30);
});

test('upgrade from a previous-version shard keeps its rows, rollups and open continuation, then folds cells',{timeout:60000},async t=>{
 if(!requireBaselineCommit(t,baseline))return;
 let at=Date.now();t.mock.method(Date,'now',()=>at);
 const old=await previous(t),f=await completeFixture(t,1),[name]=[...f.shards.keys()],prior=f.shards.get(name);
 // The shard's schema and history are written by the previous ledger only.
 const storage=sqliteFixture(t),durable={storage:{...storage,getAlarm:async()=>null,setAlarm:async()=>{}}};
 const s={...storage,tenantId:prior.tenantId,policyId:prior.policyId,ledger:new old.Ledger(durable)};f.shards.set(name,s);
 for(let i=0;i<12;i++)await f.ingest(0,f.event('old'+i,{occurred_at_ms:at-3600000+i*60000,model:'m'+i%3}));
 s.sql.exec('UPDATE usage_report_events SET report_format_version = 1');
 assert.equal(s.sql.exec("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'usage_report_cells'")[0].n,0);
 const query={...f.query,from:at-2*3600000,to:at,groupBy:'model'};
 const browse=complete(await old.read(f.env,f.verify,{kind:'report',intent:'browse',query}));assert.equal(browse.metrics.calls,12);
 const ledger=()=>s.sql.exec('SELECT COUNT(*) AS n, TOTAL(json_extract(event_json, \'$.input_tokens\')) AS input FROM usage_events')[0];
 const rollups=()=>s.sql.exec('SELECT TOTAL(request_count) AS n, TOTAL(input_tokens) AS input FROM usage_rollups')[0];
 const [rows,rolled]=[ledger(),rollups()];
 // Upgrade: the current ledger opens the same storage.
 s.ledger=new UsageLedgerObject(durable);
 assert.deepEqual([ledger(),rollups()],[rows,rolled]);
 // The continuation opened before the upgrade still reads the same cut.
 const continued=complete(await f.continuation({kind:'report',intent:'browse',cut:browse.cut,query}));
 assert.deepEqual(strip(continued),strip(browse));
 // New traffic and the alarm fold the old history; reports use cells and stay exact.
 await f.ingest(0,f.event('new0',{occurred_at_ms:at-1000}));
 for(let i=0;i<4;i++){await s.ledger.alarm();at+=ttl+1;}
 assert.equal(s.sql.exec('SELECT COALESCE(SUM(calls),0) AS n FROM usage_report_cells')[0].n,13);
 f.calls.length=0;const later={...query,to:at};const r=complete(await f.read({query:later}));
 assert.equal(r.metrics.calls,13);assert.ok(f.calls.filter(c=>c.body.action==='groups').every(c=>c.body.allowance.plan==='cells'));
 assert.equal(rollups().n,rolled.n+1);
});

test('history that predates the projection: upgrade stops extending its unread projection and reclaims it; rollback and migration stay exact',{timeout:120000},async t=>{
 if(!requireBaselineCommit(t,cellsRelease))return;
 let at=Date.now();const start=at;t.mock.method(Date,'now',()=>at);
 const old=await previous(t,cellsRelease),f=await completeFixture(t,1),[name]=[...f.shards.keys()],prior=f.shards.get(name);
 // Canonical rows written before the reporting projection existed (the pre-projection ledger schema).
 const storage=sqliteFixture(t),alarms=[],logs=[];
 storage.sql.exec('CREATE TABLE usage_events (id TEXT PRIMARY KEY, occurred_at_ms INTEGER NOT NULL, tenant_id TEXT NOT NULL, policy_id TEXT NOT NULL, provider TEXT NOT NULL, status TEXT NOT NULL, status_code INTEGER, input_tokens INTEGER, output_tokens INTEGER, total_tokens INTEGER, actual_cost_micros INTEGER NOT NULL, event_json TEXT NOT NULL)');
 for(let i=0;i<300;i++){const e={...f.event('pre'+i,{occurred_at_ms:start-3600000+i*1000,model:'m'+i%3}),tenant_id:prior.tenantId,policy_id:prior.policyId};
  storage.sql.exec('INSERT INTO usage_events VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',e.id,e.occurred_at_ms,e.tenant_id,e.policy_id,e.provider,e.status,e.status_code,e.input_tokens,e.output_tokens,e.total_tokens,e.actual_cost_micros,JSON.stringify(e));}
 const durable={storage:{...storage,getAlarm:async()=>null,setAlarm:async next=>{alarms.push(next-at);}}};
 const s={...storage,tenantId:prior.tenantId,policyId:prior.policyId,ledger:new old.Ledger(durable)};f.shards.set(name,s);
 const count=table=>s.sql.exec('SELECT COUNT(*) AS n FROM '+table)[0].n;
 const canonical=()=>({...s.sql.exec("SELECT COUNT(*) AS n, TOTAL(json_extract(event_json, '$.input_tokens')) AS input FROM usage_events")[0]});
 const truth=()=>Object.fromEntries(s.sql.exec("SELECT json_extract(event_json, '$.model') AS m, COUNT(*) AS n FROM usage_events GROUP BY m").map(r=>[r.m,r.n]));
 const rollups=()=>s.sql.exec('SELECT TOTAL(request_count) AS n FROM usage_rollups')[0].n;
 // Alarm steps (attribution, rollups, reclaim, cell folds) until every row is folded, opening each fold fence.
 const settle=async()=>{for(let i=0;i<200;i++){await s.ledger.alarm();const c=s.sql.exec('SELECT folded_rowid AS f, target_rowid AS g, healthy AS h FROM usage_report_cell_state')[0];
  if(c.h&&c.f===c.g&&c.g>=s.sql.exec('SELECT MAX(rowid) AS n FROM usage_events')[0].n)return;at+=ttl+1;}assert.fail('alarm steps did not settle');};
 const query=()=>({...f.query,from:start-2*3600000,to:at,groupBy:'model'});
 const byModel=r=>Object.fromEntries(r.groups.map(g=>[g.identity.value,g.metrics.calls]));
 const read=async source=>{f.calls.length=0;const r=complete(await f.read({query:query()})),groups=f.calls.filter(c=>c.body.action==='groups');
  assert.ok(groups.length&&groups.every(c=>c.body.allowance.plan==='cells'&&c.body.cut.source===source));assert.deepEqual(byModel(r),truth());return r;};
 // The deployed writer projects every new row, but coverage never verified the older history: no reader uses the copy.
 for(let i=0;i<2300;i++)await f.ingest(0,f.event('deployed'+i,{occurred_at_ms:at-1800000+i*700,model:'m'+i%3,principal_id:'u'+i%4+'@example.com'}));
 await settle();assert.equal(count('usage_report_events'),2300);
 assert.equal((await read('retained_ledger')).metrics.calls,2600);
 // Upgrade: ingest stops extending the unread projection and wakes the alarm, which reclaims it 2,000 rows per step.
 s.ledger=new UsageLedgerObject(durable);t.mock.method(console,'log',line=>{try{logs.push(JSON.parse(line).event);}catch{}});
 const [rows,rolled]=[canonical(),rollups()];alarms.length=0;
 await f.ingest(0,f.event('upgraded',{occurred_at_ms:at-1000,model:'m0'}));
 assert.equal(count('usage_report_events'),2300);assert.deepEqual(alarms,[500]);
 await s.ledger.alarm();assert.equal(count('usage_report_events'),300);assert.ok(!logs.includes('usage_report_projection_reclaimed'));
 await s.ledger.alarm();assert.equal(count('usage_report_events'),0);assert.equal(logs.filter(e=>e==='usage_report_projection_reclaimed').length,1);
 // Only the derived copy goes: the canonical ledger and its rollups keep every row.
 assert.deepEqual(canonical(),{n:rows.n+1,input:rows.input+1});assert.equal(rollups(),rolled+1);
 await settle();assert.equal((await read('retained_ledger')).metrics.calls,2601);
 // Rollback: the deployed writer extends the unread projection again and reports stay exact. Roll-forward reclaims it.
 s.ledger=new old.Ledger(durable);for(let i=0;i<3;i++)await f.ingest(0,f.event('rollback'+i,{occurred_at_ms:at-500+i,model:'m1'}));
 assert.equal(count('usage_report_events'),3);assert.equal((await read('retained_ledger')).metrics.calls,2604);
 s.ledger=new UsageLedgerObject(durable);await s.ledger.alarm();assert.equal(count('usage_report_events'),0);
 // The explicit migration still rebuilds the projection: rows ingested during its round are projected, the alarm never
 // reclaims a projection in a current round, and once complete its cuts serve the same exact report through cells.
 const migrate=async()=>{const r=await s.ledger.fetch(new Request('https://private/reporting-migration',{method:'POST',body:JSON.stringify({apply:true,batchSize:1000,now:at})}));assert.equal(r.status,200);return r.json();};
 assert.equal((await migrate()).complete,false);assert.equal(count('usage_report_events'),1000);
 await f.ingest(0,f.event('during-round',{occurred_at_ms:at-100,model:'m2'}));await s.ledger.alarm();assert.equal(count('usage_report_events'),1001);
 while(!(await migrate()).complete);assert.equal(count('usage_report_events'),canonical().n);
 await settle();assert.equal((await read('projection')).metrics.calls,2605);
 // A shard first written after the projection shipped keeps its trusted projection and its writes.
 const fresh=f.addShard(prior.tenantId,'fresh');await f.ingest(fresh,f.event('fresh0',{occurred_at_ms:at-100}));await fresh.ledger.alarm();
 assert.equal(fresh.sql.exec('SELECT COUNT(*) AS n FROM usage_report_events')[0].n,1);
});
