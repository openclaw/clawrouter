import './typescript-setup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {probeUnknown,releaseProbe,probeCharged,probeBudgetBytes,probeBytes,probeReadBytes} from '../large-http/probe.ts';
import {readJson,HttpError,maxMediaJsonBodyBytes} from '../utils.ts';
function request(stream,signal){return new Request('https://router.example/v1/responses',{method:'POST',body:stream,duplex:'half',signal});}
test('small multichunk unknown upload is preserved byte-for-byte on the Worker route',async()=>{
 const parts=[Uint8Array.of(0,1,255),new TextEncoder().encode('é'.repeat(6000))];
 const r=request(new ReadableStream({type:'bytes',start(c){parts.forEach(p=>c.enqueue(new Uint8Array(p)));c.close();}}));
 const probe=await probeUnknown(r);assert.equal(probe.small,true);assert.equal(probe.reason,'probe_eof');assert.equal(probe.request.headers.get('content-length'),null);
 assert.deepEqual(new Uint8Array(await probe.request.arrayBuffer()),Uint8Array.from(parts.flatMap(x=>[...x])));assert.equal(probeCharged(),0);
});
test('oversize source chunk transfers once without a tee or second read',async()=>{
 let pulls=0;const bytes=new Uint8Array(probeBytes+10).fill(37),r=request(new ReadableStream({type:'bytes',pull(c){pulls++;c.enqueue(new Uint8Array(bytes));c.close();}},{highWaterMark:0}));
 const p=await probeUnknown(r);assert.equal(p.small,false);assert.equal(pulls,1);assert.deepEqual(new Uint8Array(await p.request.arrayBuffer()),bytes);assert.equal(probeCharged(),0);
});
test('32 slow small uploads stay on Worker beyond the former cutoff',async()=>{
 const bytes=Uint8Array.of(7,8),ends=[];
 const pending=Array.from({length:32},()=>probeUnknown(request(new ReadableStream({type:'bytes',pull(c){return new Promise(resolve=>ends.push(()=>{c.enqueue(new Uint8Array(bytes));c.close();resolve();}));}},{highWaterMark:0}))));
 await new Promise(r=>setTimeout(r,100));assert.equal(ends.length,32);assert.equal(probeCharged(),32*probeReadBytes);ends.forEach(end=>end());
 const results=await Promise.all(pending);
 for(const p of results){assert.equal(p.small,true);assert.equal(p.reason,'probe_eof');assert.deepEqual([...new Uint8Array(await p.request.arrayBuffer())],[7,8]);}assert.equal(probeCharged(),0);
});
test('aggregate probe buffers are bounded and excess bodies are never pulled',async()=>{
 const results=[];const count=Math.floor(probeBudgetBytes/probeReadBytes);
 for(let i=0;i<count;i++)results.push(await probeUnknown(request(new ReadableStream({type:'bytes',start(c){c.enqueue(Uint8Array.of(1));c.close();}}))));
 assert.equal(probeCharged(),count*probeReadBytes);let overflowPulls=0;const overflow=request(new ReadableStream({type:'bytes',pull(){overflowPulls++;}},{highWaterMark:0}));
 const p=await probeUnknown(overflow);assert.equal(p.reason,'probe_capacity');assert.equal(p.request,overflow);assert.equal(overflowPulls,0);
 for(const p of results)releaseProbe(p.request);assert.equal(probeCharged(),0);await overflow.body.cancel();
});
test('abort releases a pending probe without waiting on hostile cancellation',async()=>{
 const abort=new AbortController();let canceled=0;const r=request(new ReadableStream({type:'bytes',cancel(){canceled++;return new Promise(()=>{});}},{highWaterMark:0}),abort.signal);
 const p=probeUnknown(r);const rejected=assert.rejects(p);abort.abort();await rejected;assert.equal(probeCharged(),0);assert.equal(canceled,1);
});
test('one-byte chunks fill bounded backing buffers without prefix amplification',async()=>{
 let bytes=0;const r=request(new ReadableStream({type:'bytes',pull(c){c.enqueue(Uint8Array.of(bytes++%256));if(bytes===20000)c.close();}},{highWaterMark:0}));
 const p=await probeUnknown(r);assert.equal(p.small,true);assert.equal(probeCharged(),2*probeReadBytes);
 const actual=new Uint8Array(await p.request.arrayBuffer());assert.equal(actual.length,20000);assert.ok(actual.every((v,i)=>v===i%256));assert.equal(probeCharged(),0);
});

test('body handoff preserves generated correlation/session attribution and recovery locator',async()=>{
 const {correlateIngressRequest,correlationMetadata,transferRequestContext,setBackgroundRecovery,withBackgroundRecovery}=await import('../correlation.ts');
 const source=request(new ReadableStream({type:'bytes',start(c){c.enqueue(Uint8Array.of(1));c.close();}}));
 const original=correlateIngressRequest(source),probe=await probeUnknown(source),complete=transferRequestContext(source,probe.request);
 assert.equal(correlationMetadata(probe.request).requestId,original.requestId);setBackgroundRecovery(probe.request,'background/test-locator');complete();
 assert.equal(withBackgroundRecovery(new Response(),source).headers.get('x-clawrouter-background-recovery'),'background/test-locator');await probe.request.body.cancel();assert.equal(probeCharged(),0);
});

test('32 concurrent uploads through the full small-body boundary stay on Worker',async()=>{
 const pending=Array.from({length:32},()=>probeUnknown(request(new ReadableStream({type:'bytes',start(c){c.enqueue(new Uint8Array(probeBytes));c.close();}}))));
 const results=await Promise.all(pending);assert.equal(probeCharged(),32*probeBytes);
 for(const p of results){assert.equal(p.small,true);assert.equal(p.reason,'probe_eof');assert.equal((await p.request.arrayBuffer()).byteLength,probeBytes);}assert.equal(probeCharged(),0);
});

test('canonical prefixes share the exact existing body budget without future-read padding',async()=>{
 const {BodyLease,bodyBudgetBytes,bodyBudgetCharged}=await import('../body-budget.ts');
 const size=16*1024*1024,leases=[],results=[];
 try {
  for(let i=0;i<3;i++){
   const lease=new BodyLease();leases.push(lease);
   const r=request(new ReadableStream({type:'bytes',start(c){c.enqueue(new Uint8Array(size));c.close();}}));
   results.push(await probeUnknown(r,{async reserve(bytes){assert.ok(lease.grow(bytes),'canonical body budget');}}));
  }
  assert.equal(bodyBudgetCharged(),bodyBudgetBytes);assert.equal(probeCharged(),3*size);
  for(const p of results){assert.equal(p.small,true);assert.equal((await p.request.arrayBuffer()).byteLength,size);}
  assert.equal(probeCharged(),0);
 }finally{for(const p of results)releaseProbe(p.request);for(const lease of leases)lease.release();}
 assert.equal(bodyBudgetCharged(),0);
});

for(const cancel of [false,true])test(`native prefix retires its canonical charge before waiting for provider headers: ${cancel?'cancel':'consume'}`,async()=>{
 const {BodyLease,bodyBudgetCharged}=await import('../body-budget.ts');const lease=new BodyLease();let retired=0;
 const size=32_000_001,tail=64*1024;
 const p=await probeUnknown(request(new ReadableStream({type:'bytes',start(c){c.enqueue(new Uint8Array(size+tail));c.close();}})),{async reserve(bytes){assert.ok(lease.grow(bytes));},retirePrefix(){retired++;lease.release();}});
 try{
  assert.equal(p.small,false);assert.equal(bodyBudgetCharged(),2*size);assert.equal(retired,0);
  if(cancel)await p.request.body.cancel();
  else{
   const reader=p.request.body.getReader();let received=0;while(received<size){const n=await reader.read();assert.equal(n.done,false);received+=n.value.byteLength;}
   assert.equal(received,size);assert.equal(bodyBudgetCharged(),0);assert.equal(retired,1);
   let rest=0;for(;;){const n=await reader.read();if(n.done)break;rest+=n.value.byteLength;}assert.equal(rest,tail);reader.releaseLock();
  }
  releaseProbe(p.request);assert.equal(retired,1);assert.equal(probeCharged(),0);assert.equal(bodyBudgetCharged(),0);
 }finally{releaseProbe(p.request);lease.release();}
});

test('ordinary classified bodies retain canonical ownership after raw prefix consumption',async()=>{
 const {BodyLease,bodyBudgetCharged}=await import('../body-budget.ts');const lease=new BodyLease();let retired=0;
 const p=await probeUnknown(request(new ReadableStream({type:'bytes',start(c){c.enqueue(new Uint8Array(1024*1024));c.close();}})),{async reserve(bytes){assert.ok(lease.grow(bytes));},retirePrefix(){retired++;lease.release();}});
 try{assert.equal(p.small,true);await p.request.arrayBuffer();releaseProbe(p.request);assert.equal(retired,0);assert.equal(bodyBudgetCharged(),2*1024*1024);}finally{lease.release();}
 assert.equal(bodyBudgetCharged(),0);
});

for (const size of [1024, 1024*1024, 9*1024*1024]) test(`complete admitted prefix transfers to canonical parsing without stream replay: ${size}`,async()=>{
 const {BodyLease,bodyBudgetCharged}=await import('../body-budget.ts'),lease=new BodyLease();
 let retained,reserves=0,expanded=0;
 const expected={input:'é'.repeat(size)},bytes=new TextEncoder().encode(JSON.stringify(expected)),expectedBytes=bytes.byteLength;
 const intake={async reserve(n){reserves++;assert.ok(lease.grow(n));},async expand(){expanded++;},retainPrefix(r,p){assert.equal(retained,undefined);retained={r,p};},takePrefix(r){if(retained?.r!==r)return;const p=retained.p;retained=undefined;return p;}};
 const input=request(new ReadableStream({type:'bytes',start(c){c.enqueue(bytes);c.close();}}));
 const p=await probeUnknown(input,intake);
 try {
  assert.equal(p.small,true);assert.equal(p.request,input,'complete bodies retain the original Request');
  assert.equal(input.bodyUsed,true,'canonical capability owns the physically consumed bytes');const admitted=reserves;
  // Consuming the transferred owner must never acquire/replay the wrapper stream.
  p.request.body.getReader=()=>assert.fail('classified bytes replayed through a stream');
  assert.deepEqual(await readJson(p.request,undefined,maxMediaJsonBodyBytes,intake),expected);
  assert.equal(reserves,admitted,'the same bytes are admitted only once');
  assert.equal(expanded,size*2>8*1024*1024?1:0);
  assert.equal(intake.takePrefix(p.request),undefined,'ownership transfers once');
  assert.equal(probeCharged(),0);assert.equal(bodyBudgetCharged()>0,expectedBytes>=1024*1024,'canonical parsed body retains its existing charge threshold');
 }finally{releaseProbe(p.request);lease.release();}
 assert.equal(bodyBudgetCharged(),0);
});

for (const value of ['{"incomplete":', '{"tooBig":"'+ 'x'.repeat(1024)+'"}']) test(`transferred prefix preserves parser errors and releases raw bytes: ${value.length}`,async()=>{
 let retained;const intake={async reserve(){},async expand(){},retainPrefix(r,p){retained={r,p};},takePrefix(r){if(retained?.r!==r)return;const p=retained.p;retained=undefined;return p;}};
 const p=await probeUnknown(request(new ReadableStream({type:'bytes',start(c){c.enqueue(new TextEncoder().encode(value));c.close();}})),intake);
 try {await assert.rejects(readJson(p.request,undefined,value.length>100?100:1024,intake),e=>e instanceof HttpError&&e.status===(value.length>100?413:400));assert.equal(probeCharged(),0);}
 finally {releaseProbe(p.request);}
});

test('prefix capability cannot be consumed by a different request',async()=>{
 let retained;const intake={async reserve(){},async expand(){},retainPrefix(r,p){retained={r,p};},takePrefix(r){if(retained?.r!==r)return;const p=retained.p;retained=undefined;return p;}};
 const p=await probeUnknown(request(new ReadableStream({type:'bytes',start(c){c.enqueue(new TextEncoder().encode('{"owner":true}'));c.close();}})),intake);
 try {assert.deepEqual(await readJson(new Request('https://router.example',{method:'POST',body:'{"other":true}'}),undefined,1024,intake),{other:true});assert.ok(retained);assert.deepEqual(await readJson(p.request,undefined,1024,intake),{owner:true});assert.equal(probeCharged(),0);}
 finally {releaseProbe(p.request);}
});

test('expanded transferred prefix preserves structure limits without retaining raw buffers',async()=>{
 let retained;const intake={async reserve(){},async expand(){},retainPrefix(r,p){retained={r,p};},takePrefix(r){if(retained?.r!==r)return;const p=retained.p;retained=undefined;return p;}};
 const bytes=new TextEncoder().encode('{"padding":"'+'x'.repeat(9*1024*1024)+'","nested":'+'['.repeat(130)+'0'+']'.repeat(130)+'}');
 const p=await probeUnknown(request(new ReadableStream({type:'bytes',start(c){c.enqueue(bytes);c.close();}})),intake);
 try{await assert.rejects(readJson(p.request,undefined,maxMediaJsonBodyBytes,intake),e=>e instanceof HttpError&&e.status===413&&e.message.includes('structure limits'));assert.equal(probeCharged(),0);}
 finally{releaseProbe(p.request);}
});

test('transferred prefix releases on an admission failure before parsing',async()=>{
 let retained;const refusal=new Response(null,{status:503});const intake={async reserve(){},async expand(){throw refusal;},retainPrefix(r,p){retained={r,p};},takePrefix(r){if(retained?.r!==r)return;const p=retained.p;retained=undefined;return p;}};
 const bytes=new TextEncoder().encode('"'+'x'.repeat(9*1024*1024)+'"');
 const p=await probeUnknown(request(new ReadableStream({type:'bytes',start(c){c.enqueue(bytes);c.close();}})),intake);
 try{await assert.rejects(readJson(p.request,undefined,maxMediaJsonBodyBytes,intake),e=>e===refusal);assert.equal(probeCharged(),0);}
 finally{releaseProbe(p.request);}
});
