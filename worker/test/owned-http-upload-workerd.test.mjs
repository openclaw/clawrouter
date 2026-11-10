import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWorkerdFixture } from '../../test/helpers/workerd.mjs';

// This qualifies the native ORIGINAL upload primitive. The separately wired
// UNIFIED client fixture qualifies the eventual private HTTP entry, not this
// fixture-only command. Scalar gates never transfer native I/O between requests.
const router = String.raw`
export {PolicyBindingIndexObject,BudgetLedgerObject,UsageLedgerObject,GrantCredentialObject} from './worker/index.ts';
import {beginOwnedHttpRequest,beginOwnedHttpUpload,adoptOwnedHttpUploadSource,pipeOwnedHttpUpload,dispatchOwnedHttpUpload,abandonOwnedHttpUpload,finishOwnedHttpRequest,ownedHttpCompletion,ownOwnedHttpResponse,ownedHttpSinkOwner,ownedHttpQueueSend,ownedHttpFailureMetadata} from './worker/http-identity-owner.ts';
import {bodyBudgetCharged,ExactBodyCharge} from './worker/body-budget.ts';
import {materializeGrantCredentials,putGrantCredentials} from './worker/grant-credentials.ts';
import {selectedCredentialFailure,SelectedGrantCredentialFailure} from './worker/grant-credential-failure.ts';
import {HttpError} from './worker/utils.ts';
import {jsonBodyStream,jsonBodyBytes} from './worker/json-body.ts';
let released=false,entered=false,done=false,active=false,terminalFailed=false,chargedBefore=0;
const check=(value,label)=>{if(!value)throw Error(label);};
const validateRetirement=(outcome,validate)=>{try{validate();}catch(error){throw new AggregateError(outcome.failed?[outcome.error,error]:[error],'native original outcome validation');}};
export default {async fetch(request,env,context){
 const path=new URL(request.url).pathname;
 if(path==='/release'){released=true;return new Response('released');}
 if(path==='/state')return Response.json({entered,done,active,terminalFailed,charged:bodyBudgetCharged(),chargedBefore});
 let invocationEnv=env,acquisitions=0,materializations=0,reasonReads=0,fault;
 const grantFault=path.startsWith('/grant-acquire-');
 const faultMethod=path.includes('-get-')?'get':'idFromName';
 if(grantFault){
  fault=path.endsWith('-undefined')?undefined:path.endsWith('-huge')?'x'.repeat(17*1024*1024):new HttpError(401,'grant_refresh_failed','forged fixture acquisition');
  if(path.endsWith('-opaque')){fault=Object.create(null);fault.payload='x'.repeat(17*1024*1024);
   for(const key of ['message','stack','cause','errors','toJSON'])Object.defineProperty(fault,key,{get(){reasonReads++;throw Error('arbitrary reason observed');}});}
  invocationEnv={...env,GRANT_CREDENTIALS:{idFromName(key){if(faultMethod==='idFromName'){acquisitions++;throw fault;}return env.GRANT_CREDENTIALS.idFromName(key);},
   get(id){if(faultMethod==='get'){acquisitions++;throw fault;}const stub=env.GRANT_CREDENTIALS.get(id);return{fetch(...args){materializations++;return stub.fetch(...args);}};}}};
 }
 const cap=beginOwnedHttpRequest(request,invocationEnv),baseline=bodyBudgetCharged();
 let hasPrimary=false,primary,retirement,retirementTaken=false,source,reply;
 const finish=()=>retirement??=finishOwnedHttpRequest(cap);
 const outcome=async()=>{try{await finish();return {failed:false};}catch(error){return {failed:true,error};}};
 try{
  if(grantFault){
   let caught,failed=false;
   try{await materializeGrantCredentials(invocationEnv,'oauth/owned-sink/openai',{provider:'openai',credential:'fixture-only'},'openai',null,false,
    undefined,undefined,undefined,undefined,undefined,undefined,ownedHttpSinkOwner(cap));}catch(error){failed=true;caught=error;}
   check(failed&&caught!==fault,'acquisition is bounded before outer retry classifier');
   check(!(selectedCredentialFailure(caught,'oauth/owned-sink/openai') instanceof SelectedGrantCredentialFailure),'external error cannot mint retry');
   check(acquisitions===1&&materializations===0&&reasonReads===0,'no materialize effect or reason inspection');
   fault=undefined;caught=undefined;reply={ok:true,acquisitions,materializations};
  }else if(path==='/grant-native'){
   const temporary=ExactBodyCharge.reserve(32*1024*1024);check(temporary,'fixture source funding');
   let grant,materialized;
   try{grant=await putGrantCredentials(env,'oauth/owned-sink/openai',{provider:'openai',enabled:true,kind:'api_key',credential:'fixture-native-only',unknownOwnedField:{value:[null,7]}});
    materialized=await materializeGrantCredentials(env,'oauth/owned-sink/openai',grant,'openai',null,false,
     undefined,undefined,undefined,undefined,undefined,undefined,ownedHttpSinkOwner(cap));
    check(materialized.credential==='fixture-native-only','actual credential owner materialization');
   }finally{grant=undefined;materialized=undefined;temporary.release();}
   reply={ok:true,native:true};
  }else if(path==='/large'){
   const body={model:'fixture-chat',messages:[{role:'user',content:'a'.repeat(1048576)}]},upload=beginOwnedHttpUpload(cap);
   source=jsonBodyStream(body);adoptOwnedHttpUploadSource(upload,source);
   const readable=pipeOwnedHttpUpload(upload,source,new FixedLengthStream(jsonBodyBytes(body)));
   dispatchOwnedHttpUpload(upload);
   const actual=await ownedHttpCompletion(cap).start(async()=>{
    const response=await fetch('https://upstream.example/chat',{method:'POST',body:readable});
    return {status:response.status,body:await response.json()};
   });
   check(actual.status===200&&actual.body.units===1048576&&actual.body.first===97&&actual.body.last===97,'full original native upload');
   const ended=await outcome();retirementTaken=true;if(ended.failed)throw ended.error;
   check(!source.locked,'original native pipe unlocked');reply={ok:true,units:actual.body.units};
  }else if(path==='/prefix'||path==='/dispatched-prefix'){
   released=false;entered=false;done=false;active=true;terminalFailed=false;chargedBefore=baseline;
   const upload=beginOwnedHttpUpload(cap);
   source=new ReadableStream({async cancel(){entered=true;while(!released)await new Promise(resolve=>setTimeout(resolve,1));}},{highWaterMark:0});
   adoptOwnedHttpUploadSource(upload,source);pipeOwnedHttpUpload(upload,source,new FixedLengthStream(1));
   const dispatched=path==='/dispatched-prefix';
   if(dispatched)dispatchOwnedHttpUpload(upload);
   const publicResponse=new Response('data: {"prefix":true}\n\n',{headers:{'content-type':'text/event-stream'}});
   const delivery=dispatched?ownOwnedHttpResponse(cap,publicResponse):publicResponse;
   const original=dispatched?undefined:abandonOwnedHttpUpload(upload);
   // The originating request owns this cancellation and its terminal tail.
   // The response body never waits on its encompassing completion.
   const settled=outcome();retirementTaken=true;
   context.waitUntil((async()=>{
    if(original)await original;const ended=await settled;
    validateRetirement(ended,()=>check(ended.failed&&ended.error instanceof AggregateError&&ended.error.errors.length===1,'owned abort has one original origin'));
    check(!source.locked,'held original cancellation unlock');source=undefined;done=true;
   })().catch(error=>{terminalFailed=true;done=true;throw error;}));
   return delivery;
  }else if(path.startsWith('/response-')){
   const shared=path==='/response-shared'?Error('shared native cleanup'):undefined;
   let cancels=0,unlocks=0;
   source=new ReadableStream({pull(controller){if(path==='/response-read')controller.error(shared);},cancel(){cancels++;return Promise.reject(shared);}},{highWaterMark:0});
   if(path!=='/response-read'){
    const getReader=source.getReader;
    Object.defineProperty(source,'getReader',{value(...args){const reader=Reflect.apply(getReader,this,args),release=reader.releaseLock;Object.defineProperty(reader,'releaseLock',{value(){Reflect.apply(release,this,[]);unlocks++;throw shared;}});return reader;}});
   }
   const response=ownOwnedHttpResponse(cap,new Response(source));
   let failed=false,failure;
   try{if(path==='/response-read')await response.text();else await response.body.cancel();}catch(error){failed=true;failure=error;}
   const observed={failed,error:failure};validateRetirement(observed,()=>check(failed&&failure.primaryIsUndefined===(shared===undefined)&&failure.origin===(path==='/response-read'?'read':'unlock'),'bounded original native reader outcome'));
   const ended=await outcome();retirementTaken=true;
   validateRetirement(ended,()=>{
    check(ended.failed&&ended.error instanceof AggregateError,'native response terminal origins');
    const expected=path==='/response-read'?1:2;
    check(ended.error.errors.length===expected&&ended.error.errors.every(error=>error.primaryIsUndefined===(shared===undefined)),'native response independent origins');
    check(ended.error.errors.map(error=>error.origin).join(',')===(path==='/response-read'?'read':'cancel,unlock'),'native original origin order');
    check(cancels===(path==='/response-read'?0:1)&&unlocks===(path==='/response-read'?0:1),'native actual cancel and unlock counts');
    check(!source.locked,'native original response unlocked');
   });
   reply={ok:true,origins:path==='/response-read'?1:2};
  }else{
   const shared=path==='/undefined'?undefined:Error('shared fixture origin');
   for(let index=0;index<2;index++){
    const upload=beginOwnedHttpUpload(cap);
    source=new ReadableStream({cancel(){return Promise.reject(shared);}},{highWaterMark:0});
    adoptOwnedHttpUploadSource(upload,source);pipeOwnedHttpUpload(upload,source,new FixedLengthStream(1));
    await abandonOwnedHttpUpload(upload);check(!source.locked,'rejected original cancellation still joins unlock');source=undefined;
   }
   const ended=await outcome();retirementTaken=true;
   validateRetirement(ended,()=>{check(ended.failed&&ended.error instanceof AggregateError,'original failures retained');
   check(ended.error.errors.length===2&&ended.error.errors.every(error=>error.origin==='pipe'&&error.primaryIsUndefined===(shared===undefined))&&ended.error.errors[0].ordinal!==ended.error.errors[1].ordinal,'independent original occurrences');});
   reply={ok:true,origins:2,undefinedOrigin:shared===undefined};
  }
 }catch(error){hasPrimary=true;primary=error;}
 const failures=[];
 // An early assertion releases the finite fixture gate before joining roots.
 released=true;
 if(!retirementTaken){const ended=await outcome();if(ended.failed)failures.push(ended.error);}
 source=undefined;
 if(failures.length)throw new AggregateError(hasPrimary?[primary,...failures]:failures,'native upload fixture outcomes');
 if(hasPrimary)throw primary;
 return Response.json(reply);
}};
`;
const upstream = `export default {async fetch(request){const body=await request.json(),text=body.messages[0].content;return Response.json({units:text.length,first:text.charCodeAt(0),last:text.charCodeAt(text.length-1)});}};`;

test('actual Workerd ORIGINAL upload, independent failures and public-prefix custody', { timeout: 90000 }, async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'owned-http-upload-'));
  const roots = [], origins = new WeakMap(); let mf, cleaned, finished = false, hasPrimary = false, primary;
  const own = promise => {
    if (origins.has(promise)) return origins.get(promise);
    const root = { taken: false, body: undefined, outcome: promise.then(value => ({ failed: false, value }), error => ({ failed: true, error })) };
    origins.set(promise, root); roots.push(root); return root;
  };
  const take = async root => { const result = await root.outcome; root.taken = true; if (result.failed) throw result.error; return result.value; };
  const dispatch = path => {
    const root = own(mf.dispatchFetch('https://router.example' + path));
    // Enroll BODY even if the response arrives after an assertion failed.
    void root.outcome.then(result => { if (!result.failed) root.body ??= own(result.value.text()); });
    return root;
  };
  const text = async root => { const response = await take(root); root.body ??= own(response.text()); return { status: response.status, text: await take(root.body) }; };
  const get = async path => { const reply = await text(dispatch(path)); assert.equal(reply.status, 200, path); return JSON.parse(reply.text); };
  const cleanup = () => cleaned ??= (async () => {
    const failures = [];
    if (mf) try { await text(dispatch('/release')); } catch (error) { failures.push(error); }
    if (mf) try {
      // Scalar observation only: the originating native request performs its
      // own ORIGINAL join before publishing done. No foreign promise is awaited.
      let state = await get('/state');
      while (state.active && !state.done) { await new Promise(resolve => setTimeout(resolve, 1)); state = await get('/state'); }
      assert.equal(state.terminalFailed, false, 'native originating cleanup completed');
    } catch (error) { failures.push(error); }
    for (let i = 0; i < roots.length; i++) await roots[i].outcome;
    for (const root of roots) { const result = await root.outcome; if (result.failed && !root.taken) { root.taken = true; failures.push(result.error); } }
    try { await mf?.dispose(); } catch (error) { failures.push(error); }
    try { await rm(temporary, { recursive: true, force: true }); } catch (error) { failures.push(error); }
    return failures;
  })();
  t.after(async () => { if (finished) return; const failures = await cleanup(); if (failures.length) throw new AggregateError(hasPrimary ? [primary, ...failures] : failures, 'native upload host cleanup'); });
  try {
    mf = await startWorkerdFixture(temporary, router, upstream, { preventEviction: true });
    const baseline = (await get('/state')).charged;
    for (const method of ['id', 'get']) for (const kind of ['undefined', 'huge', 'opaque', 'forged']) await t.test(`native injected grant ${method}/${kind} acquisition`, async () => {
      const value = await get(`/grant-acquire-${method}-${kind}`); assert.equal(value.ok, true); assert.equal(value.acquisitions, 1); assert.equal(value.materializations, 0);
    });
    await t.test('actual GrantCredentialObject original materialization', async () => { const value = await get('/grant-native'); assert.equal(value.ok, true); assert.equal(value.native, true); });
    await t.test('native full 1 MiB ASCII upload' , async () => { const value = await get('/large'); assert.equal(value.ok, true); assert.equal(value.units, 1048576); });
    for (const path of ['/undefined', '/shared']) await t.test(`native independent ${path.slice(1)} cancellation origins`, async () => { const value = await get(path); assert.equal(value.origins, 2); assert.equal(value.ok, true); });
    for (const path of ['/response-undefined', '/response-shared', '/response-read']) await t.test(`native original response ${path.slice(10)}`, async () => { const value = await get(path); assert.equal(value.ok, true); assert.equal(value.origins, path === '/response-read' ? 1 : 2); });
    for (const path of ['/prefix', '/dispatched-prefix']) await t.test(`public SSE prefix precedes held ORIGINAL upload cancellation: ${path}`, async () => {
      const prefix = await text(dispatch(path)); assert.equal(prefix.status, 200); assert.match(prefix.text, /"prefix":true/);
      let state;
      for (let i = 0; i < 500; i++) { state = await get('/state'); if (state.entered) break; await new Promise(resolve => setTimeout(resolve, 1)); }
      assert.equal(state.entered, true); assert.equal(state.done, false); assert.ok(state.charged > baseline);
      await text(dispatch('/release'));
      for (let i = 0; i < 500; i++) { state = await get('/state'); if (state.done) break; await new Promise(resolve => setTimeout(resolve, 1)); }
      assert.equal(state.done, true); assert.equal(state.terminalFailed, false); assert.equal(state.charged, baseline);
    });
  } catch (error) { hasPrimary = true; primary = error; }
  const failures = await cleanup(); finished = true;
  if (failures.length) throw new AggregateError(hasPrimary ? [primary, ...failures] : failures, 'native upload host outcomes');
  if (hasPrimary) throw primary;
});
