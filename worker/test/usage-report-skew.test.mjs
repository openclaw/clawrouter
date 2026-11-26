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
async function previous(t){
 const scratch=resolve('.openclaw/tmp');await mkdir(scratch,{recursive:true});
 const dir=await mkdtemp(join(scratch,'usage-skew-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 execFileSync('tar',['-xf','-','-C',dir],{input:execFileSync('git',['archive',baseline,'package.json','worker','shared','packages/provider-plugin-contract/src'],{maxBuffer:64*1024*1024})});
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
