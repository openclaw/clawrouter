import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire, stripTypeScriptTypes } from "node:module";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../scripts/compile-providers.mjs";
import snapshot from "../worker/generated/provider-snapshot.json" with { type: "json" };
import { startWorkerdFixture } from "./helpers/workerd.mjs";
import { runOpenClawConsumer } from "./helpers/openclaw-consumer.mjs";

export const privateCatalogPin="2d1a1c293537ed34fdbf0f496d364aec575e5ba9";
export const privateProviders=["baseten","arcee","novita"];
export const privateGroups={stream:["eof","provider_error"],simple:["eof","provider_error"],empty:["empty"],opaque:["unpriced"],
  foreign:["foreign_discovery","foreign_inference"],environment:["environment"],rotation:["rotation"],revocation:["caller_revoke","grant_revoke"],
  warm:["warm"],held:["narrow","broaden","shared_abort"],request:["method","body","query","redirect"],
  invalid:["malformed","truncated","oversize"],preabort:["cold","warm_abort","inference_abort"],partial:["stream_abort","simple_abort"]};
export const privateCases=privateProviders.flatMap(provider=>Object.entries(privateGroups).flatMap(([group,scenarios])=>scenarios.map(scenario=>({
  id:provider+"_"+group+"_"+scenario,provider,group,scenario,api:group==="stream"||scenario==="stream_abort"?"stream":"simple",
  workerOnly:["method","body","query"].includes(scenario)
}))));
export const privateKey=(id,kind="inference",secret="fixture-secret")=>`clawrouter-live-${id}_${kind}-${secret}`;
export async function finishPrivateOwned(body,cleanups){const failures=[];let value;try{value=await body();}catch(e){failures.push(e);}for(const f of cleanups)try{await f();}catch(e){failures.push(e);}if(failures.length===1)throw failures[0];if(failures.length)throw new AggregateError(failures,"private catalog body and owned cleanup failed");return value;}
export async function joinPrivateOriginals(s){let at=0;while(at<s.roots.length){const batch=s.roots.slice(at);at=s.roots.length;for(const result of await Promise.allSettled(batch))if(result.status==='rejected')s.failures.push(result.reason);}for(const o of s.operations)if(o.failed)s.failures.push(o.error);if(s.failures.length)throw new AggregateError(s.failures,"private catalog original operations failed");}

const router=`
export {PolicyBindingIndexObject,BudgetLedgerObject,UsageLedgerObject,GrantCredentialObject} from './worker/index.ts';
import worker from './worker/index.ts';
import {authorityCall} from './worker/authority.ts';
import {putGrantCredentials,revokeGrantCredentials} from './worker/grant-credentials.ts';
import {ingestUsage,usageSnapshot} from './worker/ledgers.ts';
import {bodyBudgetCharged} from './worker/body-budget.ts';
import {sha256Hex} from './worker/utils.ts';
${joinPrivateOriginals.toString()}
const states=new Map(),nativeFetch=globalThis.fetch;
const bases={baseten:'https://inference.baseten.co/v1',arcee:'https://api.arcee.ai/api/v1',novita:'https://api.novita.ai/openai/v1'};
function observe(s,p,kind){const o={kind,state:'pending',failed:false};s.operations.push(o);s.roots.push(p.then(value=>{o.state='fulfilled';return value;},error=>{o.state='rejected';o.failed=true;o.error=error;}));return p;}
function invoke(s,kind,run){try{return observe(s,run(),kind);}catch(e){s.failures.push(e);throw e;}}
async function control(s,kind){const r=await invoke(s,'control_fetch',()=>Reflect.apply(nativeFetch,globalThis,['https://private-control.fixture/'+kind+'/'+s.id,{method:'POST',body:JSON.stringify(s.row)}]));return invoke(s,'control_body',()=>r.json());}
function patch(s,object,name,value){const descriptor=Object.getOwnPropertyDescriptor(object,name);Object.defineProperty(object,name,{configurable:true,writable:true,value});s.restores.push(()=>{if(Object.getOwnPropertyDescriptor(object,name)?.value!==value)throw Error('foreign original descriptor');if(descriptor)Object.defineProperty(object,name,descriptor);else delete object[name];});}
async function mutate(s,kind){
 const admin={scope:'admin',actor:{auth:'admin_token',email:'fixture@example.com',role:'admin'}};
 if(kind==='caller_revoke')for(const suffix of ['inference','discovery','alternate'])await authorityCall(s.env,'/credentials/mutate',{...admin,credentialId:s.id+'_'+suffix,operation:'revoke'});
 else if(kind==='rotation')for(const suffix of ['inference','discovery','alternate'])await authorityCall(s.env,'/credentials/mutate',{...admin,credentialId:s.id+'_'+suffix,operation:'put',credential:{...s.credential,secretSha256:await sha256Hex('rotated-secret')}});
 else if(kind==='grant_revoke')await revokeGrantCredentials(s.env,s.grantKey);
 else if(kind==='narrow'||kind==='broaden'){const next={...s.policy,models:kind==='narrow'?[]:null};await authorityCall(s.env,'/policies/put',{policyId:s.id,policy:next});}
 else throw Error('unknown policy operation');
 s.mutated=true;s.timeline.push({phase:'mutation',sequence:++s.sequence});
}
globalThis.fetch=function(input,init){
 const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url),headers=new Headers(init?.headers??input.headers),secret=headers.get('authorization');
 const matches=[...states.values()].filter(s=>secret==='Bearer synthetic-private-'+s.id);
 if(matches.length!==1)throw Error('unbound selected original private credential');const s=matches[0];
 if(url.href!==bases[s.row.provider]+'/models'&&url.href!==bases[s.row.provider]+'/chat/completions')throw Error('foreign private destination');
 s.calls.push({method:init?.method??input.method??'GET',path:url.pathname,query:!!url.search,bodyAbsent:(init?.body??input.body??null)===null,
  originalKey:secret==='Bearer synthetic-private-'+s.id,noCaller:!headers.has('x-api-key')&&!headers.has('x-upstream-url'),redirect:init?.redirect??input.redirect});
 const p=invoke(s,'fetch',()=>Reflect.apply(nativeFetch,this,arguments));
 observe(s,p.then(response=>{if(!response.body)return;const b=response.body,get=b.getReader,cancel=b.cancel;
  patch(s,b,'cancel',function(){return invoke(s,'body_cancel',()=>Reflect.apply(cancel,this,arguments));});
  patch(s,b,'getReader',function(){let reader;try{reader=Reflect.apply(get,this,arguments);}catch(e){s.failures.push(e);throw e;}const r={body:b,unlocks:0,eof:false};s.readers.push(r);observe(s,reader.closed,'closed');
   for(const kind of ['read','cancel']){const original=reader[kind];patch(s,reader,kind,function(){const p=invoke(s,kind,()=>Reflect.apply(original,this,arguments));
    if(kind==='read')observe(s,p.then(async chunk=>{if(chunk.done){r.eof=true;s.timeline.push({phase:'eof',sequence:++s.sequence});return;}
     if(chunk.value.byteLength&&!s.prefix){s.prefix=true;s.timeline.push({phase:'prefix',sequence:++s.sequence});if(['narrow','broaden'].includes(s.row.scenario)){await mutate(s,s.row.scenario);await control(s,'complete');}}
    }),'read_observer');return p;});}
   const release=reader.releaseLock;patch(s,reader,'releaseLock',function(){try{const v=Reflect.apply(release,this,arguments);r.unlocks++;s.timeline.push({phase:'unlock',sequence:++s.sequence});return v;}catch(e){s.failures.push(e);throw e;}});return reader;
  });
 }),'fetch_observer');return p;
};
export default {async fetch(request,bindings,originalContext){const u=new URL(request.url),parts=u.pathname.split('/');
 if(parts[1]==='private-control'){
  const kind=parts[2],id=parts[3];
  if(kind==='setup'){
   const row=await request.json();if(states.has(id)||row.id!==id||!Object.hasOwn(bases,row.provider))throw Error('invalid private owner');
   const s={id,row,operations:[],roots:[],failures:[],restores:[],readers:[],calls:[],timeline:[],sequence:0,prefix:false,mutated:false,authority:[],inspections:[]};
   const models=['tenant/opaque-a','tenant/opaque-b'].flatMap(m=>[m,row.provider+'/'+m]);
   s.policy={enabled:true,generation:'g1',providers:[row.provider],models:row.scenario==='broaden'?models.slice(0,2):models,tenantId:'fixture',monthlyBudgetMicros:10000,
     ...(row.scenario==='unpriced'?{}:{requestCostMicros:7}),retainRequestContent:false,grantRouting:{eligibleGrants:{[row.provider]:[row.provider]},environmentFallback:true,failover:true}};
   s.credential={enabled:true,secretSha256:await sha256Hex('fixture-secret'),policyId:id,policyGeneration:'g1'};
   const access=bindings.ACCESS_CONTROL,grants=bindings.GRANT_CREDENTIALS;
   s.env={...bindings,BASETEN_API_KEY:'synthetic-poison-env',ARCEE_API_KEY:'synthetic-poison-env',NOVITA_API_KEY:'synthetic-poison-env',USAGE_QUEUE:{send:e=>ingestUsage(bindings,e)},
    ACCESS_CONTROL:{idFromName:n=>access.idFromName(n),get:n=>{const stub=access.get(n);return {fetch(input,init){s.authority.push({path:new URL(typeof input==='string'?input:input.url).pathname,mutation:s.mutated,unlocked:s.readers.length>0&&s.readers.every(r=>r.eof&&r.unlocks===1&&!r.body.locked),sequence:++s.sequence});return invoke(s,'authority_fetch',()=>Reflect.apply(stub.fetch,stub,arguments));}};}},
    GRANT_CREDENTIALS:{idFromName:n=>grants.idFromName(n),get:n=>{const stub=grants.get(n);return {fetch(input,init){s.inspections.push({path:new URL(typeof input==='string'?input:input.url).pathname,mutation:s.mutated,sequence:++s.sequence});return invoke(s,'grant_fetch',()=>Reflect.apply(stub.fetch,stub,arguments));}};}}};
   await authorityCall(s.env,'/policies/put',{policyId:id,policy:s.policy});
   for(const suffix of ['inference','discovery','alternate']){const r=await authorityCall(s.env,'/credentials/mutate',{credentialId:id+'_'+suffix,scope:'admin',actor:{auth:'admin_token',email:'fixture@example.com',role:'admin'},operation:'put',credential:s.credential});if(r.outcome!=='updated')throw Error('credential setup refused');}
   await authorityCall(s.env,'/connections/initialize-all',Object.keys(bases).map(providerId=>({providerId,enabled:true,monthlyBudgetMicros:10000})));
   s.grantKey='oauth/'+id+'/'+row.provider;await putGrantCredentials(s.env,s.grantKey,{provider:row.provider,kind:'api_key',enabled:true,credential:'synthetic-private-'+id});
   states.set(id,s);await control(s,'setup');return Response.json({ready:true});
  }
  const s=states.get(id);if(!s)throw Error('missing private owner');
  if(kind==='mutate'){await mutate(s,(await request.json()).kind);return Response.json({mutated:true});}
  if(kind==='state')return Response.json({calls:s.calls.length,prefix:s.prefix});
  if(kind==='complete')return Response.json(await control(s,'complete'));
  if(kind==='join'){
   if(!s.retirement)s.retirement=(async()=>{const failures=[];try{await joinPrivateOriginals(s);}catch(e){failures.push(e);}let source,usage;
    try{source=await control(s,'proof');}catch(e){failures.push(e);}try{usage=await usageSnapshot(bindings,'fixture',s.id,{kind:'admin'});}catch(e){failures.push(e);}
    try{await joinPrivateOriginals(s);}catch(e){failures.push(e);}for(const restore of s.restores.toReversed())try{restore();}catch(e){failures.push(e);}
    s.retirementFailures=failures;return {retired:failures.length===0,operations:s.operations.map(o=>({kind:o.kind,state:o.state})),calls:s.calls,source:source??null,events:usage?.events??[],charged:bodyBudgetCharged(),timeline:s.timeline,authority:s.authority,inspections:s.inspections,readers:s.readers.map(r=>({unlocks:r.unlocks,eof:r.eof,locked:r.body.locked}))};})();
   const proof=await s.retirement;return Response.json(proof,{status:proof.retired?200:500});
  }throw Error('unknown private control');
 }
 const auth=request.headers.get('authorization')??'',matches=[...states.values()].filter(s=>['inference','discovery','alternate'].some(k=>auth.startsWith('Bearer clawrouter-live-'+s.id+'_'+k+'-')));
 if(matches.length!==1)throw Error('unbound caller');const s=matches[0];if(s.retirement)throw Error('late request');
 const context={waitUntil:p=>{observe(s,p,'waitUntil');originalContext.waitUntil(p);}};
 const pending=worker.fetch(request,s.env,context);observe(s,pending,'handler');observe(s,pending.then(()=>s.timeline.push({phase:'publication',sequence:++s.sequence})),'publication_observer');return pending;
},queue:worker.queue};`;

const upstream=`
const states=new Map(),bases={baseten:'https://inference.baseten.co/v1',arcee:'https://api.arcee.ai/api/v1',novita:'https://api.novita.ai/openai/v1'};
function row(provider,id){return provider==='arcee'?{id,name:id,context_length:1024,max_output_length:512,input_modalities:['text'],output_modalities:['text']}:provider==='novita'?{id,object:'model',created:1,context_size:1024}:{id};}
export default {async fetch(request){const u=new URL(request.url);
 if(u.hostname==='private-control.fixture'){const [,kind,id]=u.pathname.split('/');if(kind==='setup'){const cfg=await request.json();states.set(id,{...cfg,calls:[],held:0,canceled:0,expired:0,settled:0});return Response.json({ready:true});}
  const s=states.get(id);if(!s)throw Error('missing upstream owner');if(kind==='complete'){if(!s.complete)throw Error('no pending source');s.complete();return Response.json({accepted:true});}
  if(kind==='proof'){if(s.producer){await s.producer;s.settled=1;}return Response.json({calls:s.calls,held:s.held,canceled:s.canceled,expired:s.expired,settled:s.settled});}throw Error('unknown source control');}
 const auth=request.headers.get('authorization'),matches=[...states.values()].filter(s=>auth==='Bearer synthetic-private-'+s.id);if(matches.length!==1)throw Error('foreign source credential');const s=matches[0],base=bases[s.provider];
 if(u.search||![base+'/models',base+'/chat/completions'].includes(u.href))throw Error('foreign original destination');const chat=u.pathname.endsWith('/chat/completions');
 const body=chat?await request.json():null;s.calls.push({method:request.method,path:u.pathname,query:!!u.search,chat,model:body?.model??null,stream:body?.stream??null,originalKey:true});
 if(!chat){if(s.scenario==='redirect')return new Response(null,{status:302,headers:{location:'https://foreign.fixture/models'}});
  if(s.scenario==='malformed')return Response.json({data:[{}]});if(s.scenario==='truncated')return new Response('{"data":[',{headers:{'content-type':'application/json'}});
  if(s.scenario==='oversize')return new Response(' '.repeat(2*1024*1024+1),{headers:{'content-type':'application/json'}});
  const payload={data:(s.scenario==='empty'?[]:['tenant/opaque-a','tenant/opaque-b']).map(id=>row(s.provider,id))};
  if(!['narrow','broaden','shared_abort'].includes(s.scenario))return Response.json(payload);
  const text=JSON.stringify(payload),prefix='{"data":[';
  return new Response(new ReadableStream({start(c){s.held=1;c.enqueue(new TextEncoder().encode(prefix));},pull(c){if(s.producer)return s.producer;
   let notify;const notification=new Promise(resolve=>{notify=resolve;});let timer;s.complete=()=>notify('complete');
   timer=setTimeout(()=>{s.expired++;notify('expired');},10000);
   s.cancel=()=>{clearTimeout(timer);notify('cancel');};
   s.producer=notification.then(command=>{clearTimeout(timer);if(command==='expired'){c.error(Error('fixture expired'));throw Error('fixture expired');}if(command==='complete'){c.enqueue(new TextEncoder().encode(text.slice(prefix.length)));c.close();}s.held=0;});return s.producer;
  },cancel(){s.canceled++;s.cancel?.();}}),{headers:{'content-type':'application/json'}});
 }
 const frame=v=>'data: '+JSON.stringify(v)+'\\n\\n',prefix=frame({id:'fixture',object:'chat.completion.chunk',created:1,model:body.model,choices:[{index:0,delta:{role:'assistant',content:'private-prefix'},finish_reason:null}]});
 if(s.scenario==='provider_error')return new Response(prefix+frame({error:{message:'fixture provider rejected',type:'server_error'}}),{headers:{'content-type':'text/event-stream'}});
 if(['stream_abort','simple_abort'].includes(s.scenario))return new Response(new ReadableStream({start(c){s.held=1;c.enqueue(new TextEncoder().encode(prefix));},pull(c){if(s.producer)return s.producer;s.producer=new Promise((resolve,reject)=>{s.resolve=resolve;s.timer=setTimeout(()=>{s.expired++;s.held=0;c.error(Error('fixture expired'));reject(Error('fixture expired'));},10000);});return s.producer;},cancel(){s.canceled++;clearTimeout(s.timer);s.held=0;s.resolve?.();}}),{headers:{'content-type':'text/event-stream'}});
 return new Response(prefix+frame({id:'fixture',object:'chat.completion.chunk',created:1,model:body.model,choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:4,completion_tokens:3,total_tokens:7}})+'data: [DONE]\\n\\n',{headers:{'content-type':'text/event-stream'}});
}};`;

export async function startPrivateCatalogFixture(){const directory=await mkdtemp(join(tmpdir(),'private-catalog-client-'));let runtime;
 try{runtime=await startWorkerdFixture(directory,router,upstream);}catch(error){await finishPrivateOwned(()=>{throw error;},[()=>rm(directory,{recursive:true,force:true})]);}
 const origin=(await runtime.ready).origin;
 const command=async(row,kind,body={})=>{const response=await fetch(origin+'/private-control/'+kind+'/'+row.id,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const text=await response.text();assert.equal(response.status,200,'private fixture control failed');return JSON.parse(text);};
 return {origin,setup:row=>command(row,'setup',row),join:row=>command(row,'join'),close:()=>finishPrivateOwned(()=>{},[()=>runtime.dispose(),()=>rm(directory,{recursive:true,force:true})])};
}
export function assertPrivateReceipt(row,p){assert.equal(p.retired,true);assert.ok(p.operations.every(o=>o.state==='fulfilled'));assert.ok(p.readers.every(r=>r.unlocks===1&&!r.locked));assert.equal(p.charged,0);assert.equal(p.source.held,0);assert.equal(p.source.expired,0);
 for(const c of p.calls){assert.equal(c.originalKey,true);assert.equal(c.noCaller,true);assert.equal(c.redirect,'manual');assert.equal(c.query,false);if(c.method==='GET')assert.equal(c.bodyAbsent,true);}
 for(const e of p.events){assert.equal(e.provider,row.provider);assert.equal(e.policy_id,row.id);if(e.capability==='models.list'){assert.equal(e.model,null);assert.equal(e.reserved_cost_micros,0);assert.equal(e.actual_cost_micros,0);}else if(e.status==='success'){assert.equal(e.actual_cost_micros,7);assert.equal(e.cost_basis,'policy_fixed');assert.equal(e.reporting_known_cost_micros,null);assert.equal(e.total_tokens,7);}}
 if(['narrow','broaden'].includes(row.scenario)){const mutation=p.timeline.find(t=>t.phase==='mutation'),publication=p.timeline.find(t=>t.phase==='publication');assert.ok(mutation&&publication);const refresh=p.authority.find(r=>r.path==='/authorization/snapshot'&&r.mutation&&r.unlocked);const inspect=p.inspections.find(r=>r.path==='/inspect'&&r.mutation);assert.ok(refresh&&inspect);assert.ok(mutation.sequence<refresh.sequence&&refresh.sequence<inspect.sequence&&inspect.sequence<publication.sequence);assert.equal(p.source.settled,1);}
 if(['stream_abort','simple_abort'].includes(row.scenario)){assert.equal(p.source.canceled,1);assert.equal(p.source.settled,1);}
 if(row.scenario==='shared_abort'){assert.equal(p.source.settled,1);assert.equal(p.source.canceled,0);}// Explicit completion of shared acquisition, not disconnect proof.
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]){
 test('private client inventory, real shipping compilation and additive row',()=>{const manifests=readdirSync('providers').filter(p=>p.endsWith('.provider.yaml')).sort().map(p=>parse(readFileSync('providers/'+p,'utf8')));assert.ok(manifests.length);assert.deepEqual(manifests.map(p=>p.id).sort(),snapshot.providers.map(p=>p.id).sort());assert.deepEqual(compileProviderSnapshot(manifests),snapshot);
  const rows=parse(readFileSync('.github/workflows/openclaw-contract.yml','utf8')).jobs.consumer.strategy.matrix.include;assert.equal(new Set(rows.map(r=>r.consumer)).size,rows.length);assert.deepEqual(rows.filter(r=>r.consumer==='private-catalogs'),[{consumer:'private-catalogs',ref:privateCatalogPin,test:'test/openclaw-private-catalogs.test.mjs'}]);assert.equal(Object.keys(privateGroups).length,14);assert.equal(new Set(privateCases.map(r=>r.id)).size,privateCases.length);
 });
 test('private original Worker bundles and SDK fixture transforms without execution',async()=>{
  const require=createRequire(import.meta.resolve('wrangler/package.json')),build=require('esbuild').build;
  const bundled=await build({stdin:{contents:router,resolveDir:process.cwd(),sourcefile:'private-client-fixture.ts',loader:'ts'},write:false,bundle:true,format:'esm',platform:'browser',target:'es2022',logLevel:'silent'});assert.ok(bundled.outputFiles[0].text.length);
  await build({stdin:{contents:upstream,sourcefile:'private-upstream.js',loader:'js'},write:false,format:'esm',platform:'browser',target:'es2022',logLevel:'silent'});
  const fixture=readFileSync(new URL('./fixtures/openclaw-private-catalogs-contract.test.ts',import.meta.url),'utf8');
  assert.ok(stripTypeScriptTypes(fixture,{mode:'strip'}).length);
  await build({stdin:{contents:fixture,sourcefile:'private-sdk.ts',loader:'ts'},write:false,format:'esm',platform:'node',target:'node24',logLevel:'silent'});
 });
 test('private cleanup preserves body, undefined and every original cleanup failure',async()=>{const first={},last={},order=[];await assert.rejects(finishPrivateOwned(()=>{throw first;},[()=>{order.push(1);throw undefined;},()=>{order.push(2);throw last;}]),e=>e instanceof AggregateError&&e.errors[0]===first&&e.errors[1]===undefined&&e.errors[2]===last);assert.deepEqual(order,[1,2]);});
 test('private dynamic original join never treats settled rejection as success',async()=>{const reason={},s={roots:[],operations:[],failures:[]};s.roots.push(Promise.resolve().then(()=>{s.roots.push(Promise.reject(undefined));s.operations.push({failed:true,error:reason});}));await assert.rejects(joinPrivateOriginals(s),e=>e instanceof AggregateError&&e.errors[0]===undefined&&e.errors[1]===reason);});
 test('registered private discovery and public inference through Worker SQLite',{skip:!process.env.CLAWROUTER_OPENCLAW_CHECKOUT,timeout:300000},async t=>{const f=await startPrivateCatalogFixture(),created=[];
  await finishPrivateOwned(async()=>{for(const row of privateCases){await f.setup(row);created.push(row);}await runOpenClawConsumer(t,{source:process.env.CLAWROUTER_OPENCLAW_CHECKOUT,sourceHead:privateCatalogPin,fixture:fileURLToPath(new URL('./fixtures/openclaw-private-catalogs-contract.test.ts',import.meta.url)),testPath:'extensions/baseten/clawrouter-private-catalogs-contract.test.ts',env:{CLAWROUTER_CONTRACT_ORIGIN:f.origin,CLAWROUTER_CONTRACT_SOURCE_HEAD:privateCatalogPin,CLAWROUTER_PRIVATE_CATALOG_CASES:JSON.stringify(privateCases)}});},[...privateCases.map(row=>async()=>{if(created.includes(row))assertPrivateReceipt(row,await f.join(row));}),()=>f.close()]);
 });
}
