import test from 'node:test';
import assert from 'node:assert/strict';
import {ContinuousController} from '../worker/large-http/continuous.ts';
const id=n=>'prf_'+n.toString(16).padStart(32,'0'),tenant=n=>n.toString(16).padStart(64,'0'),boot=(i,g)=>`00000000-0000-4000-8000-${String(i+g*8).padStart(12,'0')}`;
function fixture(){let state,now=1000;const effects=[],c={capacity:8,tenantLimit:2,slotStartsPerHour:24,fingerprint:'a'.repeat(64),enabled:true,deadline:Number.MAX_SAFE_INTEGER,epochMs:3600000,startWindowMs:3600000,startsPerWindow:3};
 const store={async update(fn){const r=fn(structuredClone(state));state=structuredClone(r.state);return structuredClone(r.value);}};
 const ports={async prepare(i,g){effects.push(['start',i,g]);return {phase:'ready',generation:g,boot:boot(i,g)};},async status(i,g){return {phase:'ready',generation:g,boot:boot(i,g)};},async retire(i,g){effects.push(['destroy',i,g]);return {phase:'stopped',generation:g,absent:true};}};
 return {store,c,ports,effects,get state(){return state;},controller:new ContinuousController(store,ports,()=>c,()=>now),advance(n){now+=n;},get now(){return now;}};
}
async function warm(f){for(let i=0;i<8;i++)await f.controller.tick();}
async function offer(f,n,t=n){return f.controller.command('admit',{id:id(n),tenant:tenant(t)});}
async function finish(f,g,clean=true){assert.equal((await f.controller.command('claim',g)).status,200);assert.equal((await f.controller.command('dispatch',g)).status,200);assert.equal((await f.controller.command('finish',{...g,clean})).status,200);}
test('ordinary default is continuous across individual age rotations, with seven other members available',async()=>{
 const f=fixture();await warm(f);assert.equal(f.effects.length,8);f.advance(3600001);await f.controller.tick();
 assert.equal(f.state.slots.filter(s=>s.phase==='idle').length,1);assert.equal(f.state.slots.filter(s=>s.phase==='ready').length,7);
 const g=(await offer(f,1)).grant;assert.ok(g);await finish(f,g);f.advance(1001);await f.controller.tick();assert.equal(f.state.slots[0].generation,2);
 assert.equal(f.effects.filter(e=>e[0]==='start').length,9);
});
test('uncertain inference quarantines only its exact slot, never replays, then compacts after destruction',async()=>{
 const f=fixture();await warm(f);const g=(await offer(f,1)).grant;await finish(f,g,false);await f.controller.tick();
 assert.equal(f.state.slots[g.slot].phase,'draining');assert.equal(f.state.pool.grants.length,1);
 const next=(await offer(f,2)).grant;assert.ok(next);assert.notEqual(next.slot,g.slot);await finish(f,next);
 assert.equal(f.effects.length,8);f.advance(460001);await f.controller.tick();assert.equal(f.state.pool.seen[g.id],undefined);
 f.advance(1001);await f.controller.tick();for(const op of ['claim','dispatch','finish'])assert.equal((await f.controller.command(op,g)).status,409);
 assert.equal(f.state.slots[g.slot].generation,2);assert.equal(f.state.pool.fence,2);
});
test('admission stop drains an existing owner; resume starts only retired generations',async()=>{
 const f=fixture();await warm(f);const g=(await offer(f,1)).grant;
 await f.controller.command('admission',{accepting:false});assert.equal((await offer(f,2)).status,503);await f.controller.tick();
 assert.equal((await f.controller.command('claim',g)).status,200);assert.equal((await f.controller.command('dispatch',g)).status,200);assert.equal((await f.controller.command('finish',{...g,clean:true})).status,200);
 await f.controller.tick();assert.equal(f.state.pool.grants.length,0);const count=f.effects.length;await f.controller.tick();assert.equal(f.effects.length,count);
 await f.controller.command('admission',{accepting:true});f.advance(1001);await warm(f);assert.equal((await offer(f,3)).status,200);assert.equal(f.state.slots[0].generation,2);
});
test('tenant quota is configurable and aggregates every key belonging to a tenant',async()=>{
 const f=fixture();f.c.tenantLimit=1;await warm(f);const g=(await offer(f,1,4)).grant;assert.equal((await offer(f,2,4)).status,429);assert.equal((await offer(f,3,5)).status,200);assert.equal(f.state.pool.issued,2);await finish(f,g);
 f.c.tenantLimit=8;for(let n=10;n<16;n++)assert.equal((await offer(f,n,4)).status,200);
});
test('bounded history rotates one full slot, refusals consume no history, stale grants stay fenced',async()=>{
 const f=fixture();f.c.capacity=1;f.c.tenantLimit=1;await warm(f);let last;
 for(let n=1;n<=64;n++){const g=(await offer(f,n)).grant;assert.ok(g);await finish(f,g);last=g;}
 for(let n=65;n<100;n++)assert.equal((await offer(f,n)).status,503);
 assert.equal(f.state.pool.issued,64);await f.controller.tick();assert.equal(f.state.pool.issued,0);f.advance(1001);await f.controller.tick();
 assert.equal((await f.controller.command('dispatch',last)).status,409);assert.equal((await offer(f,100)).status,200);assert.equal(f.state.pool.fence,65);
});
test('lost destruction acknowledgment blocks one slot without compacting or starting it again',async()=>{
 const f=fixture();await warm(f);f.ports.retire=async(i,g)=>({generation:g,phase:i===0?'blocked':'stopped',absent:true});f.advance(3600001);await f.controller.tick();assert.equal(f.state.slots[0].phase,'blocked');
 await f.controller.tick();assert.equal(f.effects.filter(e=>e[0]==='start'&&e[1]===0).length,1);assert.equal((await offer(f,1)).status,200);
});
test('expired claims cannot free a process and startup rate limit survives reconstruction',async()=>{
 const f=fixture();f.c.capacity=1;f.c.tenantLimit=1;f.c.slotStartsPerHour=1;await warm(f);const g=(await offer(f,1)).grant;await f.controller.command('claim',g);f.advance(455001);await f.controller.tick();assert.equal(f.state.slots[0].phase,'draining');
 f.advance(460001);await f.controller.tick();f.advance(1001);f.controller=new ContinuousController(f.store,f.ports,()=>f.c,()=>f.now);await warm(f);assert.equal(f.effects.filter(e=>e[0]==='start').length,1);assert.equal((await offer(f,2)).status,503);
 f.advance(3600000);await f.controller.tick();assert.equal((await offer(f,3)).status,200);
});
test('candidate observations measure real owner lifetime and remain bounded across incarnations',async()=>{
 const f=fixture();f.c.testing=true;f.c.capacity=1;f.c.tenantLimit=1;await warm(f);
 for(let n=1;n<=40;n++){const g=(await offer(f,n)).grant;await f.controller.command('claim',g);f.advance(31);await f.controller.command('dispatch',g);f.advance(19);await f.controller.command('finish',{...g,clean:true});}
 assert.equal(f.state.observations.length,128);const released=f.state.observations.filter(o=>o.kind==='released');assert.ok(released.every(o=>o.holdMs===50));
 assert.ok(f.state.observations.every(o=>o.tenant===tenant(Number.parseInt(o.id.slice(4),16))));
});
test('history headroom retires one member early and keeps the other seven allocatable',async()=>{
 const f=fixture();await warm(f);for(let n=1;n<=384;n++)await finish(f,(await offer(f,n)).grant);
 assert.ok(f.state.slots.every(m=>m.ids.length===48));await f.controller.tick();
 assert.equal(f.state.slots.filter(m=>m.phase==='idle').length,1);assert.equal(f.state.slots.filter(m=>m.phase==='ready').length,7);
 assert.equal(f.state.pool.issued,336);const g=(await offer(f,385)).grant;assert.ok(g);assert.notEqual(g.slot,0);await finish(f,g);
 f.advance(1001);await f.controller.tick();assert.equal(f.state.slots[0].generation,2);assert.equal(f.state.slots[0].ids.length,0);
});
test('early maintenance waits for replacement start credit and preserves capacity-one history',async()=>{
 const f=fixture();f.c.slotStartsPerHour=1;await warm(f);for(let n=1;n<=384;n++)await finish(f,(await offer(f,n)).grant);
 await f.controller.tick();assert.ok(f.state.slots.every(m=>m.phase==='ready'));assert.equal(f.effects.length,8);const {continuousAlarmDelay}=await import('../worker/large-http/continuous.ts');assert.equal(continuousAlarmDelay(f.state,f.c,f.now),5000);
 for(let n=385;n<=512;n++)await finish(f,(await offer(f,n)).grant);assert.equal((await offer(f,513)).status,503);assert.equal(f.state.pool.issued,512);
 await f.controller.tick();assert.equal(f.state.slots.filter(m=>m.phase==='idle').length,1);f.advance(1001);await f.controller.tick();assert.equal(f.effects.filter(e=>e[0]==='start').length,8);
});
test('one exhausted idle member cannot stop healthy history replacement',async()=>{
 const f=fixture();f.c.capacity=3;f.c.tenantLimit=2;f.c.slotStartsPerHour=3;
 const prepare=f.ports.prepare;f.ports.prepare=async(i,g)=>i===0?(f.effects.push(['start',i,g]),{phase:'failed',generation:g}):prepare(i,g);
 for(let n=0;n<20;n++){await f.controller.tick();f.advance(1001);}
 assert.equal(f.state.slots[0].phase,'idle');assert.equal(f.state.slots[0].starts,3);assert.equal(f.state.slots.filter(m=>m.phase==='ready').length,2);
 let stale;for(let n=1;n<=96;n++){stale=(await offer(f,n)).grant;assert.ok(stale);await finish(f,stale);}
 await f.controller.tick();assert.equal(f.state.slots[1].phase,'idle');assert.equal(f.state.slots[2].phase,'ready');assert.equal(f.state.pool.issued,48);
 f.advance(1001);await f.controller.tick();assert.equal(f.state.slots[1].generation,2);assert.equal(f.state.slots[1].phase,'ready');
 await f.controller.tick();assert.equal(f.state.slots[2].phase,'idle');f.advance(1001);await f.controller.tick();assert.equal(f.state.slots[2].generation,2);
 assert.equal(f.state.pool.issued,0);assert.equal(f.effects.filter(e=>e[0]==='start'&&e[1]===0).length,3);
 assert.equal((await f.controller.command('dispatch',stale)).status,409);await finish(f,(await offer(f,97)).grant);
});
test('early retirement retains IDs until matching destruction ACK and observed absence',async()=>{
 const f=fixture();f.c.capacity=2;f.c.tenantLimit=2;await warm(f);let stale;
 for(let n=1;n<=96;n++){stale=(await offer(f,n)).grant;await finish(f,stale);}
 f.ports.retire=async(i,g)=>({generation:g+1,phase:'stopped',absent:true});await f.controller.tick();assert.equal(f.state.pool.issued,96);assert.equal(f.state.slots[0].phase,'stopping');
 f.ports.retire=async(i,g)=>({generation:g,phase:'stopped',absent:false});await f.controller.tick();assert.equal(f.state.pool.issued,96);
 f.ports.retire=async(i,g)=>({generation:g,phase:'stopped',absent:true});await f.controller.tick();assert.equal(f.state.pool.issued,48);
 for(const op of ['claim','dispatch','finish'])assert.equal((await f.controller.command(op,stale)).status,409);
});
test('continuous alarm cadence accelerates enabled maintenance and backs off when start credits are exhausted',async()=>{
 const {continuousAlarmDelay}=await import('../worker/large-http/continuous.ts');const f=fixture();f.c.capacity=2;f.c.tenantLimit=2;await warm(f);
 assert.equal(continuousAlarmDelay(f.state,f.c,f.now),5000);for(let n=1;n<=96;n++)await finish(f,(await offer(f,n)).grant);
 assert.equal(continuousAlarmDelay(f.state,f.c,f.now),1000);await f.controller.tick();assert.equal(continuousAlarmDelay(f.state,f.c,f.now),1000);
 assert.equal(continuousAlarmDelay({...f.state,phase:'closed'},f.c,f.now),60000);assert.equal(continuousAlarmDelay({...f.state,phase:'draining'},f.c,f.now),1000);
});
test('early maintenance drains an active owner before destruction and keeps late completion valid',async()=>{
 const f=fixture();f.c.capacity=2;f.c.tenantLimit=2;await warm(f);for(let n=1;n<=94;n++)await finish(f,(await offer(f,n)).grant);
 const a=(await offer(f,95)).grant;assert.equal(a.slot,0);await f.controller.command('claim',a);await f.controller.command('dispatch',a);
 await finish(f,(await offer(f,96)).grant);await f.controller.tick();assert.equal(f.state.slots[0].phase,'draining');assert.equal(f.effects.filter(e=>e[0]==='destroy').length,0);assert.equal(f.state.pool.issued,96);
 assert.equal((await f.controller.command('finish',{...a,clean:true})).status,200);await f.controller.tick();assert.equal(f.state.slots[0].phase,'idle');assert.equal(f.state.pool.issued,48);
});
