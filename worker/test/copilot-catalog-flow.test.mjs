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
 const values=new Map(),sent=[],retained=new Set();
 const env=attachGrantCredentialNamespace({POLICY_KV:{async get(k,type){const v=values.get(k);return v===undefined?null:type==='text'?JSON.stringify(v):structuredClone(v);},async put(k,v){values.set(k,JSON.parse(v));}}});
 const call=async(path,body)=>{const r=await env.grantAuthority.fetch('https://authority'+path,{method:'POST',body:JSON.stringify(body)});assert.equal(r.status,200,await r.text());};
 const policy={enabled:true,generation:'g1',providers:['github-copilot'],models:null};
 await call('/policies/initialize-all',[{policyId:'policy',policy}]);
 await call('/credentials/initialize-all',[{credentialId:'fixture',credential:{enabled:true,policyId:'policy',policyGeneration:'g1',principalId:null,secretSha256:await sha256Hex('abcdefgh')}}]);
 const auth=await authenticateProxyKey(new Headers({authorization:'Bearer clawrouter-live-fixture-abcdefgh'}),env);assert.equal(auth instanceof Response,false);
 await putGrantCredentials(env,key,{provider:'github-copilot',kind:'oauth',enabled:true});
 const owner=env.GRANT_CREDENTIALS.objects.get(key);owner.state.waitUntil=p=>{const work=p.catch(()=>undefined);retained.add(work);void work.finally(()=>retained.delete(work));};
 const record=owner.values.get('credential'),deviceId='device-attempt-fixture',accountId='account-attempt-fixture',acquisition='original-acquisition-binding',binding='current-account-binding',actor='original-admin-actor';
 record.status='reauth_required';record.copilotDeviceCredential={version:1,githubDomain:'github.com',ownerBinding:acquisition,accessToken:'synthetic-original-github-token'};
 record.copilotDeviceAttempt={version:1,id:deviceId,key,generation:record.generation,lineage:record.lineage,githubDomain:'github.com',actor,ownerBinding:acquisition,phase:'committed',expiresAt:1};
 const scope={key,generation:record.generation,lineage:record.lineage,deviceAttemptId:deviceId,acquisitionBinding:acquisition,githubDomain:'github.com',actor};
 record.copilotAccountAttempt={...scope,version:1,id:accountId,ownerBinding:binding,phase:'qualified'};
 record.copilotAccountBinding={...scope,version:1,accountAttemptId:accountId,ownerBinding:binding,apiBaseUrl:base,qualifiedAt:1};
 owner.values.set('credential',structuredClone(record));
 const input={key,expectedGeneration:record.generation,expectedLineage:record.lineage,deviceAttemptId:deviceId,accountAttemptId:accountId,authorization:publicControlAuthorization(auth),runtimeIdentity:{ownerBinding:binding,integrationId:'fixture',editorVersion:'Fixture/1',editorPluginVersion:'Fixture/1',userAgent:'Fixture/1'},deadline:Date.now()+30000,selection:{modelId:'github-copilot/'+model,format:'openai.responses'}};
 const f={env,owner,input,sent,policy,call,record:()=>structuredClone(owner.values.get('credential')),reply:(url)=>vendor(url,url.endsWith('/models')?{data:[row()]}:{endpoints:{api:base}}),
 run:(patch={},signal)=>env.GRANT_CREDENTIALS.get(key).fetch('https://clawrouter.internal/copilot-catalog',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...input,...patch}),signal}),
 async retired(){while(retained.size)await Promise.all([...retained]);},
 async policyChange(patch){Object.assign(policy,patch);await call('/policies/put',{policyId:'policy',policy});},
 mutate(fn){const r=f.record();fn(r);owner.values.set('credential',r);},
 restart(){owner.object=new GrantCredentialObject(owner.state,env);}};
 t.mock.method(globalThis,'fetch',async(request,init)=>{const url=request.url;assert.ok([base+'/models','https://api.github.com/copilot_internal/user'].includes(url));assert.equal(init.redirect,'manual');assert.equal(request.headers.get('authorization'),'Bearer synthetic-original-github-token');sent.push({url,signal:init.signal,headers:request.headers});return f.reply(url,init);});
 return f;
}
async function body(response,status=200){const text=await response.text();assert.equal(response.status,status,text);assert.match(response.headers.get('cache-control'),/no-store/);assert.doesNotMatch(text,/synthetic-original|acquisitionBinding|apiBaseUrl|ownerBinding|copilotDeviceCredential/);return JSON.parse(text);}
for(const format of ['openai.chat_completions','anthropic.messages','openai.responses'])test('private catalog original token and exact selection '+format,async t=>{
 const f=await fixture(t),before=f.record(),r=await f.run({selection:{modelId:'github-copilot/'+model,format}});
 assert.equal(bodyBudgetCharged(),82*MiB);const b=await body(r);assert.deepEqual(b.selection,{eligible:true,modelId:'github-copilot/'+model,upstreamId:model,format});assert.equal(b.data[0].id,model);
 assert.equal(f.sent.length,2);assert.equal(f.sent[0].signal,f.sent[1].signal);assert.equal(f.sent[1].headers.get('copilot-integration-id'),'fixture');await f.retired();assert.equal(bodyBudgetCharged(),0);assert.deepEqual(f.record(),before);
 const projection=await inspectGrantCredentials(f.env,key);assert.equal(projection.hasAccessToken,false);await assert.rejects(materializeGrantCredentials(f.env,key,projection,'github-copilot',null,false));
 f.restart();await body(await f.run());await f.retired();assert.equal(f.sent.length,4,'no catalog cache or reused verdict');
});
for(const patch of [{expectedGeneration:999},{expectedLineage:'foreign-lineage-0000'},{deviceAttemptId:'foreign-device-0000'},{accountAttemptId:'foreign-account-0000'},
 {key:'oauth/foreign/copilot'},{authorization:{kind:'collection'}},{runtimeIdentity:{}},{deadline:1},{apiBaseUrl:base},{accessToken:'forged'}])test('private catalog denies forged input '+JSON.stringify(patch),async t=>{
 const f=await fixture(t);await body(await f.run(patch),409);assert.equal(f.sent.length,0);await f.retired();assert.equal(bodyBudgetCharged(),0);
});
for(const change of ['generation','lineage','token','binding','domain','disabled','account-cancelled'])test('owner change after account forbids models '+change,async t=>{
 const f=await fixture(t);f.reply=url=>{f.mutate(r=>{if(change==='generation')r.generation++;if(change==='lineage')r.lineage='foreign-lineage-0000';if(change==='token')r.copilotDeviceCredential.accessToken='replacement';if(change==='binding')r.copilotAccountBinding.ownerBinding='replacement';if(change==='domain')r.copilotDeviceCredential.githubDomain='fixture.ghe.com';if(change==='disabled')r.enabled=false;if(change==='account-cancelled')r.copilotAccountAttempt.phase='cancelled';});return vendor(url,{endpoints:{api:base}});};
 await body(await f.run(),409);assert.equal(f.sent.length,1);await f.retired();assert.equal(bodyBudgetCharged(),0);
});
for(const patch of [{models:[]},{enabled:false},{generation:'g2'},{providers:['other']},{grantRouting:{eligibleGrants:{'github-copilot':[]}}}])test('policy tightening after parse '+JSON.stringify(patch),async t=>{
 const f=await fixture(t);f.reply=async url=>{if(url.endsWith('/models')){await f.policyChange(patch);return vendor(url,{data:[row()]});}return vendor(url,{endpoints:{api:base}});};
 const r=await f.run();const b=await body(r,patch.models?200:patch.grantRouting?409:403);if(patch.models){assert.deepEqual(b.data,[]);assert.deepEqual(b.selection,{eligible:false});}await f.retired();assert.equal(bodyBudgetCharged(),0);
});
for(const patch of [{model_picker_enabled:false},{policy:{state:'disabled'}},{policy:{state:'unconfigured'}},{policy:{}},{policy:{state:'future'}},{supported_endpoints:['/messages']}])test('catalog is not inference entitlement '+JSON.stringify(patch),async t=>{
 const f=await fixture(t);f.reply=url=>vendor(url,url.endsWith('/models')?{data:[row(patch)]}:{endpoints:{api:base}});const b=await body(await f.run());assert.equal(b.selection.eligible,false);await f.retired();assert.equal(bodyBudgetCharged(),0);
});
test('empty catalog is authoritative; policy expansion cannot widen admitted rows',async t=>{
 const f=await fixture(t);await f.policyChange({models:[]});f.reply=async url=>{if(url.endsWith('/user'))await f.policyChange({models:null});return vendor(url,url.endsWith('/models')?{data:[row()]}:{endpoints:{api:base}});};
 assert.deepEqual((await body(await f.run())).data,[]);await f.retired();f.reply=url=>vendor(url,url.endsWith('/models')?{data:[]}:{endpoints:{api:base}});assert.deepEqual((await body(await f.run())).data,[]);await f.retired();
});
for(const api of ['https://api.business.githubcopilot.com','https://foreign.example','https://api.individual.githubcopilot.com/v2'])test('fresh account destination cannot replace committed base '+api,async t=>{
 const f=await fixture(t);f.reply=url=>vendor(url,{endpoints:{api}});await body(await f.run(),api.includes('foreign')?503:409);assert.equal(f.sent.length,1);await f.retired();assert.equal(bodyBudgetCharged(),0);
});
for(const phase of ['account','catalog'])for(const mode of ['header','parse','length','encoding'])test('two-response cleanup on '+phase+' '+mode,async t=>{
 const f=await fixture(t);let selectedResponse;f.reply=url=>{const match=url.endsWith('/models')===(phase==='catalog');const r=vendor(url,match&&mode==='parse'?'{':url.endsWith('/models')?{data:[row()]}:{endpoints:{api:base}},match&&mode==='header'?{status:302}:{});if(match){selectedResponse=r;if(mode==='length')r.headers.set('content-length','999999');if(mode==='encoding')r.headers.set('content-encoding','gzip');}return r;};
 await body(await f.run(),503);await f.retired();assert.equal(selectedResponse.body.locked,false);assert.equal(bodyBudgetCharged(),0);assert.equal(f.sent.length,phase==='account'?1:2);
});
test('capacity exhaustion denies before either GET; publication owns both charges',async t=>{
 const f=await fixture(t),other=new BodyLease();assert.ok(other.grow(8*MiB));await body(await f.run(),503);assert.equal(f.sent.length,0);await f.retired();assert.equal(bodyBudgetCharged(),16*MiB);other.release();
 const r=await f.run();assert.equal(bodyBudgetCharged(),82*MiB);const contender=new BodyLease();assert.equal(contender.grow(8*MiB),false);const reader=r.body.getReader();assert.equal((await reader.read()).done,false);assert.equal(bodyBudgetCharged(),82*MiB);await reader.cancel();reader.releaseLock();await f.retired();assert.equal(bodyBudgetCharged(),0);
});
for(const phase of ['account','catalog'])for(const rejects of [false,true])test('FIRST cancellation plus independent physical read held '+phase+' '+rejects,async t=>{
 const f=await fixture(t),entered=gate(),reading=gate(),cleanup=gate(),cancelled=gate(),abort=new AbortController();let response,readers=0,cancels=0,unlocks=0;
 f.reply=url=>{if(url.endsWith('/models')!==(phase==='catalog'))return vendor(url,{endpoints:{api:base}});
 response=vendor(url,{});const original=response.body.getReader.bind(response.body);response.body.getReader=options=>{const native=original(options);return{async read(view){readers++;entered.resolve();await reading.promise;return{done:false,value:view.subarray(0,0)};},async cancel(reason){cancels++;cancelled.resolve();await native.cancel(reason);await cleanup.promise;if(rejects)throw Error('synthetic cleanup failure');},releaseLock(){native.releaseLock();unlocks++;}};};return response;};
 const pending=f.run({},abort.signal);await entered.promise;abort.abort();await body(await pending,503);await cancelled.promise;assert.equal(bodyBudgetCharged(),82*MiB);assert.equal(response.body.locked,true);assert.equal(cancels,1);
 cleanup.resolve();await Promise.resolve();assert.equal(response.body.locked,true);assert.equal(bodyBudgetCharged(),82*MiB);reading.resolve();await f.retired();assert.equal(response.body.locked,false);assert.equal(unlocks,1);assert.equal(readers,1);assert.equal(cancels,1);assert.equal(bodyBudgetCharged(),0);
});
for(const change of ['revoke','replace'])test('owner tail remains free during held physical fetch '+change,async t=>{
 const f=await fixture(t),entered=gate(),late=gate(),cleanup=gate(),cancelled=gate();let response;
 f.reply=async url=>{entered.resolve();await late.promise;response=vendor(url,{});const get=response.body.getReader.bind(response.body);response.body.getReader=options=>{const r=get(options);return{read:v=>r.read(v),async cancel(reason){cancelled.resolve();await r.cancel(reason);await cleanup.promise;},releaseLock:()=>r.releaseLock()};};return response;};
 const pending=f.run();await entered.promise;
 if(change==='revoke')await revokeGrantCredentials(f.env,key);else await putGrantCredentials(f.env,key,{provider:'github-copilot',kind:'api_key',credential:'synthetic-replacement'});
 await body(await pending,503);assert.equal(bodyBudgetCharged(),82*MiB);late.resolve();await cancelled.promise;assert.equal(response.body.locked,true);cleanup.resolve();await f.retired();assert.equal(bodyBudgetCharged(),0);assert.equal(f.sent.length,1);
});
