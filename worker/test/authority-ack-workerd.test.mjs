import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWorkerdFixture } from '../../test/helpers/workerd.mjs';

// Qualify the unchanged producer before introducing the bounded ACK consumer.
// Read the original default policy-bindings DO response, without a relay or clone.
const router = String.raw`
export {PolicyBindingIndexObject,BudgetLedgerObject,UsageLedgerObject,GrantCredentialObject} from './worker/index.ts';
import worker from './worker/index.ts';
export default {async fetch(request,env){
 if(new URL(request.url).pathname!=='/producer')return new Response(null,{status:404});
 const stub=env.ACCESS_CONTROL.get(env.ACCESS_CONTROL.idFromName('policy-bindings'));
 const response=await stub.fetch('https://clawrouter.internal/initialize-all',{method:'POST',body:'[]'}),body=response.body;
 if(!body)throw Error('real initialization ACK has no body');
 let reader;
 try{reader=body.getReader({mode:'byob'});}catch{
  await body.cancel();return Response.json({byob:false,status:response.status,unlocked:!body.locked});
 }
 let backing=new Uint8Array(128),reads=0,bytes=0,maxBacking=0,text='',eof=false,cancels=0,unlocks=0;
 const decoder=new TextDecoder();
 try{
  for(;;){
   if(reads===8192)throw Error('real ACK read limit');reads++;
   const part=await reader.read(backing),value=part.value;
   if(value){
    maxBacking=Math.max(maxBacking,value.buffer.byteLength);
    if(value.buffer.byteLength>128||value.byteLength>128-bytes)throw Error('real ACK byte limit');
    bytes+=value.byteLength;text+=decoder.decode(value,{stream:true});
    if(value.buffer.byteLength)backing=new Uint8Array(value.buffer);
   }
   if(part.done){eof=true;text+=decoder.decode();break;}
  }
 }finally{try{if(!eof){cancels++;await reader.cancel();}}finally{reader.releaseLock();unlocks++;}}
 return Response.json({byob:true,status:response.status,reads,bytes,maxBacking,eof,cancels,unlocks,
  sameBody:response.body===body,unlocked:!body.locked,value:text});
},queue:worker.queue};`;

test('actual SQLite policy-bindings initialization exposes its original 128-byte BYOB ACK', { timeout: 30_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'authority-ack-workerd-'));
  let runtime, pending, primary;
  const abort = new AbortController();
  const cancel = () => abort.abort(t.signal.reason);
  t.signal.addEventListener('abort', cancel, { once: true });
  t.after(async () => {
    abort.abort(new Error('fixture cleanup'));
    const failures = [];
    try { if (pending) await pending; } catch (error) { if (error !== primary) failures.push(error); }
    try { if (runtime) await runtime.dispose(); } catch (error) { failures.push(error); }
    try { await rm(directory, { recursive: true, force: true }); } catch (error) { failures.push(error); }
    t.signal.removeEventListener('abort', cancel);
    if (failures.length) throw new AggregateError(failures, 'ACK producer fixture cleanup');
  });
  try {
    runtime = await startWorkerdFixture(directory, router,
      `export default {fetch(){throw Error('producer proof forbids external fetch');}};`, { preventEviction: true });
    pending = runtime.dispatchFetch('https://router.example/producer', { signal: abort.signal }).then(async response => {
      assert.equal(response.status, 200);
      return response.json();
    });
    const result = await pending;
    assert.equal(result.byob, true, 'unchanged PolicyBindingIndexObject initialization ACK must support BYOB');
    assert.equal(result.status, 200); assert.equal(result.eof, true);
    assert.equal(result.sameBody, true); assert.equal(result.unlocked, true);
    assert.equal(result.cancels, 0); assert.equal(result.unlocks, 1);
    assert.ok(result.reads >= 1 && result.reads <= 8192);
    assert.equal(result.bytes, 11); assert.ok(result.maxBacking > 0 && result.maxBacking <= 128);
    assert.equal(result.value, 'initialized');
  } catch (error) { primary = error; throw error; }
});
