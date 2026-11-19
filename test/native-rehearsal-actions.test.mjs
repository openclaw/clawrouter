import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {setTimeout as sleep} from 'node:timers/promises';
import {exerciseActions} from '../scripts/native-rehearsal-actions.mjs';
const ids={blue:'blue',green:'green',recovery:'recovery'};
const deferred=()=>{let resolve,reject;const done=new Promise((a,b)=>{resolve=a;reject=b;});done.catch(()=>{});return {done,resolve,reject};};
for(const direction of ['forward','recovery'])for(const termination of ['resolve','reject'])test('client '+direction+' '+termination+' before checkpoint stops progression',async()=>{
 const forward=deferred(),recovery=deferred(),workflow=deferred();let dispatches=0;
 const task=exerciseActions({ids,launch:async label=>label==='FORWARD-CLIENT'?forward:recovery,held:async d=>{if(d===direction){queueMicrotask(()=> (d==='forward'?forward:recovery)[termination](Error('controlled client failure')));return new Promise(()=>{});}return {};},dispatch:async()=>{dispatches++;forward.resolve();return {id:123,done:workflow.done};},greenReady:async()=>{},save:async()=>{}});
 await assert.rejects(task,/controlled client failure|ended before held checkpoint/);assert.equal(dispatches,direction==='forward'?0:1);
});
test('successful forward and recovery each keep one ordered dispatch',async()=>{
 const forward=deferred(),recovery=deferred(),workflow=deferred(),events=[];
 const run=await exerciseActions({ids,launch:async label=>{events.push(label);return label==='FORWARD-CLIENT'?forward:recovery;},held:async direction=>{events.push('held:'+direction);return {};},save:async name=>events.push(name),dispatch:async()=>{events.push('dispatch');forward.resolve();return{id:123,done:workflow.done};},greenReady:async()=>{events.push('green-ready');setTimeout(()=>{recovery.resolve();workflow.resolve();},10);}});
 assert.equal(run,123);assert.equal(events.filter(x=>x==='dispatch').length,1);assert(events.indexOf('dispatch')>events.indexOf('FORWARD-HELD.json'));
});
test('workflow failure stops progression before recovery client',async()=>{
 const forward=deferred(),workflow=deferred();let recovery=false;
 const task=exerciseActions({ids,launch:async label=>{recovery||=label==='RECOVERY-CLIENT';return forward;},held:async()=>({}),save:async()=>{},dispatch:async()=>{queueMicrotask(()=>workflow.reject(Error('controlled workflow failure')));return{id:123,done:workflow.done};},greenReady:async()=>{}});
 await assert.rejects(task,/controlled workflow failure/);assert.equal(recovery,false);
});

test('real child exit aborts the held checkpoint wait without dispatch',{timeout:5000},async t=>{
 const child=spawn(process.execPath,['-e','process.exit(1)'],{stdio:'ignore'}),stop=new AbortController();
 const done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(Error('controlled child exit')));});done.catch(()=>{});
 t.after(()=>{stop.abort();child.kill();});let dispatches=0,observerStopped=false;
 const held=async()=>{try{await sleep(10000,undefined,{signal:stop.signal});}finally{observerStopped=true;}};
 try{await assert.rejects(exerciseActions({ids,launch:async()=>({done}),held,dispatch:async()=>{dispatches++;throw Error('must not dispatch');},greenReady:async()=>{},save:async()=>{}}),/controlled child exit/);}
 finally{stop.abort();}
 await new Promise(resolve=>setImmediate(resolve));assert.equal(dispatches,0);assert.equal(observerStopped,true);
 t.diagnostic(JSON.stringify({actualChild:true,dispatches,observerStopped,limits:'Local subprocess and checkpoint observer; no hosted workflow or Cloudflare calls'}));
});
