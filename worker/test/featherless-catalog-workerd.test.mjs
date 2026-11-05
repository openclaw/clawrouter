import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startWorkerdFixture } from "../../test/helpers/workerd.mjs";
const router = `
export { PolicyBindingIndexObject, BudgetLedgerObject, UsageLedgerObject, GrantCredentialObject } from './worker/index.ts';
import worker from './worker/index.ts';
import { authorityCall } from './worker/authority.ts';
import { putGrantCredentials } from './worker/grant-credentials.ts';
import { sha256Hex } from './worker/utils.ts';
import { snapshot } from './worker/providers.ts';
import { bodyBudgetCharged, BodyLease } from './worker/body-budget.ts';
import { HttpOperation } from './worker/http-operation.ts';
const originalFetch=globalThis.fetch.bind(globalThis);let fetches=0;const attempts=[];let physicalPending,scanOperation,producerComplete=false,producerCanceled=false;
const originalWait=HttpOperation.prototype.wait,originalStop=HttpOperation.prototype.stop;
HttpOperation.prototype.wait=function(pending,...rest){if(physicalPending&&!scanOperation){const physical=physicalPending;void physical.then(response=>pending.then(value=>{if(value===response)scanOperation=this;},()=>undefined),()=>undefined);}return originalWait.call(this,pending,...rest);};
HttpOperation.prototype.stop=function(cause,...rest){if(this===scanOperation){if(cause==='complete')producerComplete=true;if(cause==='caller')producerCanceled=true;}return originalStop.call(this,cause,...rest);};
globalThis.fetch=(input,init)=>{const req=new Request(input,init);const url=new URL(req.url);attempts.push({origin:url.origin,path:url.pathname,query:[...url.searchParams.keys()],capacity:bodyBudgetCharged()});if(!req.url.startsWith('https://api.featherless.ai/v1/models?')||bodyBudgetCharged()!==96*1024*1024)throw new Error('unqualified dispatch or capacity');fetches++;physicalPending=originalFetch(req);return physicalPending;};
const id=n=>'model-'+String(n).padStart(4,'0')+'x'.repeat(470);
const provider=structuredClone(snapshot.providers.find(p=>p.id==='openai'));
const endpoint={...provider.endpoints.find(e=>e.id==='models_list'),id:'catalog',path:'/models',method:'GET',methods:['GET'],request_format:'featherless.catalog',response_format:'featherless.catalog',native_proxy:false,timeout_ms:20000,path_params:[],path_param_styles:{},headers:{},query:{}};
Object.assign(provider,{id:'featherless',config_keys:['FEATHERLESS_API_KEY'],optional_config_keys:[],base_urls:{default:'https://api.featherless.ai/v1'},native_prefixes:['featherless'],routing:{nativePrefixes:['featherless'],modelPrefixes:['featherless/'],baseUrlParam:null,serviceParam:null},auth:{schemes:[{type:'bearer',header:'Authorization',format:'Bearer \\u0024{secret}',secretKind:'api_key'}],grantTransports:{}},adapter:{...provider.adapter,injectHeaders:{},injectQuery:{},passthroughHeaders:[]},capabilities:[{id:'models.list',endpoint:'catalog',methods:['GET']}],endpoints:[endpoint],models:Array.from({length:5000},(_,n)=>({id:'featherless/'+id(n),upstream:id(n),capabilities:[],pricing:null,pricing_ref:null}))});
snapshot.providers=[...snapshot.providers.filter(p=>p.id!=='featherless'),provider];
export default {async fetch(request,env){
 const pending=[];const ctx={waitUntil:p=>pending.push(p)};const drain=async()=>{while(pending.length)await Promise.all(pending.splice(0));};
 await authorityCall(env,'/policies/initialize-all',[{policyId:'fixture',policy:{enabled:true,generation:'g1',providers:['featherless'],tenantId:'fixture',monthlyBudgetMicros:10000,requestCostMicros:700,retainRequestContent:false}}]);
 await authorityCall(env,'/credentials/initialize-all',[{credentialId:'fixture',credential:{enabled:true,secretSha256:await sha256Hex('fixture-secret'),policyId:'fixture',policyGeneration:'g1'}}]);
 await authorityCall(env,'/connections/initialize-all',[{providerId:'featherless',enabled:true,monthlyBudgetMicros:10000}]);
 await putGrantCredentials(env,'oauth/fixture/featherless',{provider:'featherless',kind:'api_key',enabled:true,credential:'synthetic-original-key'});
 const call=()=>worker.fetch(new Request('https://router.example/v1/proxy/featherless/catalog',{headers:{authorization:'Bearer clawrouter-live-fixture-fixture-secret'}}),env,ctx);
 const held=new BodyLease();held.grow(1024*1024);const refused=await call();const denied=refused.status;await refused.text();const before=fetches;held.release();await drain();
 const response=await call();const charged=bodyBudgetCharged(),completeAtReturn=producerComplete;if(response.status!==200)throw new Error('catalog refused status='+response.status+' fetches='+fetches+' capacity='+charged+' attempts='+JSON.stringify(attempts)+' body='+await response.text());const reader=response.body.getReader();let wire='',maximum=0;
 const example={id:id(0),context_length:8192,max_completion_tokens:1024,concurrency_cost:1,is_gated:false,available_on_current_plan:true,features:{tool_use:true,image_input:false},pricing:{prompt:'0.2',completion:'0.4',image:'0.1',request:'0.3'}};
 const expected=JSON.stringify({providerId:'featherless',catalog:[]}).length+5000*JSON.stringify(example).length+4999;
 for(;;){const next=await reader.read();if(next.done)break;maximum=Math.max(maximum,next.value.byteLength);wire+=new TextDecoder().decode(next.value);if(!producerComplete&&bodyBudgetCharged()!==96*1024*1024)throw new Error('lease released while bytes remain: received='+wire.length+' expected='+expected+' fetches='+fetches+' capacity='+bodyBudgetCharged());}
 reader.releaseLock();if(wire.length!==expected)throw new Error('incomplete catalog');await drain();const result=JSON.parse(wire);const released=bodyBudgetCharged(),fullProducerEOF=producerComplete;
 producerComplete=false;scanOperation=undefined;physicalPending=undefined;const cancel=await call();const cancelHeld=bodyBudgetCharged(),cancelCompleteAtReturn=producerComplete;await cancel.body.cancel();await drain();
 return Response.json({denied,before,status:response.status,charged,completeAtReturn,fullProducerEOF,released,cancelHeld,cancelCompleteAtReturn,producerCanceled,cancelProducerEOF:producerComplete,final:bodyBudgetCharged(),count:result.catalog.length,providerId:result.providerId,bytes:new TextEncoder().encode(wire).byteLength,maximum,fetches,first:result.catalog[0].id,last:result.catalog.at(-1).id});
},queue:worker.queue};`;
const upstream = `
const id=n=>'model-'+String(n).padStart(4,'0')+'x'.repeat(470);
export default {async fetch(request){const url=new URL(request.url),page=Number(url.searchParams.get('page'));
 if(url.origin!=='https://api.featherless.ai'||url.pathname!=='/v1/models'||url.searchParams.get('capabilities')!=='chat'||url.searchParams.get('per_page')!=='100'||request.headers.get('authorization')!=='Bearer synthetic-original-key'||request.method!=='GET')return new Response('unqualified',{status:400});
 return Response.json({data:Array.from({length:100},(_,i)=>({id:id((page-1)*100+i),context_length:8192,max_completion_tokens:1024,concurrency_cost:1,is_gated:false,available_on_current_plan:true,features:{tool_use:true,image_input:false},pricing:{prompt:'0.2',completion:'0.4',image:'0.1',request:'0.3'}})),pagination:{current_page:page,per_page:100,total_items:5000,total_pages:50},total:5000});
}};`;

test("workerd full 5000-row scan retains capacity through actual serialization, refuses overlap and releases on EOF/cancel", { timeout: 60000 }, async t => {
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-featherless-workerd-")); t.after(() => rm(temporary, { recursive: true, force: true }));
  const instance = await startWorkerdFixture(temporary, router, upstream, { preventEviction: true }); t.after(() => instance.dispose());
  const response = await fetch((await instance.ready).origin); assert.equal(response.status, 200, await response.clone().text()); const proof = await response.json();
  assert.equal(proof.denied, 503); assert.equal(proof.before, 0); assert.equal(proof.status, 200); assert.equal(proof.count, 5000); assert.equal(proof.providerId, "featherless");
  assert.ok(proof.charged === 96 * 1024 * 1024 || proof.completeAtReturn && proof.charged === 0);
  assert.equal(proof.fullProducerEOF, true); assert.equal(proof.released, 0);
  assert.ok(proof.cancelHeld === 96 * 1024 * 1024 || proof.cancelCompleteAtReturn && proof.cancelHeld === 0);
  assert.ok(proof.producerCanceled || proof.cancelProducerEOF); assert.equal(proof.final, 0);
  assert.equal(proof.fetches, 100); assert.ok(proof.bytes > 3 * 1024 * 1024 && proof.bytes <= 4 * 1024 * 1024); assert.ok(proof.maximum <= 48 * 1024);
  assert.equal(proof.first, `model-0000${"x".repeat(470)}`); assert.equal(proof.last, `model-4999${"x".repeat(470)}`);
});
