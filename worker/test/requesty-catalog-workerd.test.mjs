import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startWorkerdFixture } from "../../test/helpers/workerd.mjs";

const router = `
export {PolicyBindingIndexObject,BudgetLedgerObject,UsageLedgerObject,GrantCredentialObject} from './worker/index.ts';
import worker from './worker/index.ts';
import {snapshot} from './worker/providers.ts';
import {authorityCall} from './worker/authority.ts';
import {putGrantCredentials} from './worker/grant-credentials.ts';
import {sha256Hex} from './worker/utils.ts';
import {bodyBudgetCharged,BodyLease} from './worker/body-budget.ts';
import {HttpOperation} from './worker/http-operation.ts';
const originalFetch=globalThis.fetch.bind(globalThis),calls=[];
let physicalPending,physical,operation;
const originalWait=HttpOperation.prototype.wait,originalStop=HttpOperation.prototype.stop;
HttpOperation.prototype.wait=function(pending,...args){if(pending===physicalPending){operation=this;physical.operation=this;}return originalWait.call(this,pending,...args);};
HttpOperation.prototype.stop=function(cause,...args){const found=calls.find(c=>c.operation===this);if(found){if(cause==='complete')found.producerEOF=true;if(cause==='caller')found.producerCanceled=true;}return originalStop.call(this,cause,...args);};
globalThis.fetch=(input,init)=>{
 const request=new Request(input,init),proof={url:request.url,method:request.method,redirect:request.redirect,headers:[...request.headers],capacity:bodyBudgetCharged(),bytes:0,canceled:false,producerEOF:false,producerCanceled:false};calls.push(proof);physical=proof;
 physicalPending=originalFetch(request).then(response=>{
  const reader=response.body?.getReader();if(!reader)return response;
  return new Response(new ReadableStream({async pull(controller){const next=await reader.read();if(next.done){reader.releaseLock();controller.close();}else{proof.bytes+=next.value.byteLength;controller.enqueue(next.value);}},async cancel(reason){proof.canceled=true;await reader.cancel(reason);reader.releaseLock();}},{highWaterMark:0}),{status:response.status,headers:response.headers});
 });return physicalPending;
};
const provider=structuredClone(snapshot.providers.find(p=>p.id==='openai'));
const endpoint={...provider.endpoints.find(e=>e.id==='models_list'),id:'models_managed',path:'/models/managed',method:'GET',methods:['GET'],request_format:'requesty.models_managed',response_format:'requesty.models_managed',native_proxy:true,timeout_ms:10000,path_params:[],path_param_styles:{},headers:{},query:{}};
Object.assign(provider,{id:'requesty',config_keys:['REQUESTY_API_KEY'],optional_config_keys:[],base_urls:{default:'https://router.requesty.ai/v1'},native_prefixes:['requesty'],routing:{nativePrefixes:['requesty'],modelPrefixes:['requesty/'],baseUrlParam:null,serviceParam:null},auth:{schemes:[{type:'bearer',header:'Authorization',format:'Bearer '+String.fromCharCode(36)+'{secret}',secretKind:'api_key'}],grantTransports:{}},adapter:{...provider.adapter,injectHeaders:{},injectQuery:{},passthroughHeaders:[]},capabilities:[{id:'models.list',endpoint:'models_managed',methods:['GET']}],endpoints:[endpoint],models:[]});
snapshot.providers=[...snapshot.providers.filter(p=>p.id!=='requesty'),provider];
export default {async fetch(request,env){
 const pending=[],ctx={waitUntil:p=>pending.push(p)},drain=async()=>{while(pending.length)await Promise.all(pending.splice(0));};
 await authorityCall(env,'/policies/initialize-all',[{policyId:'fixture',policy:{enabled:true,generation:'g1',providers:['requesty'],tenantId:'fixture',monthlyBudgetMicros:10000,requestCostMicros:700,retainRequestContent:false}}]);
 await authorityCall(env,'/credentials/initialize-all',[{credentialId:'fixture',credential:{enabled:true,secretSha256:await sha256Hex('fixture-secret'),policyId:'fixture',policyGeneration:'g1'}}]);
 await authorityCall(env,'/connections/initialize-all',[{providerId:'requesty',enabled:true,monthlyBudgetMicros:10000}]);
 await putGrantCredentials(env,'oauth/fixture/requesty',{provider:'requesty',kind:'api_key',enabled:true,credential:'synthetic-original-key'});
 const call=manifest=>worker.fetch(new Request('https://router.example'+(manifest?'/v1/proxy/requesty/models_managed':'/v1/native/requesty/models/managed'),{headers:{authorization:'Bearer clawrouter-live-fixture-fixture-secret','x-api-key':'synthetic-caller-key'}}),env,ctx);
 const held=new BodyLease();held.grow(40*1024*1024);const refused=await call(false);const denied=refused.status;await refused.text();const before=calls.length;held.release();await drain();
 const results=[];
 for(const manifest of [false,true]){
  const response=await call(manifest),proof=calls.at(-1),charged=bodyBudgetCharged(),completeAtReturn=proof?.producerEOF;
  if(response.status!==200)throw new Error('catalog status='+response.status+' body='+await response.text());
  const reader=response.body.getReader();let wire='',maximum=0;
  for(;;){const next=await reader.read();if(next.done)break;wire+=new TextDecoder().decode(next.value);maximum=Math.max(maximum,next.value.byteLength);if(!proof.producerEOF&&bodyBudgetCharged()!==32*1024*1024)throw new Error('catalog lease ended before producer EOF');}
  reader.releaseLock();await drain();const value=JSON.parse(wire);
  results.push({manifest,status:response.status,charged,completeAtReturn,count:value.data.length,keys:Object.keys(value),first:value.data[0],last:value.data.at(-1).id,bytes:new TextEncoder().encode(wire).byteLength,maximum,producerEOF:proof.producerEOF,released:bodyBudgetCharged()});
 }
 const cancel=await call(true),cancelProof=calls.at(-1);await cancel.body.cancel();await drain();
 const cancelResult={status:cancel.status,complete:cancelProof.producerEOF,canceled:cancelProof.producerCanceled,released:bodyBudgetCharged()};
 endpoint.timeout_ms=1000;const deadline=await call(false),deadlineProof=calls.at(-1);const deadlineResult={status:deadline.status,body:await deadline.json()};await drain();
 Object.assign(deadlineResult,{readBytes:deadlineProof.bytes,canceled:deadlineProof.canceled,aborted:deadlineProof.operation.signal.aborted,released:bodyBudgetCharged()});
 return Response.json({denied,before,results,cancelResult,deadlineResult,calls:calls.map(({operation,...proof})=>proof)});
},queue:worker.queue};`;

const upstream = `
let calls=0;const id=n=>'model-'+String(n).padStart(4,'0')+'x'.repeat(350);
export default {async fetch(request){
 if(request.url!=='https://router.requesty.ai/v1/models/managed'||request.method!=='GET'||request.headers.get('authorization')!=='Bearer synthetic-original-key'||request.headers.has('x-api-key'))return new Response('unqualified',{status:400});
 if(++calls===4){let first=true;return new Response(new ReadableStream({pull(controller){if(first){first=false;controller.enqueue(new TextEncoder().encode('{"data":['));}}},{highWaterMark:0}),{headers:{'content-type':'application/json'}});}
 return Response.json({data:Array.from({length:4096},(_,n)=>({id:id(n),api:'chat',input_price:'0.2',output_price:0}))});
}};`;

test("workerd Requesty native/manifest actual fetch holds capacity through 4096-row publication and real reader cancellation", { timeout: 60000 }, async t => {
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-requesty-workerd-")); t.after(() => rm(temporary, { recursive: true, force: true }));
  const instance = await startWorkerdFixture(temporary, router, upstream, { preventEviction: true }); t.after(() => instance.dispose());
  const response = await fetch((await instance.ready).origin); assert.equal(response.status, 200, await response.clone().text()); const proof = await response.json();
  assert.equal(proof.denied, 503); assert.equal(proof.before, 0); assert.equal(proof.calls.length, 4);
  for (const result of proof.results) {
    assert.equal(result.status, 200); assert.equal(result.count, 4096); assert.deepEqual(result.keys, ["data"]);
    assert.equal(result.first.input_price, "0.2"); assert.equal(result.first.output_price, 0); assert.equal("context_window" in result.first, false);
    assert.equal(result.last, `model-4095${"x".repeat(350)}`); assert.ok(result.bytes > 1024 * 1024 && result.bytes < 2 * 1024 * 1024);
    assert.ok(result.charged === 32 * 1024 * 1024 || result.completeAtReturn && result.charged === 0);
    assert.equal(result.producerEOF, true); assert.equal(result.released, 0); assert.ok(result.maximum <= 2 * 1024 * 1024);
  }
  for (const call of proof.calls) {
    assert.equal(call.url, "https://router.requesty.ai/v1/models/managed"); assert.equal(call.method, "GET"); assert.equal(call.redirect, "manual");
    assert.deepEqual(call.headers, [["accept", "application/json"], ["authorization", "Bearer synthetic-original-key"]]); assert.equal(call.capacity, 32 * 1024 * 1024);
  }
  assert.equal(proof.cancelResult.status, 200); assert.ok(proof.cancelResult.complete || proof.cancelResult.canceled); assert.equal(proof.cancelResult.released, 0);
  assert.equal(proof.deadlineResult.status, 502); assert.ok(proof.deadlineResult.readBytes > 0);
  assert.equal(proof.deadlineResult.canceled, true); assert.equal(proof.deadlineResult.aborted, true); assert.equal(proof.deadlineResult.released, 0);
});
