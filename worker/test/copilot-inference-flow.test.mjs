import './typescript-setup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { attachGrantCredentialNamespace } from './grant-credential-mock.mjs';
const { GrantCredentialObject, putGrantCredentials, revokeGrantCredentials, inspectGrantCredentials, materializeGrantCredentials } = await import('../grant-credentials.ts');
const { authenticateProxyKey } = await import('../proxy-auth.ts');
const { publicControlAuthorization } = await import('../response-control-authorization.ts');
const { sha256Hex } = await import('../utils.ts');
const { BodyLease, bodyBudgetCharged } = await import('../body-budget.ts');
const MiB=1024*1024, key='oauth/policy/copilot', model='fixture-model', base='https://api.individual.githubcopilot.com/v1';
const gate=()=>Promise.withResolvers();
const row=(patch={})=>({id:model,model_picker_enabled:true,policy:{state:'enabled'},supported_endpoints:['/chat/completions','/messages','/responses'],...patch});
function vendor(url,value,patch={}){
 let bytes=new TextEncoder().encode(typeof value==='string'?value:JSON.stringify(value)),offset=0;
 const response=new Response(new ReadableStream({type:'bytes',pull(c){if(offset<bytes.length){const end=Math.min(bytes.length,offset+16384);c.enqueue(bytes.slice(offset,end));offset=end;}else{c.close();c.byobRequest?.respond(0);}}}),{status:200,headers:{'content-type':'application/json'},...patch});
 Object.defineProperty(response,'url',{value:url});return response;
}
async function fixture(t){
 const values=new Map(),sent=[],retained=new Set(),events=[];
 const ledger={async fetch(url){return Response.json(new URL(url).pathname==='/reserve'?{allowed:true,chargedMicros:700}:new URL(url).pathname==='/dispatch'?{dispatched:true}:{ok:true});}};
 const env=attachGrantCredentialNamespace({USAGE_QUEUE:{async send(event){events.push(event);}},BUDGET_LEDGER:{idFromName:n=>n,get:()=>ledger},POLICY_KV:{async get(k,type){const v=values.get(k);return v===undefined?null:type==='text'?JSON.stringify(v):structuredClone(v);},async put(k,v){values.set(k,JSON.parse(v));}}});
 const call=async(path,body)=>{const r=await env.grantAuthority.fetch('https://authority'+path,{method:'POST',body:JSON.stringify(body)});assert.equal(r.status,200,await r.text());};
 const policy={enabled:true,generation:'g1',providers:['github-copilot'],models:null,requestCostMicros:700};
 await call('/policies/initialize-all',[{policyId:'policy',policy}]);
 await call('/credentials/initialize-all',[{credentialId:'fixture',credential:{enabled:true,policyId:'policy',policyGeneration:'g1',principalId:null,secretSha256:await sha256Hex('abcdefgh')}}]);
 const auth=await authenticateProxyKey(new Headers({authorization:'Bearer clawrouter-live-fixture-abcdefgh'}),env);assert.equal(auth instanceof Response,false);
 await putGrantCredentials(env,key,{provider:'github-copilot',kind:'oauth',enabled:true,accessToken:'synthetic-bootstrap-only'});
 const owner=env.GRANT_CREDENTIALS.objects.get(key);owner.state.waitUntil=p=>{const work=p.catch(()=>undefined);retained.add(work);void work.finally(()=>retained.delete(work));};
 const record=owner.values.get('credential'),deviceId='device-attempt-fixture',accountId='account-attempt-fixture',acquisition='original-acquisition-binding',binding='current-account-binding',actor='original-admin-actor';
 // Bootstrap the real owner/attachment, then seed the private post-onboarding state.
 // The actual workerd fixture obtains this state through device/account admin flows.
 delete record.accessToken;record.generation++;record.poolSyncPending=true;record.status='reauth_required';record.copilotDeviceCredential={version:1,githubDomain:'github.com',ownerBinding:acquisition,accessToken:'synthetic-original-github-token'};
 record.copilotDeviceAttempt={version:1,id:deviceId,key,generation:record.generation,lineage:record.lineage,githubDomain:'github.com',actor,ownerBinding:acquisition,phase:'committed',expiresAt:1};
 const scope={key,generation:record.generation,lineage:record.lineage,deviceAttemptId:deviceId,acquisitionBinding:acquisition,githubDomain:'github.com',actor};
 record.copilotAccountAttempt={...scope,version:1,id:accountId,ownerBinding:binding,phase:'qualified'};
 record.copilotAccountBinding={...scope,version:1,accountAttemptId:accountId,ownerBinding:binding,apiBaseUrl:base,qualifiedAt:1};
 owner.values.set('credential',structuredClone(record));
 // Account acquisition changes generation; publish its inactive attachment too.
 // A same-generation active -> reauth_required rewrite is correctly rejected.
 await inspectGrantCredentials(env,key);assert.equal(owner.values.get('credential').poolSyncPending,false);
 const input={key,expectedGeneration:record.generation,expectedLineage:record.lineage,deviceAttemptId:deviceId,accountAttemptId:accountId,authorization:publicControlAuthorization(auth),runtimeIdentity:{ownerBinding:binding,integrationId:'fixture',editorVersion:'Fixture/1',editorPluginVersion:'Fixture/1',userAgent:'Fixture/1'},deadline:Date.now()+30000,selection:{modelId:'github-copilot/'+model,format:'openai.responses'}};
 const f={env,owner,input,sent,events,ledger,policy,call,record:()=>structuredClone(owner.values.get('credential')),reply:(url)=>vendor(url,url.endsWith('/models')?{data:[row()]}:url.endsWith('/user')?{endpoints:{api:base}}:{id:'reply',model,usage:{prompt_tokens:2,completion_tokens:3,total_tokens:5}}),
 run(patch={},signal){const selected={...input,deadline:Date.now()+30000,...patch};
  const format=selected.selection.format;const requestBody=patch.body??{model,stream:false,...(format==='openai.responses'?{input:'hello'}:{messages:[{role:'user',content:'hello'}]})};
  const bytes=new TextEncoder().encode(JSON.stringify({...selected,initiator:patch.initiator??'user',body:requestBody}));let offset=0;
  const stream=new ReadableStream({type:'bytes',pull(c){if(offset<bytes.length){const end=Math.min(bytes.length,offset+16384);c.enqueue(bytes.slice(offset,end));offset=end;}else{c.close();c.byobRequest?.respond(0);}}});
  const request=new Request('https://clawrouter.internal/copilot-inference',{method:'POST',headers:{'content-type':'application/json','x-clawrouter-copilot-deadline':String(selected.deadline)},body:stream,signal,duplex:'half'});
  f.inputRequest=request;return owner.object.fetch(request);},
 async retired(){while(retained.size)await Promise.all([...retained]);},
 async policyChange(patch){Object.assign(policy,patch);await call('/policies/put',{policyId:'policy',policy});},
 mutate(fn){const r=f.record();fn(r);owner.values.set('credential',r);},
 restart(){owner.object=new GrantCredentialObject(owner.state,env);}};
 t.mock.method(globalThis,'fetch',async(request,init)=>{const url=request.url;assert.ok(url.startsWith(base+'/')||url==='https://api.github.com/copilot_internal/user');assert.equal(init.redirect,'manual');assert.equal(request.headers.get('authorization'),'Bearer synthetic-original-github-token');const body=request.method==='POST'?await request.json():null;sent.push({url,signal:init.signal,headers:request.headers,method:request.method,body});return f.reply(url,init,body);});
 return f;
}
async function body(response,status=200){const text=await response.text();assert.equal(response.status,status,text);assert.match(response.headers.get('cache-control'),/no-store/);assert.doesNotMatch(text,/synthetic-original|acquisitionBinding|apiBaseUrl|ownerBinding|copilotDeviceCredential/);return JSON.parse(text);}
const formats=['openai.chat_completions','anthropic.messages','openai.responses'];
for(const format of formats)for(const stream of [false,true])test('original owner inference '+format+' stream='+stream, {timeout:30000}, async t=>{
 const f=await fixture(t),before=f.record(),original=f.reply;
 f.reply=(url,...args)=>url.endsWith('/user')||url.endsWith('/models')?original(url,...args):vendor(url,stream?'data: {"model":"fixture-model","usage":{"prompt_tokens":2,"completion_tokens":3,"total_tokens":5}}\n\ndata: [DONE]\n\n':{id:'reply',model,usage:{prompt_tokens:2,completion_tokens:3,total_tokens:5}},{headers:{'content-type':stream?'text/event-stream':'application/json'}});
 const r=await f.run({selection:{modelId:'github-copilot/'+model,format},body:{model,stream,...(format==='openai.responses'?{input:'hello'}:{messages:[{role:'user',content:'hello'}]})}});
 if(r.status!==200)await body(r,200);assert.equal(r.status,200);assert.equal(bodyBudgetCharged(),96*MiB);const text=await r.text();assert.ok(text.includes('fixture-model'));await f.retired();assert.equal(bodyBudgetCharged(),0);
 assert.equal(f.sent.length,3);assert.equal(f.sent.filter(x=>x.method==='POST').length,1);assert.ok(f.sent.every(x=>x.signal===f.sent[0].signal));assert.equal(f.sent[2].body.model,model);assert.equal(f.sent[2].headers.get('x-initiator'),'user');assert.equal(f.events.length,1);assert.equal(f.events[0].actual_cost_micros,700);assert.equal(f.events[0].cost_basis,'policy_fixed');assert.deepEqual(f.record(),before);
 await assert.rejects(materializeGrantCredentials(f.env,key,await inspectGrantCredentials(f.env,key),'github-copilot',null,false));
});
for(const change of [{monthlyBudgetMicros:1000,requestCostMicros:null},{dailyBudgetMicros:1000,requestCostMicros:null},{weeklyBudgetMicros:1000,requestCostMicros:null}])test('unknown USD denies ALL authenticated egress '+JSON.stringify(change), {timeout:30000}, async t=>{
 const f=await fixture(t);await f.policyChange(change);await body(await f.run(),400);await f.retired();assert.equal(f.sent.length,0);assert.equal(bodyBudgetCharged(),0);
});
test('unmetered unknown cost is not known free', {timeout:30000}, async t=>{
 const f=await fixture(t);await f.policyChange({requestCostMicros:null});await body(await f.run());await f.retired();assert.equal(f.events.length,1);assert.equal(f.events[0].cost_basis,'unpriced_usage');assert.equal(f.events[0].actual_cost_micros,0);assert.equal(f.events[0].reporting_known_cost_micros,null);assert.equal(f.events[0].reporting_estimated_cost_micros,undefined);
});
for(const patch of [{body:{model:'foreign',stream:false,input:'hello'}},{body:{model,stream:false,input:'hello',previous_response_id:'old'}},{initiator:'forged'},{expectedGeneration:999},{expectedLineage:'foreign-lineage-0000'},{runtimeIdentity:{}},{accessToken:'forged'}])test('forged inference input '+JSON.stringify(patch), {timeout:30000}, async t=>{
 const f=await fixture(t);await body(await f.run(patch),409);await f.retired();assert.equal(f.sent.length,0);assert.equal(bodyBudgetCharged(),0);
});
for(const patch of [{model_picker_enabled:false},{policy:{state:'disabled'}},{policy:{state:'unconfigured'}},{policy:{}},{supported_endpoints:['/messages']}])test('model verdict denies inference '+JSON.stringify(patch), {timeout:30000}, async t=>{
 const f=await fixture(t);f.reply=url=>vendor(url,url.endsWith('/models')?{data:[row(patch)]}:{endpoints:{api:base}});await body(await f.run(),409);await f.retired();assert.equal(f.sent.length,2);assert.equal(f.events.length,1);assert.equal(f.events[0].actual_cost_micros,0);
});
test('empty catalog cannot become seed authority', {timeout:30000}, async t=>{
 const f=await fixture(t);f.reply=url=>vendor(url,url.endsWith('/models')?{data:[]}:{endpoints:{api:base}});await body(await f.run(),409);await f.retired();assert.equal(f.sent.length,2);
});
for(const change of ['generation','token','account','policy'])test('replacement after catalog forbids POST '+change, {timeout:30000}, async t=>{
 const f=await fixture(t);f.reply=async url=>{if(url.endsWith('/models')){if(change==='policy')await f.policyChange({models:[]});else f.mutate(r=>{if(change==='generation')r.generation++;if(change==='token')r.copilotDeviceCredential.accessToken='replacement';if(change==='account')r.copilotAccountAttempt.phase='cancelled';});}return vendor(url,url.endsWith('/models')?{data:[row()]}:{endpoints:{api:base}});};await body(await f.run(),409);await f.retired();assert.equal(f.sent.length,2);
});
test('reservation ACK await cannot lend a replacement key', {timeout:30000}, async t=>{
 const f=await fixture(t);await f.policyChange({monthlyBudgetMicros:1000});const fetch=f.ledger.fetch;f.ledger.fetch=async url=>{const r=await fetch(url);if(new URL(url).pathname==='/dispatch')f.mutate(r=>r.generation++);return r;};await body(await f.run(),409);await f.retired();assert.equal(f.sent.length,2);assert.equal(f.events.length,1);assert.equal(f.events[0].actual_cost_micros,0);
});
test('atomic composite contention does not start account fetch', {timeout:30000}, async t=>{
 const f=await fixture(t),other=new BodyLease();assert.ok(other.grow(MiB));await body(await f.run(),503);await f.retired();assert.equal(f.sent.length,0);assert.equal(bodyBudgetCharged(),2*MiB);other.release();const r=await f.run();assert.equal(bodyBudgetCharged(),96*MiB);const competing=new BodyLease();assert.equal(competing.grow(MiB),false);await r.body.cancel();await f.retired();assert.equal(bodyBudgetCharged(),0);assert.equal(f.events.length,1);assert.equal(f.events[0].actual_cost_micros,700);
});
for(const phase of ['account','catalog','inference'])for(const rejectCleanup of [false,true])test('held FIRST read and cancellation '+phase+' reject='+rejectCleanup, {timeout:30000}, async t=>{
 const f=await fixture(t),entered=gate(),reading=gate(),cleanup=gate(),cancelled=gate(),abort=new AbortController();let physical,cancels=0,unlocks=0;
 t.after(()=>{reading.resolve();cleanup.resolve();});const ordinary=f.reply;f.reply=(url,...args)=>{const current=url.endsWith('/user')?'account':url.endsWith('/models')?'catalog':'inference';if(current!==phase)return ordinary(url,...args);physical=vendor(url,{});const original=physical.body.getReader.bind(physical.body);physical.body.getReader=options=>{const native=original(options);return{async read(view){entered.resolve();await reading.promise;return{done:false,value:view.subarray(0,0)};},async cancel(reason){cancels++;cancelled.resolve();await native.cancel(reason);await cleanup.promise;if(rejectCleanup)throw Error('cleanup');},releaseLock(){native.releaseLock();unlocks++;}};};return physical;};
 const pending=f.run({},abort.signal);let response;if(phase==='inference'){response=await pending;const read=response.text();void read.catch(()=>{});await Promise.race([entered.promise,read.then(()=>{throw Error('delivery completed before held read');},()=>{throw Error('delivery failed before held read');})]);abort.abort();await assert.rejects(read);}else{await Promise.race([entered.promise,pending.then(async r=>{const status=r.status;await r.text();throw Error('response before held read: '+status);})]);abort.abort();await body(await pending,503);}await cancelled.promise;assert.equal(bodyBudgetCharged(),96*MiB);assert.equal(physical.body.locked,true);assert.equal(cancels,1);cleanup.resolve();await Promise.resolve();assert.equal(bodyBudgetCharged(),96*MiB);assert.equal(physical.body.locked,true);reading.resolve();await f.retired();assert.equal(bodyBudgetCharged(),0);assert.equal(unlocks,1);assert.equal(f.events.length,1);assert.equal(f.events[0].actual_cost_micros,phase==='inference'?700:0);
});
for(const phase of ['account','catalog','inference'])test('late physical response disposal '+phase, {timeout:30000}, async t=>{
 const f=await fixture(t),entered=gate(),late=gate(),cleanup=gate(),cancelled=gate(),abort=new AbortController();let physical;t.after(()=>{late.resolve();cleanup.resolve();});const ordinary=f.reply;
 f.reply=async(url,...args)=>{const current=url.endsWith('/user')?'account':url.endsWith('/models')?'catalog':'inference';if(current!==phase)return ordinary(url,...args);entered.resolve();await late.promise;physical=vendor(url,{});const get=physical.body.getReader.bind(physical.body);physical.body.getReader=options=>{const native=get(options);return{read:v=>native.read(v),async cancel(reason){cancelled.resolve();await native.cancel(reason);await cleanup.promise;},releaseLock:()=>native.releaseLock()};};return physical;};
 const pending=f.run({},abort.signal);await Promise.race([entered.promise,pending.then(async r=>{const status=r.status;await r.text();throw Error('response before held fetch: '+status);})]);abort.abort();await body(await pending,503);assert.equal(bodyBudgetCharged(),96*MiB);late.resolve();await cancelled.promise;assert.equal(physical.body.locked,true);cleanup.resolve();await f.retired();assert.equal(bodyBudgetCharged(),0);assert.equal(f.events.length,1);assert.equal(f.sent.filter(s=>s.method==='POST').length,phase==='inference'?1:0);
});
test('Copilot price guard cannot borrow a misleading LLM card and preserves fixed pricing', {timeout:30000}, async()=>{
 const {estimateCost}=await import('../proxy-accounting.ts');const endpoint={id:'responses',method:'POST',path:'/responses',request_format:'openai.responses',response_format:'openai.responses'};
 const card={id:'github-copilot/fixture-model',upstream:'fixture-model',capabilities:['llm.chat'],pricing_ref:'misleading',pricing:{inputPerMillion:1000000,outputPerMillion:1000000}};
 assert.deepEqual(estimateCost(card,{model,stream:false,input:'hello'},null,'llm.chat',endpoint,undefined,undefined,'github-copilot'),{reserveMicros:0,basis:'unpriced_request',pricingGap:'opaque_input_bound',inputTokens:null,outputTokens:null});
 assert.deepEqual(estimateCost(card,{model,stream:false,input:'hello'},700,'llm.chat',endpoint,undefined,undefined,'github-copilot'),{reserveMicros:700,basis:'policy_fixed',inputTokens:null,outputTokens:null});
});
