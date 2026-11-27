import test from 'node:test';
import assert from 'node:assert/strict';
import {EpochController,epochDrainMs} from '../worker/large-http/epoch.ts';
import {NativeSlot} from '../worker/large-http/native-slot.ts';
const fingerprint='a'.repeat(64),boot=i=>'00000000-0000-4000-8000-'+String(i).padStart(12,'0');
const id=i=>'prf_'+i.toString(16).padStart(32,'0'),tenant=i=>i.toString(16).padStart(64,'0');
function memory(initial){let state=initial,tail=Promise.resolve();return {get value(){return structuredClone(state);},set value(v){state=structuredClone(v);},update(fn){const p=tail.then(()=>{const result=fn(structuredClone(state));state=structuredClone(result.state);return structuredClone(result.value);});tail=p.catch(()=>{});return p;}};}
function fixture(){let now=1000;const store=memory(),effects=[],c={fingerprint,epochMs:60000,enabled:true,deadline:1e12,startWindowMs:3600000,startsPerWindow:3};
 const ports={prepare:async(slot,generation)=>{effects.push(['start',slot,generation]);return {phase:'ready',generation,boot:boot(slot+generation*8)};},status:async(slot,generation)=>({phase:'ready',generation,boot:boot(slot+generation*8)}),retire:async(slot,generation)=>{effects.push(['destroy',slot,generation]);return {phase:'stopped',generation,absent:true};}};
 return {store,c,ports,effects,epoch:new EpochController(store,ports,()=>c,()=>now),advance(ms){now+=ms;},get now(){return now;}};
}
async function state(f){return (await f.epoch.command('snapshot',{})).state;}
async function offer(f,n,t=n){return f.epoch.command('admit',{generation:(await state(f)).generation,id:id(n),tenant:tenant(t)});}
async function warm(f){for(let n=0;n<8;n++)await f.epoch.tick();}
async function rotate(f){f.advance(60001);await f.epoch.tick();f.advance(1000);await warm(f);}
test('disabled controller has no native effects; enable starts exactly eight slots',async()=>{
 const f=fixture();f.c.enabled=false;await f.epoch.tick();assert.equal(f.effects.length,0);assert.equal((await offer(f,1)).status,503);
 f.c.enabled=true;await warm(f);assert.equal((await state(f)).phase,'serving');assert.equal(f.effects.length,8);
});
test('multiple epochs clear bounded history only after every destruction acknowledgement',async()=>{
 const f=fixture();await warm(f);const grant=(await offer(f,1)).grant;assert.equal(grant.generation,1);
 await f.epoch.command('claim',grant);await f.epoch.command('dispatch',grant);await f.epoch.command('finish',{...grant,clean:true});
 let held=true;f.ports.retire=async(slot,generation)=>({generation,phase:slot===7&&held?'blocked':'stopped',absent:true});
 f.advance(60001);await f.epoch.tick();assert.equal((await state(f)).phase,'stopping');assert.equal((await state(f)).pool.issued,1);
 await f.epoch.tick();assert.equal(f.effects.filter(x=>x[0]==='start').length,8);held=false;await f.epoch.tick();
 assert.equal((await state(f)).pool.issued,0);f.advance(1000);await warm(f);assert.equal((await state(f)).generation,2);
 for(const op of ['claim','dispatch','finish'])assert.equal((await f.epoch.command(op,grant)).status,409);
 assert.equal((await f.epoch.command('admit',{generation:1,id:id(2),tenant:tenant(2)})).status,409);
});
test('draining preserves a claimed owner for settlement but admits no new work',async()=>{
 const f=fixture();await warm(f);const g=(await offer(f,1)).grant;await f.epoch.command('claim',g);
 f.advance(60001);await f.epoch.tick();assert.equal((await state(f)).phase,'draining');assert.equal((await offer(f,2)).status,503);
 assert.equal((await f.epoch.command('dispatch',g)).status,200);assert.equal((await f.epoch.command('finish',{...g,clean:true})).status,200);
 await f.epoch.tick();assert.equal((await state(f)).phase,'cooldown');
});
test('uncertain inference remains held through drain and is never replayed',async()=>{
 const f=fixture();await warm(f);const g=(await offer(f,1)).grant;await f.epoch.command('claim',g);await f.epoch.command('dispatch',g);
 await f.epoch.command('finish',{...g,clean:false});assert.equal((await state(f)).phase,'draining');
 await f.epoch.tick();assert.equal((await state(f)).pool.grants.length,1);assert.equal(f.effects.length,8);
 f.advance(epochDrainMs);await f.epoch.tick();assert.equal((await state(f)).phase,'cooldown');assert.equal(f.effects.length,16);
 f.advance(1000);await warm(f);assert.equal((await state(f)).generation,2);assert.equal((await f.epoch.command('dispatch',g)).status,409);
});
test('durable startup rate budget survives controller reconstruction',async()=>{
 const f=fixture();await warm(f);await rotate(f);await rotate(f);assert.equal((await state(f)).generation,3);
 await rotate(f);assert.equal((await state(f)).phase,'cooldown');assert.equal(f.effects.filter(x=>x[0]==='start').length,24);
 f.epoch=new EpochController(f.store,f.ports,()=>f.c,()=>f.now);f.advance(3600000);await warm(f);assert.equal((await state(f)).generation,4);
});
test('per-slot admission bound rotates; capacity refusals do not consume durable history',async()=>{
 const f=fixture();await warm(f);
 const g1=(await offer(f,1000,1)).grant,g2=(await offer(f,1001,1)).grant;
 assert.equal((await offer(f,1002,1)).status,429);assert.equal((await state(f)).pool.issued,2);
 for(const g of [g1,g2]){await f.epoch.command('claim',g);await f.epoch.command('finish',{...g,clean:true});}
 for(let n=0;n<503;n++){const g=(await offer(f,n+1)).grant;assert.ok(g);await f.epoch.command('claim',g);await f.epoch.command('finish',{...g,clean:true});}
 assert.equal(Math.max(...(await state(f)).counts),64);assert.equal((await offer(f,2000)).status,503);assert.equal((await state(f)).phase,'draining');
});
test('configuration drift and disable drain before adopting a new generation',async()=>{
 const f=fixture();await warm(f);f.c.fingerprint='b'.repeat(64);await f.epoch.tick();assert.equal((await state(f)).phase,'cooldown');
 f.advance(1000);await warm(f);assert.equal((await state(f)).fingerprint,f.c.fingerprint);f.c.enabled=false;await f.epoch.tick();assert.equal((await state(f)).phase,'closed');assert.equal((await offer(f,1)).status,503);
});
test('native I/O does not hold epoch admission or settlement transaction lock',async()=>{
 const f=fixture();await warm(f);const g=(await offer(f,1)).grant;await f.epoch.command('claim',g);
 const releases=[];f.ports.status=(slot,generation)=>new Promise(r=>{releases.push(()=>r({phase:'ready',generation,boot:boot(slot+generation*8)}));});const tick=f.epoch.tick();await new Promise(r=>setTimeout(r,5));
 assert.equal((await f.epoch.command('finish',{...g,clean:true})).status,200);
 assert.equal(releases.length,8);for(const release of releases)release();await tick;
});
function nativeFixture(){let now=1000,present=false,generation=0;const store=memory(),starts=[],destroyed=[],monitors=[];
 const ports={absent:async()=>!present,start(g){generation=g;present=true;starts.push(g);},keepalive:async()=>{},ready:async()=>present?boot(generation):null,monitor:()=>new Promise((resolve,reject)=>monitors.push({resolve,reject})),destroy:async()=>{destroyed.push(generation);present=false;}};
 const c={fingerprint,enabled:true,deadline:1e12};return {store,ports,c,starts,destroyed,monitors,slot:new NativeSlot(store,ports,()=>c,()=>now),advance(ms){now+=ms;},get now(){return now;}};
}
test('native start is issued once per generation and stale callbacks cannot poison replacement',async()=>{
 const f=nativeFixture();assert.equal((await f.slot.prepare(1)).phase,'ready');await f.slot.prepare(1);assert.deepEqual(f.starts,[1]);
 assert.equal((await f.slot.retire(1)).phase,'stopped');assert.equal((await f.slot.prepare(2)).phase,'ready');f.monitors[0].reject(Error('late'));await new Promise(r=>setTimeout(r,1));assert.equal((await f.slot.state()).phase,'ready');assert.deepEqual(f.starts,[1,2]);
});
test('native reconstruction never repeats a start, but acknowledged destruction permits a new generation',async()=>{
 const f=nativeFixture();await f.slot.prepare(1);f.slot=new NativeSlot(f.store,f.ports,()=>f.c,()=>f.now);
 assert.equal((await f.slot.prepare(1)).phase,'failed');assert.deepEqual(f.starts,[1]);await f.slot.retire(1);
 f.slot=new NativeSlot(f.store,f.ports,()=>f.c,()=>f.now);assert.equal((await f.slot.prepare(2)).phase,'ready');
});
test('lost destruction acknowledgement blocks reuse even with native absence',async()=>{
 const f=nativeFixture();await f.slot.prepare(1);f.ports.destroy=async()=>{throw Error('lost acknowledgement');};
 assert.equal((await f.slot.retire(1)).phase,'blocked');f.ports.absent=async()=>true;
 assert.equal((await f.slot.prepare(2)).phase,'blocked');assert.deepEqual(f.starts,[1]);
});
test('unresolved destruction cannot be retried after reconstruction',async()=>{
 const f=nativeFixture();await f.slot.prepare(1);let done;f.ports.destroy=()=>new Promise(r=>{done=r;});const p=f.slot.retire(1);await new Promise(r=>setTimeout(r,1));
 f.slot=new NativeSlot(f.store,f.ports,()=>f.c,()=>f.now);assert.equal((await f.slot.retire(1)).phase,'blocked');await f.slot.prepare(2);assert.deepEqual(f.starts,[1]);done();await p;assert.equal((await f.slot.state()).phase,'blocked');
});
test('failed native start is spent and can recover only in a new retired generation',async()=>{
 const f=nativeFixture();f.ports.start=g=>{f.starts.push(g);throw Error('engine');};
 assert.equal((await f.slot.prepare(1)).phase,'failed');await f.slot.prepare(1);assert.deepEqual(f.starts,[1]);await f.slot.retire(1);await f.slot.prepare(2);assert.deepEqual(f.starts,[1,2]);
});
test('corrupt journals fail closed before native operations',async()=>{
 const f=nativeFixture();f.store.value={schema:1,generation:1,phase:'ready'};await assert.rejects(f.slot.prepare(2),/journal_invalid/);assert.deepEqual(f.starts,[]);
 const e=fixture();e.store.value={schema:1,generation:1};await assert.rejects(e.epoch.tick(),/journal_invalid/);assert.deepEqual(e.effects,[]);
});

test('pending native keepalive is observed without duplicate issuance or premature readiness',async()=>{
 const f=nativeFixture();let acknowledge,calls=0;f.ports.keepalive=()=>{calls++;return new Promise(r=>{acknowledge=r;});};
 assert.equal((await f.slot.prepare(1)).phase,'starting');
 for(let n=0;n<8;n++)assert.equal((await f.slot.prepare(1)).phase,'starting');
 assert.equal(calls,1);assert.deepEqual(f.starts,[1]);acknowledge();await Promise.resolve();
 assert.equal((await f.slot.status(1)).phase,'ready');assert.equal(calls,1);
});
test('ready incarnation uses native monitor rather than repeated event-loop health probes',async()=>{
 const f=nativeFixture();let calls=0;const ready=f.ports.ready;f.ports.ready=async()=>{calls++;return ready();};
 const first=await f.slot.prepare(1);assert.equal(first.phase,'ready');assert.equal(calls,1);
 f.ports.ready=async()=>{throw Error('health_deadline');};
 for(let n=0;n<4;n++)assert.equal((await f.slot.status(1)).phase,'ready');
 assert.equal(await f.slot.accept(1,first.boot,id(1)),true);f.monitors[0].reject(Error('native exit'));await new Promise(r=>setTimeout(r,1));
 assert.equal((await f.slot.status(1)).phase,'failed');assert.equal(await f.slot.accept(1,first.boot,id(2)),false);assert.deepEqual(f.starts,[1]);
});
test('startup health deadline still fails closed without repeating a native start',async()=>{
 const f=nativeFixture();f.ports.ready=async()=>{throw Error('health_deadline');};assert.equal((await f.slot.prepare(1)).phase,'failed');assert.equal((await f.slot.state()).reason,'readiness_health_deadline');await f.slot.prepare(1);assert.deepEqual(f.starts,[1]);
});
test('retirement cannot overtake an unresolved pre-start absence check',async()=>{
 const f=nativeFixture();let resolve;f.ports.absent=()=>new Promise(r=>{resolve=r;});
 const pending=f.slot.prepare(1);await new Promise(r=>setTimeout(r,1));
 assert.equal((await f.slot.retire(1)).phase,'starting');assert.equal(f.destroyed.length,0);
 resolve(true);await pending;f.ports.absent=async()=>true;await f.slot.retire(1);assert.deepEqual(f.starts,[1]);assert.equal(f.destroyed.length,1);
});

for(const reason of ['disabled','deadline'])test('exhausted startup cooldown closes on '+reason,async()=>{
 const f=fixture();await warm(f);await rotate(f);await rotate(f);await rotate(f);assert.equal((await state(f)).phase,'cooldown');
 if(reason==='disabled')f.c.enabled=false;else f.c.deadline=f.now;
 await f.epoch.tick();assert.equal((await state(f)).phase,'closed');
 const count=f.effects.length;f.advance(3600000);await f.epoch.tick();assert.equal(f.effects.length,count);
});

test('cold starts are staggered to one new slot per alarm, never on admission',async()=>{
 const f=fixture();await f.epoch.tick();assert.equal(f.effects.filter(x=>x[0]==='start').length,1);
 for(let n=2;n<=8;n++){await f.epoch.tick();assert.equal(f.effects.filter(x=>x[0]==='start').length,n);}
 assert.equal((await state(f)).phase,'serving');
});

import {runtimeConfig} from '../worker/large-http/config.ts';
test('control-token rotation changes the epoch fingerprint without exposing the token',async()=>{
 const e={LARGE_HTTP_ORIGIN:'https://canary.example.invalid',LARGE_HTTP_IMAGE:'cloudflare/debian-trixie',LARGE_HTTP_RUNTIME_SHA:'a'.repeat(64),LARGE_HTTP_RUNTIME_BYTES:'1000',LARGE_HTTP_TOKEN:'b'.repeat(64),LARGE_HTTP_DEADLINE:'2000000000000'};
 const a=await runtimeConfig(e),b=await runtimeConfig({...e,LARGE_HTTP_TOKEN:'c'.repeat(64)});assert.notEqual(a.fingerprint,b.fingerprint);assert.equal(a.enabled,true);assert.equal(a.epochMs,3600000);assert.equal(Object.hasOwn(a,'controlToken'),false);
});
