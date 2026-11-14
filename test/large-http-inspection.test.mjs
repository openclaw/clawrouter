import test from 'node:test';
import assert from 'node:assert/strict';
import {startupInspection} from '../worker/large-http/inspection.ts';
import {NativeSlot} from '../worker/large-http/native-slot.ts';
const boot='00000000-0000-4000-8000-000000000001';
function fixture(){
 let value,now=1000,calls=0,release,fail,starts=0;
 const inspect=startupInspection(()=>{calls++;return new Promise((r,j)=>{release=r;fail=j;});});
 const store={async update(fn){const r=fn(value);value=r.state;return r.value;}};
 const slot=new NativeSlot(store,{absent:async()=>true,start(){starts++;},keepalive:async()=>{},monitor:()=>new Promise(()=>{}),destroy:async()=>{},ready:async()=>{const r=inspect();return r.kind==='pending'?null:r.value;}},()=>({fingerprint:'a'.repeat(64),enabled:true,deadline:100000}),()=>now);
 return {slot,release:v=>release(v),fail:e=>fail(e),advance:ms=>{now+=ms;},get calls(){return calls;},get starts(){return starts;}};
}
test('inspection queued behind start stays pending without duplicate reads or starts',async()=>{
 const f=fixture();assert.equal((await f.slot.prepare(1)).phase,'starting');f.advance(5000);
 for(let n=0;n<8;n++)assert.equal((await f.slot.status(1)).phase,'starting');
 assert.equal(f.calls,1);assert.equal(f.starts,1);f.release(boot);await Promise.resolve();
 assert.equal((await f.slot.status(1)).phase,'ready');assert.equal(f.calls,1);
});
test('unresolved inspection cannot outlive startup deadline or grant late readiness',async()=>{
 const f=fixture();await f.slot.prepare(1);f.advance(30000);assert.equal((await f.slot.status(1)).phase,'failed');
 assert.equal((await f.slot.state()).reason,'readiness_startup_expired');f.release(boot);await Promise.resolve();assert.equal((await f.slot.status(1)).phase,'failed');assert.equal(f.calls,1);assert.equal(f.starts,1);
});
test('settled inspection rejection remains terminal',async()=>{
 const f=fixture();await f.slot.prepare(1);f.fail(Error('native_identity'));await Promise.resolve();assert.equal((await f.slot.status(1)).phase,'failed');assert.equal((await f.slot.state()).reason,'readiness_native_identity');assert.equal(f.calls,1);
});
test('settled absence permits a later read without overlapping observations',async()=>{
 const f=fixture();await f.slot.prepare(1);f.release(null);await Promise.resolve();assert.equal((await f.slot.status(1)).phase,'starting');assert.equal((await f.slot.status(1)).phase,'starting');assert.equal(f.calls,2);
});
