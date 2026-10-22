import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startWorkerdFixture } from '../../test/helpers/workerd.mjs';

// Only test control routes wrap production. Auth, grant selection/owner,
// transport, policy, parsing and accounting run unchanged in workerd/SQLite.
const router = `
import worker, { PolicyBindingIndexObject, BudgetLedgerObject, UsageLedgerObject, GrantCredentialObject } from './worker/index.ts';
import { putGrantCredentials, revokeGrantCredentials } from './worker/grant-credentials.ts';
import { snapshot } from './worker/providers.ts';
export { PolicyBindingIndexObject, BudgetLedgerObject, UsageLedgerObject, GrantCredentialObject };
export default { ...worker, async fetch(request, env, context) {
 const path = new URL(request.url).pathname;
 if (path === '/fixture/object') { const b = await request.json(); const ns = env[b.binding]; return ns.get(ns.idFromName(b.name)).fetch('https://authority'+b.path, {method:'POST',body:JSON.stringify(b.value)}); }
 if (path === '/fixture/grant') { const b = await request.json(); return Response.json(b.revoke ? await revokeGrantCredentials(env,b.key) : await putGrantCredentials(env,b.key,b.grant)); }
 if (path === '/fixture/upstream') return fetch('https://upstream/fixture', {method:'POST',body:request.body});
 if (path === '/fixture/decision-only') { const model=snapshot.providers.find(p=>p.id==='openai').models.find(m=>m.id==='openai/gpt-6-luna'); if(!model.nativeCapabilities?.endpoints.decisions) return new Response('missing Decisions declaration',{status:500}); model.capabilities=['llm.decisions']; model.nativeCapabilities.endpoints={decisions:model.nativeCapabilities.endpoints.decisions}; delete model.requestParameters; return new Response('ok'); }
 return worker.fetch(request,env,context);
}, async queue(batch) {
 await fetch('https://upstream/events', {method:'POST',body:JSON.stringify(batch.messages.map(m=>m.body))}); batch.ackAll();
} };
`;
const upstream = `
export class Upstream {
 constructor(state) { this.storage=state.storage; }
 async fetch(request) {
 const path=new URL(request.url).pathname;
 if(path==='/fixture') { const b=await request.json(); if(b.replies) await this.storage.put('replies',b.replies); return Response.json({calls:await this.storage.get('calls')??[],events:await this.storage.get('events')??[]}); }
 if(path==='/events') { await this.storage.put('events',[...await this.storage.get('events')??[],...await request.json()]); return new Response('ok'); }
 const calls=await this.storage.get('calls')??[];
 calls.push({url:request.url,method:request.method,headers:Object.fromEntries(request.headers),body:await request.text()}); await this.storage.put('calls',calls);
 const replies=await this.storage.get('replies')??[], reply=replies.length>1?replies.shift():replies[0]; await this.storage.put('replies',replies);
 if(reply?.disconnect) throw new Error('synthetic upstream failure');
 return new Response(reply?.wire??JSON.stringify(reply?.body??{}),{status:reply?.status??200,headers:{'content-type':'application/json','x-request-id':'upstream-fixture',...reply?.headers}});
 }
}
export default {fetch(request,env){return env.UPSTREAM.get(env.UPSTREAM.idFromName('fixture')).fetch(request);}};
`;
const openai = id => ({ id, object:'model', created:123, owned_by:'fixture-org' });
const anthropic = id => ({ id, type:'model', display_name:id, created_at:'2026-01-01T00:00:00Z', capabilities:{batch:{supported:true}}, max_input_tokens:100, max_tokens:20 });
const page = (data, has_more=false) => ({data,first_id:data[0]?.id??null,last_id:data.at(-1)?.id??null,has_more});
const authorization='Bearer clawrouter-live-fixture-fixture-key';
async function fixture(t) {
 const temporary=await mkdtemp(join(tmpdir(),'cr-model-discovery-'));
 const mf=await startWorkerdFixture(temporary,router,upstream,{upstreamDurableObjects:{UPSTREAM:{className:'Upstream',useSQLite:true}}});
 t.after(async()=>{await mf.dispose();await rm(temporary,{recursive:true,force:true});});
 const call=(path,init={})=>mf.dispatchFetch('https://router.example'+path,{...init,headers:{authorization,...init.headers}});
 const object=async(path,value)=>{const r=await call('/fixture/object',{method:'POST',body:JSON.stringify({binding:'ACCESS_CONTROL',name:'policy-bindings',path,value})});assert.equal(r.status,200,await r.clone().text());return r.text();};
 const policy={enabled:true,generation:'g1',providers:['openai','anthropic'],tenantId:'tenant',requestCostMicros:999,retainRequestContent:false};
 const credential={enabled:true,policyId:'fixture',policyGeneration:'g1',secretSha256:createHash('sha256').update('fixture-key').digest('hex')};
 await object('/policies/initialize-all',[{policyId:'fixture',policy}]);
 await object('/credentials/initialize-all',[{credentialId:'fixture',credential}]);
 await object('/connections/initialize-all',[{providerId:'openai',enabled:true},{providerId:'anthropic',enabled:true}]);
 const grant=async(provider,kind='api_key',revoke=false)=>{const r=await call('/fixture/grant',{method:'POST',body:JSON.stringify({key:'oauth/fixture/'+provider,revoke,grant:{provider,kind,enabled:true,credential:'synthetic-'+provider+'-key',...(kind==='api_key'?{}:{accessToken:'synthetic-subscription-token'})}})});assert.equal(r.status,200,await r.clone().text());return r.json();};
 await grant('openai');await grant('anthropic');
 const state=async(replies)=>{const r=await call('/fixture/upstream',{method:'POST',body:JSON.stringify(replies?{replies}:{})});return r.json();};
 return {call,object,policy,credential,grant,state,reply:body=>state([{body}]),async updatePolicy(change){Object.assign(policy,change);await object('/policies/put',{policyId:'fixture',policy});},async events(count){for(let n=0;n<100;n++){const s=await state();if(s.events.length>=count)return s.events;await new Promise(r=>setTimeout(r,20));}assert.fail('usage events not collected');}};
}

test('native discovery and manifest envelopes use selected API-key grants, preserve metadata and settle zero',async t=>{
 const f=await fixture(t);let expected=0;
 for(const provider of ['openai','anthropic']) {
  const model=provider==='openai'?openai('custom:fixture'):anthropic('custom-fixture');
  const list=provider==='openai'?{object:'list',data:[model]}:page([model]);
  for(const [path,init,body] of [
   ['/v1/native/'+provider+'/v1/models',{},list],
   ['/v1/native/'+provider+'/v1/models/'+model.id,{},model],
   ['/v1/proxy/'+provider+'/models_list',{},list],
   ['/v1/proxy/'+provider+'/models_retrieve?model_id='+encodeURIComponent(model.id),{},model],
   ['/v1/proxy/'+provider+'/models_retrieve',{method:'POST',body:JSON.stringify({method:'GET',pathParams:{model_id:model.id}})},model],
   ['/v1/models/'+encodeURIComponent(provider+'/'+model.id),{},model],
  ]) {
   await f.reply(body);const r=await f.call(path,{...init,headers:{'content-type':'application/json','anthropic-version':'2023-06-01','anthropic-beta':'fixture-beta','anthropic-workspace-id':'workspace-fixture','OpenAI-Project':'project-fixture'}});
   assert.equal(r.status,200,await r.clone().text());assert.deepEqual(await r.json(),body);assert.match(r.headers.get('cache-control'),/no-store/);
   const sent=(await f.state()).calls.at(-1);assert.equal(sent.method,'GET');assert.equal(sent.body,'');assert.equal(new URL(sent.url).origin,provider==='openai'?'https://api.openai.com':'https://api.anthropic.com');
   assert.equal(sent.headers[provider==='openai'?'authorization':'x-api-key'],provider==='openai'?'Bearer synthetic-openai-key':'synthetic-anthropic-key');
   assert.ok(!JSON.stringify(sent).includes('clawrouter-live'));assert.ok(!JSON.stringify(sent).includes('synthetic-subscription'));
   if(provider==='anthropic'){assert.equal(sent.headers['anthropic-workspace-id'],'workspace-fixture');assert.equal(sent.headers['anthropic-beta'],'fixture-beta');}
   else assert.equal(sent.headers['openai-project'],'project-fixture');
   expected++;const event=(await f.events(expected)).at(-1);assert.equal(event.actual_cost_micros,0);assert.equal(event.reserved_cost_micros,0);assert.equal(event.grant_key,'oauth/fixture/'+provider);assert.equal(event.cost_basis,'none');
  }
 }
});

test('filtered discovery conceals denied rows/cursors; retrieve denies before egress; aggregate catalog stays separate',async t=>{
 const f=await fixture(t);await f.updatePolicy({models:['openai/gpt-6-astra','anthropic/claude-sonnet-4-6']});
 await f.reply({object:'list',data:[openai('blocked-private'),openai('gpt-6-astra')]});
 const r=await f.call('/v1/native/openai/v1/models');assert.equal(r.status,200,await r.clone().text());assert.deepEqual(await r.json(),{object:'list',data:[openai('gpt-6-astra')]});
 await f.state([{body:page([anthropic('hidden-new')],true)},{body:page([anthropic('claude-sonnet-4-6'),anthropic('hidden-old')],true)}]);
 const a=await f.call('/v1/native/anthropic/v1/models?limit=2&lifecycle%5B%5D=active&lifecycle%5B%5D=deprecated');assert.equal(a.status,200,await a.clone().text());assert.deepEqual(await a.json(),page([anthropic('claude-sonnet-4-6')],true));
 const calls=(await f.state()).calls;assert.equal(calls.length,3);assert.equal(new URL(calls.at(-1).url).searchParams.get('after_id'),'hidden-new');assert.deepEqual(new URL(calls.at(-1).url).searchParams.getAll('lifecycle[]'),['active','deprecated']);
 for(const path of ['/v1/native/openai/v1/models/blocked-private','/v1/native/anthropic/v1/models?after_id=hidden-new']){const denied=await f.call(path);assert.equal(denied.status,403);assert.equal((await f.state()).calls.length,3);}
 await f.reply(anthropic('blocked-resolved-alias'));
 const alias=await f.call('/v1/native/anthropic/v1/models/claude-sonnet-4-6');assert.equal(alias.status,403);assert.ok(!(await alias.text()).includes('blocked-resolved-alias'));
 const before=(await f.state()).calls.length;
 const catalog=await f.call('/v1/catalog');assert.equal(catalog.status,200,await catalog.clone().text());const c=await catalog.json();
 for(const provider of c.providers){const offers=provider.offers.filter(o=>o.endpoint.startsWith('models_'));assert.ok(offers.length);assert.ok(offers.every(o=>o.affordability==='exact-covered'&&o.modelId===null));}
 const aggregate=await f.call('/v1/models');assert.equal(aggregate.status,200);const aggregateBody=await aggregate.json();assert.ok(aggregateBody.data.some(m=>m.id==='openai/gpt-6-astra'));assert.equal((await f.state()).calls.length,before);
});

test('revocation, provider policy, unsupported transports, malformed input and DELETE cannot reach upstream',async t=>{
 const f=await fixture(t);await f.reply({object:'list',data:[]});
 for(const [path,init,status] of [
  ['/v1/native/openai/v1/models', {headers:{authorization:'Bearer invalid'}},401],
  ['/v1/native/openai/v1/models/a',{method:'DELETE'},405],
  ['/v1/native/openai/v1/models/%E0%A4',{},400],
  ['/v1/proxy/openai/models_retrieve',{},400],
  ['/v1/proxy/openai/models_list',{method:'POST',body:JSON.stringify({method:'DELETE'})},405],
  ['/v1/proxy/openai/models_list',{method:'POST',body:JSON.stringify({body:{model:'unexpected'}})},400],
  ['/v1/models/ambiguous',{},400],
 ]) {const r=await f.call(path,init);assert.equal(r.status,status,path+': '+await r.text());}
 await f.updatePolicy({providers:['anthropic']});assert.equal((await f.call('/v1/native/openai/v1/models')).status,403);
 await f.updatePolicy({providers:['openai','anthropic']});
 for(const kind of ['subscription','oauth']){await f.grant('anthropic',kind);const r=await f.call('/v1/native/anthropic/v1/models');assert.equal(r.status,503,await r.clone().text());}
 await f.grant('openai','api_key',true);assert.equal((await f.call('/v1/native/openai/v1/models')).status,400,'revoked scoped grant cannot fall back to environment key');
 await f.object('/credentials/mutate',{credentialId:'fixture',operation:'revoke',scope:'admin',actor:{auth:'admin_token',role:'admin',email:'admin@example.test'}});assert.equal((await f.call('/v1/native/anthropic/v1/models')).status,403);
 assert.equal((await f.state()).calls.length,0);
});

test('upstream rejection/rate limit, malformed replies and transport failure remain nonbillable',async t=>{
 const f=await fixture(t);let count=0;
 for(const reply of [{status:404,body:{error:{message:'synthetic absent'}}},{wire:'{broken'},{disconnect:true},{status:429,body:{error:{message:'synthetic rate limited'}},headers:{'retry-after':'2'}}]){
  await f.state([reply]);const r=await f.call('/v1/native/openai/v1/models');assert.equal(r.status,reply.status??502);await r.text();count++;const e=(await f.events(count)).at(-1);assert.equal(e.actual_cost_micros,0);assert.equal(e.reserved_cost_micros,0);
 }
});


test('filtered reverse pagination, terminal emptiness and bounded/cyclic scans never leak hidden IDs', async t => {
 const f=await fixture(t); await f.updatePolicy({models:['anthropic/claude-sonnet-4-6']});
 await f.state([{body:page([anthropic('hidden-near')],true)},{body:page([anthropic('claude-sonnet-4-6')])}]);
 const reverse=await f.call('/v1/native/anthropic/v1/models?before_id=claude-sonnet-4-6');
 assert.equal(reverse.status,200); assert.deepEqual(await reverse.json(),page([anthropic('claude-sonnet-4-6')]));
 assert.equal(new URL((await f.state()).calls.at(-1).url).searchParams.get('before_id'),'hidden-near');
 await f.reply(page([anthropic('hidden-terminal')]));
 const empty=await f.call('/v1/native/anthropic/v1/models'); assert.deepEqual(await empty.json(),page([]));
 await f.reply(page([anthropic('hidden-cycle')],true));
 const cycle=await f.call('/v1/native/anthropic/v1/models'); assert.equal(cycle.status,502); assert.ok(!(await cycle.text()).includes('hidden-cycle'));
 const before=(await f.state()).calls.length;
 await f.state(Array.from({length:32},(_,n)=>({body:page([anthropic('hidden-'+n)],true)})));
 const bounded=await f.call('/v1/native/anthropic/v1/models'); assert.equal(bounded.status,502); assert.equal((await f.state()).calls.length-before,32);
 await f.state([{status:404,body:{error:{message:'hidden-error-model'}}}]);
 const rejected=await f.call('/v1/native/anthropic/v1/models'); assert.equal(rejected.status,404); assert.ok(!(await rejected.text()).includes('hidden-error-model'));
});

test('opaque upstream IDs, strict query validation, zero-cost budget modes and grant cooldown use production gates', async t => {
 const f=await fixture(t), id='ft:private/slash?hash#percent%'; await f.reply(openai(id));
 const opaque=await f.call('/v1/native/openai/v1/models/'+encodeURIComponent(id)); assert.equal(opaque.status,200); assert.equal((await opaque.json()).id,id);
 const url=new URL((await f.state()).calls.at(-1).url); assert.equal(url.pathname,'/v1/models/'+encodeURIComponent(id)); assert.equal(url.search,'');
 const before=(await f.state()).calls.length;
 for(const suffix of ['?unexpected=a','?limit=0','?limit=1001','?lifecycle[]=unknown','?lifecycle[]=active&lifecycle[]=active&lifecycle[]=active&lifecycle[]=active','?before_id=a&after_id=b']) {
  const bad=await f.call('/v1/native/anthropic/v1/models'+suffix); assert.equal(bad.status,400,await bad.text());
 }
 assert.equal((await f.state()).calls.length,before);
 for(const budgetMode of ['hard','soft']) {
  await f.updatePolicy({budgetMode,monthlyBudgetMicros:1000}); await f.reply({object:'list',data:[]});
  const response=await f.call('/v1/native/openai/v1/models'); assert.equal(response.status,200); await response.text();
  const catalog=await (await f.call('/v1/catalog')).json(); assert.ok(catalog.providers.find(p=>p.id==='openai').offers.filter(o=>o.endpoint.startsWith('models_')).every(o=>o.affordability==='exact-covered'));
 }
 await f.updatePolicy({monthlyBudgetMicros:0}); const denied=await f.call('/v1/native/openai/v1/models'); assert.equal(denied.status,402);
 await f.updatePolicy({monthlyBudgetMicros:1000});
 await f.state([{status:429,body:{error:{message:'rate limited'}},headers:{'retry-after':'60'}}]);
 const limited=await f.call('/v1/native/openai/v1/models'); assert.equal(limited.status,429); assert.equal(limited.headers.get('retry-after'),'60'); await limited.text();
 const calls=(await f.state()).calls.length; await f.events(5);
 const cooldown=await f.call('/v1/native/openai/v1/models'); assert.equal(cooldown.status,429,await cooldown.clone().text()); assert.equal((await f.state()).calls.length,calls);
 const c=await (await f.call('/v1/catalog')).json(); assert.ok(c.providers.find(p=>p.id==='openai').offers.filter(o=>o.endpoint.startsWith('models_')).every(o=>!o.eligible));
 const events=(await f.state()).events; assert.ok(events.every(e=>e.actual_cost_micros===0&&e.reserved_cost_micros===0));
});


test('metadata parsing fails closed on oversized/non-model payloads and rewritten JSON has no stale representation headers', async t => {
 const f=await fixture(t);
 for(const body of [{data:[{not_id:'missing'}],object:'list'},{data:[],object:'not-list'},{data:[],object:'list',padding:'x'.repeat(2*1024*1024)}]) {
  await f.reply(body); const rejected=await f.call('/v1/native/openai/v1/models'); assert.equal(rejected.status,502); await rejected.text();
 }
 await f.updatePolicy({models:['openai/gpt-6-astra']});
 await f.state([{body:{object:'list',data:[openai('gpt-6-astra'),openai('private-hidden')]},headers:{etag:'private-hidden',location:'/private-hidden','last-modified':'Wed, 01 Jan 2025 00:00:00 GMT','cache-control':'public, max-age=3600'}}]);
 const safe=await f.call('/v1/native/openai/v1/models'); assert.equal(safe.status,200); assert.equal(safe.headers.get('etag'),null); assert.equal(safe.headers.get('location'),null); assert.equal(safe.headers.get('last-modified'),null); assert.match(safe.headers.get('cache-control'),/private, no-store/); assert.ok(!(await safe.text()).includes('private-hidden'));
 const events=await f.events(4); assert.ok(events.every(e=>e.actual_cost_micros===0));
});


test('Decisions catalog composes with opaque native and manifest model metadata', async t => {
 const f=await fixture(t);
 const catalogResponse=await f.call('/v1/catalog'); assert.equal(catalogResponse.status,200);
 const provider=(await catalogResponse.json()).providers.find(p=>p.id==='openai');
 const luna=provider.models.find(m=>m.id==='openai/gpt-6-luna');
 assert.ok(luna.capabilities.includes('llm.decisions'));
 assert.equal(luna.nativeCapabilities.endpoints.decisions.inference.chat,false);
 assert.equal(luna.nativeCapabilities.endpoints.decisions.inference.decision.limits.maxQuestions,400);
 assert.ok(provider.offers.some(o=>o.modelId===luna.id&&o.endpoint==='decisions'&&o.eligible));
 const aggregate=await (await f.call('/v1/models')).json();
 assert.ok(aggregate.data.find(m=>m.id===luna.id).capabilities.includes('llm.decisions'));
 const decisionOnly={...openai('fixture-decisions-only'),inference:{chat:false,decision:true}};
 await f.updatePolicy({models:['openai/'+decisionOnly.id]});
 const list={object:'list',data:[decisionOnly]};
 let expected=0;
 for(const [path,body] of [
  ['/v1/native/openai/v1/models',list],
  ['/v1/native/openai/v1/models/'+decisionOnly.id,decisionOnly],
  ['/v1/proxy/openai/models_list',list],
  ['/v1/proxy/openai/models_retrieve?model_id='+decisionOnly.id,decisionOnly],
 ]) {
  await f.reply(body); const response=await f.call(path); assert.equal(response.status,200,await response.clone().text());
  assert.deepEqual(await response.json(),body,'upstream metadata must not acquire inferred Chat/Responses capability claims');
  const call=(await f.state()).calls.at(-1); assert.equal(call.method,'GET'); assert.equal(call.body,'');
  assert.equal(call.headers.authorization,'Bearer synthetic-openai-key');
  expected++; const event=(await f.events(expected)).at(-1); assert.equal(event.actual_cost_micros,0); assert.equal(event.reserved_cost_micros,0);
 }
 const scopedCatalog=await (await f.call('/v1/catalog')).json();
 assert.deepEqual(scopedCatalog.providers.find(p=>p.id==='openai').models,[],'grant metadata is not a fabricated local inference declaration');
 assert.deepEqual((await (await f.call('/v1/models')).json()).data,[]);
 assert.equal((await f.state()).calls.length,4,'local catalog projection must not call upstream');
});


test('decision-only catalog rows never gain Chat or Responses capabilities', async t => {
 const f=await fixture(t); await f.updatePolicy({models:['openai/gpt-6-luna']});
 // Only the compiled declaration is synthetic; authorization, grant/budget
 // eligibility, native-capability projection and catalog serialization stay real.
 const configured=await f.call('/fixture/decision-only',{method:'POST'}); assert.equal(configured.status,200,await configured.text());
 const response=await f.call('/v1/catalog'); assert.equal(response.status,200);
 const view=(await response.json()).providers.find(p=>p.id==='openai');
 assert.deepEqual(view.models.map(m=>({id:m.id,capabilities:m.capabilities})),[{id:'openai/gpt-6-luna',capabilities:['llm.decisions']}]);
 assert.deepEqual(Object.keys(view.models[0].nativeCapabilities.endpoints),['decisions']);
 const offers=view.offers.filter(o=>o.modelId==='openai/gpt-6-luna'); assert.ok(offers.length>0);
 assert.ok(offers.every(o=>o.endpoint==='decisions'&&o.eligible));
 const models=await (await f.call('/v1/models')).json();
 assert.deepEqual(models.data.map(m=>({id:m.id,capabilities:m.capabilities})),[{id:'openai/gpt-6-luna',capabilities:['llm.decisions']}]);
 assert.equal((await f.state()).calls.length,0,'local compiled capability projection must not probe upstream');
});
