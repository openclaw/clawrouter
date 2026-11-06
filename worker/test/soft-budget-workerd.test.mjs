import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWorkerdFixture } from '../../test/helpers/workerd.mjs';

// First qualify the unchanged producer. This is not a substituted JSON body or
// proof of the later public-provider observation/retirement composition.
const router = String.raw`
export {PolicyBindingIndexObject,BudgetLedgerObject,UsageLedgerObject,GrantCredentialObject} from './worker/index.ts';
import worker from './worker/index.ts';
export default {async fetch(request,env){
 if(new URL(request.url).pathname!=='/producer')return new Response(null,{status:404});
 const stub=env.BUDGET_LEDGER.get(env.BUDGET_LEDGER.idFromName('fixture-soft-status'));
 const policyId='fixture-soft',windowKey=new Date().toISOString().slice(0,7),scopeKey='fixture-scope';
 const charge=await stub.fetch('https://clawrouter.internal/charge',{method:'POST',body:JSON.stringify({
  chargeId:'fixture-charge',policyId,windowKey,scopeKey,amountMicros:17,capability:'llm.chat'})});
 if(!charge.ok)throw Error('real charge failed');
 const receipt=await charge.json();if(receipt.charged!==true||receipt.chargeId!=='fixture-charge')throw Error('real charge receipt');
 const url=new URL('https://clawrouter.internal/status');
 for(const [key,value]of Object.entries({policy_id:policyId,window_key:windowKey,scope_key:scopeKey,limit_micros:'100'}))url.searchParams.set(key,value);
 const response=await stub.fetch(url),body=response.body;
 if(!body)throw Error('real status has no body');
 let reader;
 try{reader=body.getReader({mode:'byob'});}catch{
  await body.cancel();return Response.json({byob:false,status:response.status,unlocked:!body.locked});
 }
 let backing=new Uint8Array(16384),reads=0,bytes=0,maxBacking=0,text='',eof=false,cancels=0,unlocks=0;
 const decoder=new TextDecoder('utf-8',{fatal:true});
 try{
  for(;;){
   if(reads===8192)throw Error('real status read limit');reads++;
   const part=await reader.read(backing),value=part.value;
   if(value){
    maxBacking=Math.max(maxBacking,value.buffer.byteLength);
    if(value.buffer.byteLength>16384||value.byteLength>16384-bytes)throw Error('real status byte limit');
    bytes+=value.byteLength;text+=decoder.decode(value,{stream:true});
    if(value.buffer.byteLength)backing=new Uint8Array(value.buffer);
   }
   if(part.done){eof=true;text+=decoder.decode();break;}
  }
 }finally{try{if(!eof){cancels++;await reader.cancel();}}finally{reader.releaseLock();unlocks++;}}
 return Response.json({byob:true,status:response.status,reads,bytes,maxBacking,eof,cancels,unlocks,
  sameBody:response.body===body,unlocked:!body.locked,value:JSON.parse(text),windowKey});
},queue:worker.queue};`;

test('actual SQLite BudgetLedger status exposes its original bounded BYOB body and charged spent', { timeout: 30_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'soft-status-workerd-'));
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
    if (failures.length) throw new AggregateError(failures, 'status producer fixture cleanup');
  });
  try {
    runtime = await startWorkerdFixture(directory, router,
      `export default {fetch(){throw Error('producer proof forbids external fetch');}};`, { preventEviction: true });
    pending = runtime.dispatchFetch('https://router.example/producer', { signal: abort.signal }).then(async response => {
      assert.equal(response.status, 200, await response.clone().text());
      return response.json();
    });
    const result = await pending;
    assert.equal(result.byob, true, 'unchanged real BudgetLedger DO status must support BYOB');
    assert.equal(result.status, 200); assert.equal(result.eof, true);
    assert.equal(result.sameBody, true); assert.equal(result.unlocked, true);
    assert.equal(result.cancels, 0); assert.equal(result.unlocks, 1);
    assert.ok(result.reads >= 2 && result.reads <= 8192);
    assert.ok(result.bytes > 0 && result.bytes <= 16384);
    assert.ok(result.maxBacking > 0 && result.maxBacking <= 16384);
    assert.deepEqual(result.value, { policyId: 'fixture-soft', windowKey: result.windowKey,
      limitMicros: 100, spentMicros: 17, remainingMicros: 83 });
  } catch (error) { primary = error; throw error; }
});
