import './typescript-setup.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import {sqliteFixture} from './sqlite-storage.mjs';
const {PolicyBindingIndexObject}=await import('../authority.ts');
const ttl=30*86400000;
function fixture(t,name='policy-bindings') {
 const storage=sqliteFixture(t),env={ACCESS_CONTROL:{idFromName:n=>n}},owner=new PolicyBindingIndexObject({id:name,storage},env);
 const call=(path,body={})=>owner.fetch(new Request('https://internal'+path,{method:'POST',body:JSON.stringify(body)}));
 const put=(id,tenant)=>call('/policies/put',{policyId:id,policy:{tenantId:tenant}});
 const inventory=async()=>{const r=await call('/usage-inventory');assert.equal(r.status,200,await r.clone().text());return r.json()};
 const state=()=>storage.sql.exec('SELECT * FROM usage_inventory_state')[0];
 return {...storage,owner,env,call,put,inventory,state};
}
test('only policy-bindings installs inventory; reporting never initializes authority',async t=>{
 const other=fixture(t,'other');assert.equal((await other.call('/usage-inventory')).status,404);
 assert.equal(other.sql.exec("SELECT name FROM sqlite_master WHERE name='usage_inventory_state'").length,0);
 const f=fixture(t);assert.equal((await f.call('/usage-inventory')).status,503);
 assert.equal((await f.call('/policies/initialize-all',[])).status,200);
 const inv=await f.inventory();assert.deepEqual(inv.addresses,[]);
 assert.equal(inv.historicalLocations,'not_exhaustively_assessed');assert.equal(inv.formerLocationLateWrites,'not_bounded');
 assert.equal((await f.call('/usage-inventory',{from:1})).status,400);
});
test('put, current init, collected init and staged journal all use persistent mutation boundary',async t=>{
 const f=fixture(t);
 assert.equal((await f.call('/policies/initialize',[{policyId:'p',policy:{tenantId:null}}])).status,200);
 await f.put('p','second');await f.put('p','second');await f.put('p',null);
 const input={entries:[{policyId:'collected',policy:{tenantId:'nested'}}],retainRequestContentDefault:false};
 const r=await f.owner.fetch(new Request('https://internal/policies/initialize',{method:'POST',headers:{'x-clawrouter-policy-collection':'v1'},body:JSON.stringify(input)}));
 assert.equal(r.status,200,await r.text());
 const bound={bytes:0,identity:{},staged:new Map(),commit:[]};
 f.owner.stageIdentityRecord(bound,'access_policies','policy_id','policy_json','staged',{tenantId:'stage'},'policies_global_initialized');
 for(const commit of bound.commit)commit();
 await f.put('staged','later');await f.call('/policies/initialize-all',[]);
 const inv=await f.inventory();
 assert.deepEqual(inv.addresses.map(a=>a.policyId+':'+a.tenantId).sort(),['collected:nested','p:default','p:second','staged:later','staged:stage']);
 assert.equal(f.state().retired_rows,3);assert.equal(inv.captureAudit.captureGapObserved,false);
});
test('actual REPLACE looks up old row with recursive triggers off; UPDATE and DELETE retire',async t=>{
 const f=fixture(t);await f.call('/policies/initialize-all',[]);f.sql.exec('PRAGMA recursive_triggers=OFF');
 await f.put('p','a');f.sql.exec('INSERT OR REPLACE INTO access_policies VALUES (?,?)','p','{"tenantId":"b"}');
 f.sql.exec('UPDATE access_policies SET policy_id=?,policy_json=? WHERE policy_id=?','q','{"tenantId":"c"}','p');
 f.sql.exec('DELETE FROM access_policies WHERE policy_id=?','q');
 assert.deepEqual((await f.inventory()).addresses.map(a=>a.policyId+':'+a.tenantId).sort(),['p:a','p:b','q:c']);
});
test('failed SQL statement rolls back trigger metadata; journal preserves earlier writes',async t=>{
 const f=fixture(t);await f.put('p','a');const before=f.state();
 assert.throws(()=>f.sql.exec('INSERT INTO access_policies VALUES (?,?)','p','{"tenantId":"b"}'));
 assert.deepEqual(f.state(),before);assert.equal(f.sql.exec('SELECT * FROM usage_shard_retired').length,0);
 const journal={bridge:{entries:[{kind:'seed',family:1,key:'first',text:'{"tenantId":"one"}',marker:'policies_global_initialized'},{kind:'seed',family:1,key:'bad',text:null,marker:'policies_global_initialized'}],attempted:false}};
 assert.throws(()=>f.owner.executeAdmissionJournal(journal));
 assert.equal(f.sql.exec('SELECT policy_id FROM access_policies WHERE policy_id=?','first').length,1);
 assert.equal(f.sql.exec('SELECT policy_id FROM access_policies WHERE policy_id=?','bad').length,0);
 assert.throws(()=>f.owner.executeAdmissionJournal(journal));
});
test('malformed JSON and oversize addresses never fail canonical writes; read unavailable honestly',async t=>{
 const f=fixture(t);await f.call('/policies/initialize-all',[]);await f.put('p','a');
 f.sql.exec('INSERT OR REPLACE INTO access_policies VALUES (?,?)','p','{');assert.equal(f.state().capture_gap,1);
 assert.equal((await f.call('/usage-inventory')).status,503);
 await f.put('p','x'.repeat(2049));assert.equal((await f.call('/usage-inventory')).status,503);
 await f.put('p','valid');const inv=await f.inventory();assert.equal(inv.captureAudit.captureGapObserved,true);
 assert.deepEqual(inv.addresses.map(a=>a.tenantId).sort(),['a','valid']);
});
test('exact row cap and byte cap cannot reject a policy mutation or admit an extra retirement',async t=>{
 for(const mode of ['rows','bytes']) {
  const f=fixture(t);await f.call('/policies/initialize-all',[]);await f.put('p','old');
  const n=mode==='rows'?8192:4096, tenant=mode==='rows'?'t':'x'.repeat(2040);
  const insert=f.db.prepare('INSERT INTO usage_shard_retired VALUES (?,?,?)');
  f.db.exec('BEGIN');for(let i=0;i<n;i++)insert.run(('id'+i).padEnd(8,'_'),tenant,Date.now());f.db.exec('COMMIT');
  assert.equal((await f.put('p','new')).status,200);
  assert.equal(f.state().retired_rows,n);assert.equal(f.state().capture_gap,1);
  assert.equal(f.sql.exec('SELECT tenant_id FROM usage_shard_retired WHERE policy_id=?','p').length,0);
  assert.equal(JSON.parse(f.sql.exec('SELECT policy_json FROM access_policies WHERE policy_id=?','p')[0].policy_json).tenantId,'new');
 }
});
test('authority clock equality expires with revision change, backward clocks cannot resurrect, current remains',async t=>{
 const f=fixture(t);await f.call('/policies/initialize-all',[]);await f.put('p','a');await f.put('p','b');await f.put('p','a');
 const first=await f.inventory(),at=f.state().observed_clock+1000;
 f.sql.exec('UPDATE usage_shard_retired SET retired_at_ms=?',at-ttl);
 f.sql.exec('UPDATE usage_inventory_state SET observed_clock=?',at);
 const second=await f.inventory();assert.notEqual(first.revision,second.revision);
 assert.deepEqual(second.addresses,[{policyId:'p',tenantId:'a'}]);assert.equal(f.state().retired_rows,0);
 assert.equal(f.state().observed_clock,at);assert.equal((await f.inventory()).revision,second.revision);
 assert.equal(second.historicalLocations,'not_exhaustively_assessed');
});
test('manifest gap resets verified interval, invalidates revision, captures subsequent old SQL writes',async t=>{
 const f=fixture(t);await f.call('/policies/initialize-all',[]);await f.put('p','a');const first=await f.inventory();
 f.sql.exec('DROP TRIGGER usage_inventory_insert_v1');await f.put('p','lost');
 const repaired=await f.inventory();assert.notEqual(first.revision,repaired.revision);assert.equal(repaired.captureAudit.captureGapObserved,true);
 assert.equal(repaired.captureAudit.startedAt,first.captureAudit.startedAt);
 await f.put('p','new');assert.ok((await f.inventory()).addresses.some(a=>a.tenantId==='lost'));
});
test('last row/byte capacity admitted exactly once; response cap never returns first-N',async t=>{
 for(const mode of ['rows','bytes']){
  const f=fixture(t);await f.call('/policies/initialize-all',[]);await f.put('p',mode==='rows'?'old':'x'.repeat(2047));
  const n=mode==='rows'?8191:4095,tenant=mode==='rows'?'t':'x'.repeat(2040),insert=f.db.prepare('INSERT INTO usage_shard_retired VALUES (?,?,?)');
  f.db.exec('BEGIN');for(let i=0;i<n;i++)insert.run(('id'+i).padEnd(8,'_'),tenant,Date.now());f.db.exec('COMMIT');
  await f.put('p','next');assert.equal(f.state().retired_rows,n+1);assert.equal(f.state().capture_gap,0);
  if(mode==='bytes')assert.equal(f.state().retired_bytes,8388608);
  await f.put('p','final');assert.equal(f.state().retired_rows,n+1);assert.equal(f.state().capture_gap,1);
  if(mode==='bytes')assert.equal((await f.call('/usage-inventory')).status,503);
 }
});
test('current preflight rejects >2048 policies before enumeration; wrong tenant types unavailable',async t=>{
 const f=fixture(t);await f.call('/policies/initialize-all',[]);
 const insert=f.db.prepare('INSERT INTO access_policies VALUES (?,?)');f.db.exec('BEGIN');for(let i=0;i<2049;i++)insert.run('p'+i,'{}');f.db.exec('COMMIT');
 assert.equal((await f.call('/usage-inventory')).status,503);
 f.sql.exec('DELETE FROM access_policies');f.sql.exec('INSERT INTO access_policies VALUES (?,?)','p','{"tenantId":2}');
 assert.equal((await f.call('/usage-inventory')).status,503);assert.equal(f.state().capture_gap,1);
});
test('private lifecycle performs read-time expiry revision before root validation, without global KV init',async t=>{
 const f=fixture(t),binding={actor:'a'.repeat(64),session:'b'.repeat(64),authority:'c'.repeat(64)},base={from:1,to:100,timezone:'UTC',grain:'day',groupBy:'model',rankBy:'calls',filters:{}};
 await f.put('p','a');await f.put('p','b');
 const open=await (await f.call('/usage-cuts/reserve',{binding,purpose:'browse',base})).json();assert.ok(open.operation);
 const ready=await (await f.call('/usage-cuts/finalize',{binding,operation:open.operation,capture:{effectiveFrom:1,capturedBetween:{from:1,to:2},vector:[]}})).json();assert.ok(ready.cut);
 const clock=f.state().observed_clock;f.sql.exec('UPDATE usage_shard_retired SET retired_at_ms=?',clock-ttl);
 const read=await f.call('/usage-cuts/read',{binding,cut:ready.cut,query:base});assert.equal(read.status,410);assert.equal(f.state().retired_rows,0);
 assert.equal((await f.call('/usage-cuts/release',{binding,cut:ready.cut})).status,200);
});
