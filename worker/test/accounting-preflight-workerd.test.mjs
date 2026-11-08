import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startWorkerdFixture } from "../../test/helpers/workerd.mjs";

const router = String.raw`
import worker,{BudgetLedgerObject as Ledger} from './worker/index.ts';
export {PolicyBindingIndexObject,UsageLedgerObject,GrantCredentialObject} from './worker/index.ts';
import {authorityCall} from './worker/authority.ts';
import {ingestUsage} from './worker/ledgers.ts';
import {accountingArchive} from './worker/json-body.ts';
import {prepareContentRetention} from './worker/content-retention.ts';
const check=(value,message)=>{if(!value)throw Error(message);};
export class BudgetLedgerObject extends Ledger {
 constructor(state){super(state);this.raw=state.storage.sql;}
 async fetch(request){if(new URL(request.url).pathname==='/fixture-sql')return Response.json({reservations:[...this.raw.exec('SELECT reservation_id,reserved_micros,settled FROM budget_reservations')],windows:[...this.raw.exec('SELECT spent_micros FROM budget_windows')]});return super.fetch(request);}
}
const nativeFetch=globalThis.fetch;
export default {async fetch(request,bindings,ctx){
 const mode=new URL(request.url).pathname.slice(1),roots=[];let hasPrimary=false,primary,result;
 const track=work=>{const outcome=Promise.resolve(work).then(value=>({failed:false,value}),error=>({failed:true,error}));roots.push(outcome);return work;};
 try{
 if(mode==='archive'){
  const source=JSON.parse('{"__proto__":{"owned":true},"first":1}');
  Object.assign(source,{data:'x'.repeat(100000),unicode:'\ud800😀\udfff',missing:undefined,array:[undefined,-0,NaN,Infinity]});
  const oracle=JSON.stringify(source),archive=accountingArchive(source),stream=archive.stream(),reader=stream.getReader();
  let bytes=0,maximum=0,text='',eof=false,readFailed=false,readFailure;const decoder=new TextDecoder(),readCleanup=[];
  try{for(;;){const part=await reader.read();if(part.done){eof=true;break;}maximum=Math.max(maximum,part.value.buffer.byteLength);bytes+=part.value.byteLength;text+=decoder.decode(part.value,{stream:true});}text+=decoder.decode();}
  catch(error){readFailed=true;readFailure=error;}
  finally{if(!eof)try{await reader.cancel();}catch(error){readCleanup.push(error);}try{reader.releaseLock();}catch(error){readCleanup.push(error);}}
  if(readCleanup.length)throw new AggregateError(readFailed?[readFailure,...readCleanup]:readCleanup,'original reader cleanup');if(readFailed)throw readFailure;
  check(text===oracle&&maximum<=32768&&!stream.locked&&archive.retired,'original serializer whole backing/EOF');
  const auth={policyId:'archive',credentialId:'key',principalId:null,authType:'proxy_key',policy:{tenantId:'fixture',retainRequestContent:true}};
  const selected={provider:{id:'fixture'},endpoint:{request_format:'openai.chat_completions'},model:null,capability:'llm.chat',body:source};
  const prepared=prepareContentRetention(bindings,auth,selected,'archive-request');
  source.first=9;source.data='mutated';await track(prepared.write());
  const stored=await bindings.CONTENT_ARCHIVE.get('v1/fixture/'+prepared.contentRef+'.json');
  const saved=JSON.parse(await stored.text());
  check(JSON.stringify(saved.body)===oracle,'actual R2 stores captured complete JSON bytes');
  let release,arrive;const gate=new Promise(resolve=>{release=resolve;}),entered=new Promise(resolve=>{arrive=resolve;});
  let finished=false,putEof=false,holdPrimary,hasHoldPrimary=false;
  const held=prepareContentRetention({CONTENT_ARCHIVE:{async put(_key,body){
   const input=body.getReader();let eof=false,hasReadPrimary=false,readPrimary;const cleanup=[];
   try{for(;;){const part=await input.read();if(part.done){eof=true;break;}check(part.value.buffer.byteLength<=32768,'held injected sink whole backing');}putEof=true;arrive();await gate;}
   catch(error){hasReadPrimary=true;readPrimary=error;}
   finally{if(!eof)try{await input.cancel();}catch(error){cleanup.push(error);}try{input.releaseLock();}catch(error){cleanup.push(error);}}
   if(cleanup.length)throw new AggregateError(hasReadPrimary?[readPrimary,...cleanup]:cleanup,'held sink cleanup');if(hasReadPrimary)throw readPrimary;
  }}},auth,{...selected,body:{data:'h'.repeat(100000)}},'held-archive');
  const writing=track(held.write()),outcome=writing.then(()=>({failed:false}),error=>({failed:true,error}));void writing.then(()=>{finished=true;},()=>{finished=true;});
  try{await Promise.race([entered,writing.then(()=>{throw Error('R2 finished before held assertion');})]);check(putEof&&!finished,'serializer EOF is not R2 completion');}
  catch(error){hasHoldPrimary=true;holdPrimary=error;}
  finally{release();}
  const heldOutcome=await outcome;if(heldOutcome.failed){if(hasHoldPrimary)throw new AggregateError([holdPrimary,heldOutcome.error],'held root failures');throw heldOutcome.error;}if(hasHoldPrimary)throw holdPrimary;
  // Labelled sink rejection: FIRST actual native cancel retires before the
  // injected continuation rejects. This is not a pending native-read witness.
  let releaseCancel,cancelArrive,cancelCalls=0,rejectedDone=false,cancelFailed=false,cancelReason;
  const cancelGate=new Promise(resolve=>{releaseCancel=resolve;}),cancelEntered=new Promise(resolve=>{cancelArrive=resolve;});
  const cancelError=Error('synthetic cancel continuation');
  const rejecting=prepareContentRetention({CONTENT_ARCHIVE:{async put(_key,body){
   const original=body.cancel.bind(body);let cancel;
   body.cancel=()=>cancel??=(async()=>{cancelCalls++;const actual=await original().then(()=>({failed:false}),error=>({failed:true,error}));cancelArrive();await cancelGate;if(actual.failed)throw new AggregateError([actual.error,cancelError],'actual and injected cancellation');throw cancelError;})();
   throw undefined;
  }}},auth,{...selected,body:{data:'r'.repeat(100000)}},'rejected-archive');
  const rejected=track(rejecting.write().then(()=>({failed:false}),error=>({failed:true,error})));
  void rejected.then(()=>{rejectedDone=true;});
  try{await Promise.race([cancelEntered,rejected.then(()=>{throw Error('write settled before held cancellation');})]);check(cancelCalls===1&&!rejectedDone,'FIRST cancel owns write completion');}
  catch(error){cancelFailed=true;cancelReason=error;}
  finally{releaseCancel();}
  const rejectedOutcome=await rejected;
  if(cancelFailed)throw rejectedOutcome.failed?new AggregateError([cancelReason,rejectedOutcome.error],'cancel assertion and write'):cancelReason;
  check(rejectedOutcome.failed&&rejectedOutcome.error instanceof AggregateError&&rejectedOutcome.error.errors[0]===undefined,'literal undefined primary retained alongside cleanup');
  check(cancelCalls===1&&rejectedDone,'actual cancellation and serializer pipe joined');
  result={kind:'actual R2 and original serializer; separately labelled held/rejected sink injections',bytes,maximum,eof,unlocked:!stream.locked,intact:!Object.isFrozen(source),stored:true,heldR2Joined:finished,cancelCalls};
 }else{
  const soft=mode==='soft',overflow=mode==='identity',archiveOverflow=mode==='archive-limit',tenant=overflow?'t'.repeat(1025):'fixture';
  const policy={enabled:true,generation:'g1',tenantId:tenant,providers:['openai'],models:['openai/gpt-6-astra'],monthlyBudgetMicros:1000000,dailyBudgetMicros:1000000,weeklyBudgetMicros:1000000,budgetScope:'policy',budgetMode:soft?'soft':'reserve',requestCostMicros:1,retainRequestContent:true};
  const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode('abcdefgh')))].map(x=>x.toString(16).padStart(2,'0')).join('');
  const cases=['hard','soft','identity','archive-limit'];
  await authorityCall(bindings,'/policies/initialize-all',cases.map(name=>({policyId:name,policy:{...policy,tenantId:name==='identity'?'t'.repeat(1025):'fixture',budgetMode:name==='soft'?'soft':'reserve'}})));
  await authorityCall(bindings,'/credentials/initialize-all',cases.map(name=>({credentialId:name.replaceAll('-','_'),credential:{enabled:true,secretSha256:digest,policyId:name,policyGeneration:'g1'}})));
  await authorityCall(bindings,'/connections/initialize-all',[{providerId:'openai',enabled:true,monthlyBudgetMicros:1000000}]);
  const row={provider:0,reserve:0,status:0,charge:0,r2:0,providerBeforeStatus:false},events=[],names=new Set(),ids=[];
  const env={...bindings,BUDGET_LEDGER:{idFromName:name=>bindings.BUDGET_LEDGER.idFromName(name),get:id=>{
   const stub=bindings.BUDGET_LEDGER.get(id);return {fetch(input,init){const path=new URL(String(input)).pathname;if(path==='/reserve'){row.reserve++;ids.push(JSON.parse(init.body).reservationId);}if(path==='/status'){row.status++;}if(path==='/charge')row.charge++;names.add(String(id));return stub.fetch(input,init);}};
  }},CONTENT_ARCHIVE:{put(...args){row.r2++;return bindings.CONTENT_ARCHIVE.put(...args);}},
   // Labelled queue-sink injection: real UsageLedger SQLite is awaited in THIS request.
   USAGE_QUEUE:{async send(event){events.push(event);if(event.type)await ingestUsage(bindings,event);else throw Error('unexpected fallback');}}};
  globalThis.fetch=(input,init)=>{if(String(input).includes('api.openai.com')){row.provider++;row.providerBeforeStatus=row.status===0;}return nativeFetch(input,init);};
  const body={model:'openai/gpt-6-astra',messages:archiveOverflow?Array.from({length:11000},()=>({role:'user',content:'x'})):[{role:'user',content:'synthetic fixture'}]};
  const response=await worker.fetch(new Request('https://router.example/v1/chat/completions',{method:'POST',headers:{authorization:'Bearer clawrouter-live-'+mode.replaceAll('-','_')+'-abcdefgh','content-type':'application/json'},body:JSON.stringify(body)}),env,{waitUntil:track});
  const text=await response.text(); // Actual delivery precedes delivery-dependent drains.
  let index=0;while(index<roots.length){const batch=roots.slice(index);index=roots.length;await Promise.all(batch);}
  if(overflow||archiveOverflow){check(response.status===503&&JSON.parse(text).error.code==='accounting_preflight_unavailable','terminal resource denial');check(row.provider===0&&row.reserve===0&&row.status===0&&row.r2===0,'denial before every owned effect');}
  else{check(response.status===200&&row.provider===1&&row.r2===1&&events.length===1,'healthy complete public accounting');check(events[0].actual_cost_micros===1&&events[0].content_retained,'original priced receipt');check(soft?row.status===4&&row.providerBeforeStatus&&row.charge===4:row.reserve===4,'four real ledger legs');}
  const sql=[];for(const id of names){const response=await bindings.BUDGET_LEDGER.get(bindings.BUDGET_LEDGER.idFromString(id)).fetch('https://clawrouter.internal/fixture-sql');sql.push(await response.json());}
  if(!soft&&!overflow&&!archiveOverflow){const records=sql.flatMap(item=>item.reservations);check(records.length===4&&records.every(item=>item.settled===1&&item.reserved_micros===1)&&records.every(item=>ids.includes(item.reservation_id)),'same real SQLite reservation IDs settle once');}
  result={kind:'public Worker and real SQLite; injected direct-ingest queue sink',status:response.status,...row,events:events.length,sqlOwners:sql.length};
 }
 }catch(error){hasPrimary=true;primary=error;}
 finally{globalThis.fetch=nativeFetch;}
 const failures=[];let joined=0;while(joined<roots.length){const batch=roots.slice(joined);joined=roots.length;for(const outcome of await Promise.all(batch))if(outcome.failed)failures.push(outcome.error);}
 if(failures.length)throw new AggregateError(hasPrimary?[primary,...failures]:failures,'fixture independent roots');if(hasPrimary)throw primary;
 return Response.json(result);
},queue:worker.queue};`;
const upstream = `export default {fetch(){return Response.json({id:'fixture-completion',object:'chat.completion',choices:[{index:0,message:{role:'assistant',content:'synthetic result'},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}});}};`;

test("actual Worker accounting admission, original serializer backings and real R2/SQLite", { timeout: 90_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "accounting-preflight-"));
  let runtime, hasPrimary = false, primary;
  const roots = [];
  const observe = root => { const outcome = root.then(value => ({ failed: false, value }), error => ({ failed: true, error })); roots.push(outcome); return root; };
  t.after(async () => {
    const failures = [];
    for (const result of await Promise.all(roots)) if (result.failed) failures.push(result.error);
    try { await runtime?.dispose(); } catch (error) { failures.push(error); }
    try { await rm(directory, { recursive: true, force: true }); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(hasPrimary ? [primary, ...failures] : failures, "accounting fixture cleanup");
  });
  try {
    runtime = await startWorkerdFixture(directory, router, upstream, { r2Buckets: ["CONTENT_ARCHIVE"], preventEviction: true });
    for (const mode of ["archive", "hard", "soft", "identity", "archive-limit"]) {
      const result = await observe(runtime.dispatchFetch("https://router.example/" + mode).then(async response => {
        const body = await response.json(); assert.equal(response.status, 200); return body;
      }));
      if (mode === "archive") { assert.equal(result.stored, true); assert.ok(result.maximum <= 32768); assert.equal(result.eof, true); }
      else if (mode === "identity" || mode === "archive-limit") { assert.equal(result.status, 503); assert.equal(result.provider, 0); assert.equal(result.reserve, 0); assert.equal(result.r2, 0); }
      else { assert.equal(result.status, 200); assert.equal(result.provider, 1); assert.equal(result.events, 1); }
    }
  } catch (error) { hasPrimary = true; primary = error; throw error; }
});
