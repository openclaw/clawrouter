import './typescript-setup.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import {UsageReportCuts} from '../usage-report-cuts.ts';
const rev='a'.repeat(32),base={from:1,to:100000,timezone:'UTC',grain:'day',groupBy:'model',rankBy:'calls',filters:{}};
const binding=(id=1)=>({actor:id.toString(16).padStart(64,'0'),session:'b'.repeat(64),authority:'c'.repeat(64)});
const captured=(n=1,width=10)=>({effectiveFrom:1,capturedBetween:{from:2,to:3},vector:Array.from({length:n},(_,i)=>({tenantId:'t'.repeat(width),policyId:String(i).padStart(5,'0'),cut:{seq:1,epoch:'e'.repeat(32),createdAt:1,expiresAt:900001,floor:1,source:'retained_ledger',normalizer:2}}))});
function fixture(t){t.mock.timers.enable({apis:['Date','setTimeout'],now:1000000});const owner=new UsageReportCuts();
 const call=(action,input,b=binding(),revision=rev)=>owner.dispatch(action,{binding:b,...input},revision);
 const reserve=(purpose='browse',b=binding(),q=base)=>call('reserve',{purpose,base:q},b);
 const open=(purpose='browse',b=binding(),c=captured(),q=base)=>{const r=reserve(purpose,b,q);return {...r,...call('finalize',{operation:r.operation,capture:c},b)}};
 const read=(cut,b=binding(),q=base)=>call('read',{cut,query:q},b);
 return {owner,call,reserve,open,read};}
const error=code=>e=>e.code==='usage_cut_'+code;
test('20 minutes of 30-second summaries allocate no roots; continuation fields rejected',t=>{
 const f=fixture(t);for(let i=0;i<41;i++){assert.deepEqual(f.reserve('summary'),{cut:null});t.mock.timers.tick(30000)}
 assert.equal(f.owner.roots.size,0);
 assert.throws(()=>f.call('reserve',{purpose:'summary',base,cut:'x'.repeat(43)}),error('invalid'));
});
test('browse replacement is oldest ready, binding-local, protected exports survive churn',t=>{
 const f=fixture(t),other=f.open('browse',binding(2)),exp=f.open('export'),a=f.open(),b=f.open();
 const c=f.open();assert.throws(()=>f.read(a.cut),error('restart'));assert.ok(f.read(b.cut));assert.ok(f.read(c.cut));
 for(let i=0;i<20;i++)f.open();assert.ok(f.read(exp.cut));assert.ok(f.read(other.cut,binding(2)));
 f.open('export');assert.throws(()=>f.open('export'),error('capacity'));
});
test('pending roots cannot be evicted; timer expires abandoned work at exact equality',t=>{
 const f=fixture(t),a=f.reserve(),b=f.reserve();assert.throws(()=>f.reserve(),error('capacity'));
 t.mock.timers.tick(19999);assert.deepEqual(f.call('observe',{operation:a.operation}),{state:'pending'});
 t.mock.timers.tick(1);assert.equal(f.owner.roots.size,0);assert.throws(()=>f.call('finalize',{operation:b.operation,capture:captured()}),error('restart'));
 assert.ok(f.reserve().operation);
});
test('failed replacement never resurrects; matching cancellation is idempotent',t=>{
 const f=fixture(t),a=f.open();f.open();const p=f.reserve();
 assert.throws(()=>f.call('finalize',{operation:p.operation,capture:captured(65)}),error('capacity'));
 assert.throws(()=>f.read(a.cut),error('restart'));assert.throws(()=>f.call('observe',{operation:p.operation}),error('restart'));
 const q=f.reserve();assert.deepEqual(f.call('release',{operation:q.operation}),{released:true});assert.deepEqual(f.call('release',{operation:q.operation}),{released:true});
});
test('finalize observed/idempotent only for same capture and binding; memory owner loss restarts',t=>{
 const f=fixture(t),a=f.open();assert.equal(f.call('finalize',{operation:a.operation,capture:captured()}).cut,a.cut);
 assert.equal(f.call('observe',{operation:a.operation}).cut,a.cut);
 assert.throws(()=>f.call('finalize',{operation:a.operation,capture:captured(2)}),error('restart'));
 assert.throws(()=>f.read(a.cut,binding(2)),error('restart'));
 assert.throws(()=>new UsageReportCuts().dispatch('read',{binding:binding(),cut:a.cut,query:base},rev),error('restart'));
 assert.equal(Buffer.from(a.cut,'base64url').length,32);assert.match(a.cut,/^[A-Za-z0-9_-]{43}$/);
});
test('binding/session/authority changes and discovery revision reject both purposes; foreign release denied',t=>{
 const f=fixture(t);for(const purpose of ['browse','export']){const a=f.open(purpose);
 for(const key of ['actor','session','authority'])assert.throws(()=>f.read(a.cut,{...binding(),[key]:'d'.repeat(64)}),error('restart'));
 assert.throws(()=>f.call('release',{cut:a.cut},binding(2)),error('restart'));assert.ok(f.read(a.cut));
 assert.throws(()=>f.call('read',{cut:a.cut,query:base},binding(),'b'.repeat(32)),error('restart'));
 }
});
test('fixed TTL cannot be extended by reads/backward clock and lost release expires',t=>{
 const f=fixture(t),a=f.open();t.mock.timers.tick(899999);assert.ok(f.read(a.cut));
 t.mock.timers.tick(1);assert.equal(f.owner.roots.size,0);assert.throws(()=>f.read(a.cut),error('restart'));
 const b=f.open();t.mock.timers.setTime(0);assert.ok(f.read(b.cut));t.mock.timers.setTime(b.expiresAt);assert.throws(()=>f.read(b.cut),error('restart'));
});
test('refinement cannot widen base, cursor binds presentation/page size, ring retries then evicts',t=>{
 const f=fixture(t),q={...base,filters:{user:'alice'}},a=f.open('browse',binding(),captured(),q);
 assert.throws(()=>f.read(a.cut,binding()),error('restart'));
 const narrow={...q,from:2,filters:{user:'alice',model:'m'}};assert.ok(f.read(a.cut,binding(),narrow));assert.ok(f.read(a.cut,binding(),q));
 const input={cut:a.cut,query:narrow,pageSize:25,position:{at:100,id:'event',shard:0}};
 const first=f.call('cursor',input);assert.deepEqual(f.call('cursor',input),first);
 const {position,...get}=input;assert.equal(f.call('cursor',{...get,...first}).id,'event');
 assert.throws(()=>f.call('cursor',{...get,...first,pageSize:50}),error('restart'));
 assert.throws(()=>f.call('cursor',{...get,...first,query:{...narrow,timezone:'Europe/Paris'}}),error('restart'));
 for(let i=0;i<8;i++)f.call('cursor',{...input,position:{...position,id:'event'+i}});
 assert.throws(()=>f.call('cursor',{...get,...first}),error('restart'));
});
test('global 256 includes pending and never evicts another binding',t=>{
 const f=fixture(t),ops=[];for(let i=0;i<256;i++)ops.push(f.reserve('export',binding(i+1)));
 assert.throws(()=>f.reserve('export',binding(257)),error('capacity'));
 assert.equal(f.call('observe',{operation:ops[0].operation}).state,'pending');
});
test('qualification: 32 bindings x browse/export at 16 shards with cursor progression, then 64 maximum-width shards',t=>{
 const f=fixture(t),start=performance.now(),heap=process.memoryUsage().heapUsed,admitted=[];let max=0,peakHeap=heap;
 for(let i=1;i<=32;i++)for(const purpose of ['browse','export']){
  const b=binding(i),r=f.open(purpose,b,captured(16));admitted.push({...r,binding:b,shards:16});
  for(let j=0;j<10;j++)f.call('cursor',{cut:r.cut,query:base,pageSize:100,position:{at:99-j,id:'event'+j,shard:j%16}},b);
  assert.equal(f.read(r.cut,b).capture.vector.length,16);peakHeap=Math.max(peakHeap,process.memoryUsage().heapUsed);
 }
 for(const root of f.owner.roots.values())max=Math.max(max,Buffer.byteLength(JSON.stringify(root)));
 const total=[...f.owner.roots.values()].reduce((n,r)=>n+Buffer.byteLength(JSON.stringify(r)),0),roots=admitted.length;
 const wide=f.open('export',binding(99),captured(64,2043));admitted.push({...wide,binding:binding(99),shards:64});
 let retainedRoots=0,observedRestarts=0;
 // Verify ALL earlier capabilities after the complete workload and widest admission.
 for(const entry of admitted){try{assert.equal(f.read(entry.cut,entry.binding).capture.vector.length,entry.shards);retainedRoots++}
  catch(error){assert.equal(error.code,'usage_cut_restart');observedRestarts++}}
 const expectedRoots=admitted.length,residentRoots=admitted.filter(entry=>f.owner.roots.has(entry.operation)).length;
 const observedEvictions=expectedRoots-residentRoots;peakHeap=Math.max(peakHeap,process.memoryUsage().heapUsed);
 t.diagnostic(JSON.stringify({qualification:'local single-run, not production capacity or speedup',bindings:32,roots,shards:16,rootMaxBytes:max,totalBytes:total,sampledPeakHeapBytes:peakHeap,heapStartBytes:heap,maxWidthRootBytes:f.owner.roots.has(wide.operation)?Buffer.byteLength(JSON.stringify(f.owner.roots.get(wide.operation))):null,latencyMs:performance.now()-start,expectedRoots,residentRoots,retainedRoots,observedEvictions,observedRestarts}));
 assert.equal(expectedRoots,65);assert.equal(residentRoots,expectedRoots);assert.equal(f.owner.roots.size,expectedRoots);
 assert.equal(retainedRoots,expectedRoots);assert.equal(observedRestarts,0);assert.equal(observedEvictions,0);
});
test('global byte admission fails before count; invalid cursor growth publishes nothing',t=>{
 const f=fixture(t);let accepted=0;const wide=captured(64,2043);for(const v of wide.vector)v.tenantId='\0'.repeat(2043);
 let failed=false;for(let i=1;i<=256;i++){try{f.open('export',binding(i),wide);accepted++}catch(e){assert.equal(e.code,'usage_cut_capacity');failed=true;break}}
 assert.equal(failed,true);assert.ok(accepted<256);assert.equal(f.owner.roots.size,accepted);
 assert.ok([...f.owner.roots.values()].reduce((n,r)=>n+Buffer.byteLength(JSON.stringify(r)),0)<=16*1024*1024);
 const first=[...f.owner.roots.values()][0],before=JSON.stringify(first.cursors);
 assert.throws(()=>f.call('cursor',{cut:first.handle,query:base,pageSize:100,position:{at:99,id:'\0'.repeat(8192),shard:0}}),error('capacity'));
 assert.equal(JSON.stringify(f.owner.roots.get(first.operation).cursors),before);
});
test('JSON member order cannot evade binding quotas or same-content finalization',t=>{
 const f=fixture(t),b=binding(),reverse={authority:b.authority,session:b.session,actor:b.actor};
 const a=f.open('export');f.open('export',reverse);assert.throws(()=>f.open('export'),error('capacity'));
 const c=captured(),reordered={vector:c.vector,capturedBetween:{to:3,from:2},effectiveFrom:1};
 assert.equal(f.call('finalize',{operation:a.operation,capture:reordered},reverse).cut,a.cut);
});
test('typed session/key refinements and shard source pins reject reinterpretation',t=>{
 const f=fixture(t),q={...base,filters:{key:{kind:'credential',id:'credential'}}},a=f.open('browse',binding(),captured(),q);
 assert.ok(f.read(a.cut,binding(),{...q,filters:{key:{id:'credential',kind:'credential'}}}));
 assert.throws(()=>f.read(a.cut,binding(),{...q,filters:{key:{kind:'session'}}}),error('restart'));
 for(const field of ['source','normalizer','seq']){const pending=f.reserve('export'),c=captured();c.vector[0].cut[field]=field==='source'?'other':field==='normalizer'?1:-1;
 assert.throws(()=>f.call('finalize',{operation:pending.operation,capture:c}),error('invalid'));assert.throws(()=>f.call('observe',{operation:pending.operation}),error('restart'))}
});
test('ready original deadline survives intervening pending expiry after rollback',t=>{
 const f=fixture(t),ready=f.open('export');
 t.mock.timers.tick(100000);t.mock.method(Date,'now',()=>0);
 f.reserve();t.mock.timers.tick(20000);assert.equal(f.owner.roots.size,1);
 t.mock.timers.tick(779999);assert.ok(f.read(ready.cut));
 t.mock.timers.tick(1);assert.equal(f.owner.roots.size,0);
 assert.throws(()=>f.read(ready.cut),error('restart'));
});
test('pending original deadline survives earlier reservation release after rollback',t=>{
 const f=fixture(t),early=f.reserve();t.mock.timers.tick(5000);
 const later=f.reserve('browse',binding(2));t.mock.timers.tick(5000);t.mock.method(Date,'now',()=>0);
 f.call('release',{operation:early.operation});
 t.mock.timers.tick(14999);assert.equal(f.call('observe',{operation:later.operation},binding(2)).state,'pending');
 t.mock.timers.tick(1);assert.equal(f.owner.roots.size,0);
 assert.throws(()=>f.call('observe',{operation:later.operation},binding(2)),error('restart'));
});
for(const rollback of [false,true])test('original deadlines survive lifecycle churn'+(rollback?' with rollback':' with advancing clock'),t=>{
 const f=fixture(t),first=f.open('export');t.mock.timers.tick(100000);
 if(rollback)t.mock.method(Date,'now',()=>0);
 const pending=f.reserve('export',binding(3));t.mock.timers.tick(1000);
 const later=f.call('finalize',{operation:pending.operation,capture:captured()},binding(3));
 assert.equal(f.call('observe',{operation:pending.operation},binding(3)).cut,later.cut);
 assert.equal(f.call('finalize',{operation:pending.operation,capture:captured()},binding(3)).cut,later.cut);
 const released=f.reserve();f.call('release',{operation:released.operation});
 const failed=f.reserve();assert.throws(()=>f.call('finalize',{operation:failed.operation,capture:captured(65)}),error('capacity'));
 const changed=f.reserve();assert.throws(()=>f.call('observe',{operation:changed.operation},binding(),'b'.repeat(32)),error('restart'));
 const displaced=f.open('browse',binding(2)),survivor=f.open('browse',binding(2)),replacement=f.open('browse',binding(2));
 assert.throws(()=>f.read(displaced.cut,binding(2)),error('restart'));
 const cursor=f.call('cursor',{cut:later.cut,query:base,pageSize:25,position:{at:99,id:'event',shard:0}},binding(3));
 assert.equal(f.call('cursor',{cut:later.cut,query:base,pageSize:25,...cursor},binding(3)).id,'event');
 // The finalized root survives its original pending deadline without moving its TTL.
 t.mock.timers.tick(19000);assert.ok(f.read(later.cut,binding(3)));
 t.mock.timers.tick(779999);assert.ok(f.read(first.cut));t.mock.timers.tick(1);
 assert.throws(()=>f.read(first.cut),error('restart'));assert.ok(f.read(later.cut,binding(3)));
 assert.ok(f.read(survivor.cut,binding(2)));assert.ok(f.read(replacement.cut,binding(2)));
 t.mock.timers.tick(99999);assert.ok(f.read(later.cut,binding(3)));t.mock.timers.tick(1);
 assert.throws(()=>f.read(later.cut,binding(3)),error('restart'));
 assert.ok(f.read(survivor.cut,binding(2)));t.mock.timers.tick(1000);
 assert.equal(f.owner.roots.size,0);
});
test('backward clock plus repeated observes cannot postpone the pending timer',t=>{
 const f=fixture(t),p=f.reserve();t.mock.method(Date,'now',()=>0);
 // Change wall time without rewinding the mock timer scheduler itself.
 for(let i=0;i<19;i++){t.mock.timers.tick(1000);assert.equal(f.call('observe',{operation:p.operation}).state,'pending')}
 t.mock.timers.tick(1000);assert.equal(f.owner.roots.size,0);
});
