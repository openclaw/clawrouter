import assert from "node:assert/strict";
import test from "node:test";
import {readFileSync} from "node:fs";
import {parse} from "yaml";
import {compileProviderSnapshot} from "../../scripts/compile-providers.mjs";
import snapshot from "../generated/provider-snapshot.json" with {type:"json"};
import {startBifrostFixture,finishBifrostOwned,assertBifrostRetired,bifrostKey,bifrostDiscoveryKey} from "../../test/openclaw-bifrost.test.mjs";
const source=parse(readFileSync(new URL("../../providers/bifrost.provider.yaml",import.meta.url),"utf8"));
const compiled=snapshot.providers.find(p=>p.id==='bifrost'),catalog=ids=>({object:'list',data:ids.map(id=>({id,object:'model'}))});
const selected='tenant/opaque-a';
let count=0;
async function run(t,mode,body,base,{workerDeadline=false}={}){
 let application;
 const f=await startBifrostFixture({hotCache:mode.startsWith('warm_')}),id='worker_bifrost_'+(++count);
 const request=async(manifest=false,suffix='',options={})=>{
  const response=await fetch(f.origin+(manifest==='versioned'?'/v1/native/bifrost/v1/models':manifest?'/v1/proxy/bifrost/models_list':'/v1/native/bifrost/models')+suffix,{headers:{authorization:'Bearer '+bifrostKey(id),'x-api-key':'synthetic-caller-key','x-upstream-url':'https://foreign.example'},...options});
  const text=await response.text();application={status:response.status,body:JSON.parse(text),cache:response.headers.get('cache-control')};return application;
 };
 let proof;await finishBifrostOwned(async()=>{await f.setup({id,mode,base,workerDeadline});await body({f,id,request});},[async()=>{proof=await f.join(id);assertBifrostRetired(proof,{workerDeadline,application});},()=>f.close()]);return proof;
}
test('Bifrost shipping declaration preserves original Chat/card/auth and FIRST capability bindings',()=>{
 assert.deepEqual(compileProviderSnapshot([source]).providers,[compiled]);
 assert.equal(compiled.base_urls.default,'${base_url}');assert.deepEqual(compiled.config_keys,['BIFROST_API_KEY','BIFROST_BASE_URL','BIFROST_MODEL']);
 assert.equal(compiled.capabilities.find(c=>c.id==='models.list').endpoint,'models_list');assert.equal(compiled.capabilities.find(c=>c.id==='llm.chat').endpoint,'chat_completions');
 assert.equal(compiled.endpoints.find(e=>e.id==='chat_completions').path,'/chat/completions');
 assert.equal(compiled.models.length,1);assert.equal(compiled.models[0].upstream,'${model}');assert.equal(compiled.models[0].pricing,null);
 for(const [id,path] of [['models_list_v1','/models'],['chat_completions_v1','/chat/completions']])assert.equal(compiled.endpoints.find(e=>e.id===id).upstreamPath,path);
});
for(const manifest of [false,true]){
 const label=manifest?'manifest':'native';
 test(`Bifrost ${label} original owner, configured destination, bodyless metadata and SQLite`,async t=>{
  const proof=await run(t,'eof',async({request})=>{const r=await request(manifest);assert.equal(r.status,200);assert.deepEqual(r.body,catalog([selected]));assert.match(r.cache,/private, no-store/);});
  assert.equal(proof.calls.length,1);assert.equal(proof.calls[0].url,'https://gateway.fixture/openai/v1/models');assert.equal(proof.calls[0].method,'GET');assert.equal(proof.calls[0].bodyAbsent,true);
  assert.equal(proof.events.length,1);assert.equal(proof.events[0].actual_cost_micros,0);assert.equal(proof.events[0].reserved_cost_micros,0);assert.equal(proof.events[0].model,null);
 });
 test(`Bifrost ${label} caller query and body overrides fail before egress`,async t=>{
  const proof=await run(t,'eof',async({request,id})=>{
   for(const suffix of ['?limit=1','?after_id=hidden','?model=hidden','?url=https://foreign.example','?api_key=synthetic'])assert.equal((await request(manifest,suffix)).status,400);
   const r=await request(manifest,'',{method:'POST',body:JSON.stringify({body:{account:'foreign'}}),headers:{authorization:'Bearer '+bifrostKey(id),'content-type':'application/json'}});assert.equal(r.status,manifest?400:405);
  });assert.equal(proof.calls.length,0);
 });
 test(`Bifrost ${label} authoritative empty and malformed/loose envelopes`,async t=>{
  for(const mode of ['empty','malformed','loose','wrong_object'])await run(t,mode,async({request})=>{const r=await request(manifest);assert.equal(r.status,mode==='empty'?200:502);if(mode==='empty')assert.deepEqual(r.body,catalog([]));else assert.equal(r.body.error.code,'invalid_model_discovery_response');});
 });
 for(const mode of ['held_narrow','held_revoke','warm_revoke','warm_destination','held_broaden','held_destination','held_subset','revoked'])test(`Bifrost ${label} ${mode} keeps original authority`,async t=>{
  const proof=await run(t,mode,async({request,f,id})=>{
   if(mode.startsWith('warm_')){assert.equal((await request(manifest)).status,200);await f.mutate(id,mode.replace('warm_','arm_'));}
   if(mode==='revoked')await f.mutate(id,'revoke');
   const r=await request(manifest);
   if(mode==='held_narrow'){assert.equal(r.status,200);assert.deepEqual(r.body,catalog([]));}
   else if(['held_broaden','held_subset'].includes(mode)){assert.equal(r.status,200);assert.deepEqual(r.body,catalog([selected]));}
   else {assert.ok(r.status>=400);assert.equal(JSON.stringify(r.body).includes('synthetic-owner'),false);assert.equal(JSON.stringify(r.body).includes(selected),false);}
  });assert.equal(proof.calls.length,mode==='revoked'?0:1);if(mode.startsWith('warm_'))assert.equal(proof.inspected,true);if(mode.startsWith('held_')){assert.equal(proof.prefix,true);assert.equal(proof.mutated,true);assert.equal(proof.source.settled,1);}
 });
}
test('Bifrost missing managed owner cannot borrow configured environment credentials',async t=>{
 const proof=await run(t,'missing_owner',async({request})=>assert.ok((await request()).status>=400));assert.equal(proof.calls.length,0);
});
test('Bifrost retains custom configured base without implicit version rewriting',async t=>{
 const proof=await run(t,'eof',async({request})=>assert.equal((await request()).status,200),'https://gateway.fixture/custom/openai');assert.equal(proof.calls[0].url,'https://gateway.fixture/custom/openai/models');
});
test('Bifrost versioned native aliases reach original upstream endpoints without rewriting client URLs',async t=>{
 const proof=await run(t,'eof',async({request})=>{const r=await request('versioned');assert.equal(r.status,200);assert.deepEqual(r.body,catalog([selected]));});assert.equal(proof.calls[0].url,'https://gateway.fixture/openai/v1/models');
});
for(const mode of ['error401','error403','redirect','invalid_owner'])test('Bifrost '+mode+' preserves failure without alternate owner or replay',async t=>{
 const proof=await run(t,mode,async({request})=>{const r=await request();assert.equal(r.status,mode==='error401'?401:mode==='error403'?403:mode==='redirect'?502:503);});assert.equal(proof.calls.length,mode==='invalid_owner'?0:1);
});

test('Bifrost shipping 30-second deadline cancels an incomplete original response without publication', {timeout:40000},async t=>{
 const proof=await run(t,'deadline',async({request})=>{const r=await request();assert.equal(r.status,502);assert.equal(JSON.stringify(r.body).includes(selected),false);},undefined,{workerDeadline:true});
 assert.equal(proof.calls.length,1);assert.equal(proof.source.canceled,1);assert.equal(proof.source.settled,1);assert.equal(proof.source.expired,0);
});

for(const mode of ['account_a','account_b','rotation','unpriced'])test('Bifrost distinct discovery/inference credentials and opaque native routing: '+mode,async t=>{
 const proof=await run(t,mode,async({f,id})=>{
  const catalogResponse=await fetch(f.origin+'/v1/native/bifrost/v1/models',{headers:{authorization:'Bearer '+bifrostDiscoveryKey(id)}});
  const catalogBody=await catalogResponse.json();assert.equal(catalogResponse.status,200);assert.equal(catalogBody.data.length,1);
  const model=catalogBody.data[0].id;assert.equal(model,mode==='account_b'?'tenant/opaque-b':'tenant/opaque-a');
  if(mode==='rotation')await f.mutate(id,'rotation');
  const response=await fetch(f.origin+'/v1/native/bifrost/v1/chat/completions',{method:'POST',headers:{authorization:'Bearer '+bifrostKey(id),'content-type':'application/json'},body:JSON.stringify({model,messages:[{role:'user',content:'synthetic fixture'}],stream:true,max_tokens:16})});
  const text=await response.text();assert.equal(response.status,mode==='unpriced'?400:200);
  if(mode==='unpriced')assert.equal(JSON.parse(text).error.code,'pricing_required');else assert.ok(text.includes('synthetic-prefix'));
 });
 assert.equal(proof.source.calls.filter(c=>c.chat).length,mode==='unpriced'?0:1);
 const metadata=proof.events.find(e=>e.capability==='models.list'),inference=proof.events.find(e=>e.capability==='llm.chat');assert.ok(metadata);assert.ok(inference);
 assert.notEqual(metadata.credential_id,inference.credential_id);assert.equal(metadata.actual_cost_micros,0);assert.equal(inference.reporting_known_cost_micros,null);
 if(mode!=='unpriced'){assert.equal(inference.actual_cost_micros,7);assert.equal(inference.cost_basis,'policy_fixed');assert.equal(inference.total_tokens,7);assert.equal(inference.model,mode==='account_b'?'tenant/opaque-b':'tenant/opaque-a');}
 else {assert.equal(inference.reserved_cost_micros,0);assert.equal(inference.actual_cost_micros,0);}
 if(mode==='rotation')assert.equal(proof.calls.filter(c=>c.method==='POST')[0].rotated,true);
});
