import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startWorkerdFixture } from "../../test/helpers/workerd.mjs";

// Only credentials/configuration and the synthetic upstream are fixtures. Ingress,
// manifest/native selection, authorization and URL construction run unmodified.
const router = `
 import worker from "./worker/index.ts";
 export * from "./worker/index.ts";
 import { sha256Hex } from "./worker/utils.ts";
 import { providerById } from "./worker/providers.ts";
 export default { ...worker, async fetch(request, env, context) {
  const url = new URL(request.url);
  if (url.pathname === "/fixture/setup") {
   const options = await request.json();
   if (options.queryCredential) { const provider = providerById("openai"); provider.auth.schemes = [{type:"query_api_key",param:"api_key",secretKind:"api_key"}]; provider.adapter.injectQuery.region = "operator-region"; }
   const stub = env.ACCESS_CONTROL.get(env.ACCESS_CONTROL.idFromName("policy-bindings"));
   for (const [path, body] of [
    ["/policies/initialize-all", [{policyId:"fixture",policy:{enabled:true,generation:"g1",providers:options.providers ?? ["openai","replicate","azure-openai","anthropic"],tenantId:"tenant",monthlyBudgetMicros:null,retainRequestContent:false}}]],
    ["/credentials/initialize-all", [{credentialId:"fixture",credential:{enabled:!options.revoked,secretSha256:await sha256Hex("fixture-key"),policyId:"fixture",policyGeneration:"g1"}}]],
    ["/connections/initialize-all", ["openai","replicate","azure-openai","anthropic"].map(providerId=>({providerId,enabled:true,monthlyBudgetMicros:null}))],
   ]) { const result = await stub.fetch("https://owner"+path,{method:"POST",body:JSON.stringify(body)}); if(!result.ok) return result; }
   if (options.fusion) await env.POLICY_KV.put("config/fusion",JSON.stringify({enabled:true,adviserModels:["openai/gpt-4.1-mini"],aggregatorModel:"openai/gpt-4.1-mini"}));
   return Response.json({ok:true});
  }
  if (url.pathname === "/fixture/config") { providerById("openai").endpoints.find(endpoint=>endpoint.id==="responses").query.fixture_config = (await request.json()).version; return Response.json({ok:true}); }
  if (url.pathname === "/fixture/calls") return fetch("https://fixture.example/calls");
  const configured = {...env, ...(request.headers.has("x-fixture-rotate") ? {OPENAI_API_KEY:"fixture-rotated-key"} : {}), REPLICATE_API_TOKEN:"fixture-replicate-key", ANTHROPIC_API_KEY:"fixture-anthropic-key", AZURE_OPENAI_API_KEY:"fixture-azure-key", AZURE_OPENAI_ENDPOINT:"https://fixture.openai.azure.com", ...(request.headers.has("x-fixture-missing-config") ? {} : {AZURE_OPENAI_API_VERSION:"configured-version"})};
  return worker.fetch(request, configured, context);
 }};
`;
const upstream = `
 export class Wire {
  constructor(state) { this.storage = state.storage; }
  async fetch(request) {
   const calls = await this.storage.get("calls") ?? [];
   if (request.url === "https://fixture.example/calls") return Response.json(calls);
   const call = {url:request.url,method:request.method,body:await request.text(),authorization:request.headers.get("authorization"),apiKey:request.headers.get("api-key")};
   calls.push(call); await this.storage.put("calls",calls);
   const path = new URL(request.url).pathname;
   const response = path.startsWith("/v1/responses") ? {object:"response",id:path==="/v1/responses" ? "resp_"+calls.length : path.split("/")[3],status:"completed",output:[]} : {};
   return Response.json({...call, ...response, choices:[{message:{content:"synthetic adviser output"}}], usage:{input_tokens:1,output_tokens:1,total_tokens:2}});
  }
 }
 export default {fetch(request,env) {return env.WIRE.get(env.WIRE.idFromName("wire")).fetch(request);}};
`;
const authorization = "Bearer clawrouter-live-fixture-fixture-key";
async function fixture(t, setup = {}) {
 const temporary = await mkdtemp(join(tmpdir(), "clawrouter-query-runtime-"));
 let worker;
 t.after(async () => { await worker?.dispose(); await rm(temporary,{recursive:true,force:true}); });
 worker = await startWorkerdFixture(temporary, router, upstream, {upstreamDurableObjects:{WIRE:{className:"Wire",useSQLite:true}}});
 const call = (path, body, headers = {}) => worker.dispatchFetch("https://router.example"+path, {headers:{authorization,...headers},...(body === undefined ? {} : {method:"POST",body:JSON.stringify(body)})});
 const initialized = await call("/fixture/setup", setup);
 assert.equal(initialized.status, 200, await initialized.text());
 return {call, control:(path, options={})=>worker.dispatchFetch("https://router.example"+path,{...options,headers:{authorization,"content-type":"application/json",...options.headers}}), calls:async () => (await call("/fixture/calls")).json()};
}
async function wire(response) {
 assert.equal(response.status,200,response.ok ? "" : await response.clone().text());
 return response.json();
}
const query = "group_by%5B%5D=project&marker=one&group_by%5B%5D=&marker=two&group_by%5B%5D=model&empty=&=blank&literal=a%2Bb&space=a+b&__proto__=safe";

test("workerd native GET retains repeated keys, interleaving and empty values on the exact upstream URL", {timeout:60000}, async t => {
 const f = await fixture(t);
 const result = await wire(await f.call("/v1/native/replicate/v1/predictions/pred-fixture?"+query));
 assert.equal(result.url,"https://api.replicate.com/v1/predictions/pred-fixture?"+query);
 assert.equal(result.method,"GET"); assert.equal(result.body,"");
 assert.equal(result.authorization,"Bearer fixture-replicate-key");
 assert.equal((await f.calls()).length,1);
});

test("workerd direct manifest GET removes path selectors without regrouping the remaining query", {timeout:60000}, async t => {
 const f = await fixture(t);
 const result = await wire(await f.call("/v1/proxy/replicate/prediction?prediction_id=pred-fixture&"+query+"&prediction_id=ignored"));
 assert.equal(result.url,"https://api.replicate.com/v1/predictions/pred-fixture?"+query);
 assert.equal(result.method,"GET"); assert.equal(result.body,"");
 const missing = await f.call("/v1/proxy/replicate/prediction?"+query);
 assert.equal(missing.status,400); await missing.text();
 assert.equal((await f.calls()).length,1,"missing required path parameters never dispatch");
});

test("workerd manifest query arrays become repeated values rather than comma-joined scalars", {timeout:60000}, async t => {
 const f = await fixture(t);
 const result = await wire(await f.call("/v1/proxy/replicate/prediction", {method:"GET",pathParams:{prediction_id:"pred-fixture"},query:{"group_by[]":["project","","model"],empty:"",limit:0,enabled:false,omit:null,noPairs:[]},body:{}}));
 assert.equal(result.url,"https://api.replicate.com/v1/predictions/pred-fixture?group_by%5B%5D=project&group_by%5B%5D=&group_by%5B%5D=model&empty=&limit=0&enabled=false");
 assert.equal(result.method,"GET"); assert.equal(result.body,"");
 assert.equal((await f.calls()).length,1);
});

test("workerd rejects structured manifest query values before dispatch", {timeout:60000}, async t => {
 const f = await fixture(t);
 for (const value of [{nested:"unsupported"},["ok",{nested:"unsupported"}],[["nested"]],[null]]) {
  const rejected = await f.call("/v1/proxy/replicate/prediction",{method:"GET",pathParams:{prediction_id:"pred-fixture"},query:{option:value}});
  assert.equal(rejected.status,400); assert.equal((await rejected.json()).error.code,"invalid_request_body");
 }
 assert.equal((await f.calls()).length,0);
});

test("workerd caller query replaces configured defaults without changing route, auth or config requirements", {timeout:60000}, async t => {
 const f = await fixture(t);
 const body = {model:"fixture-deployment",messages:[]};
 const result = await wire(await f.call("/v1/native/azure-openai/openai/deployments/fixture-deployment/chat/completions?api-version=caller-one&marker=&api-version=caller-two&base_url=https%3A%2F%2Fattacker.example",body));
 assert.equal(result.url,"https://fixture.openai.azure.com/openai/deployments/fixture-deployment/chat/completions?api-version=caller-one&marker=&api-version=caller-two&base_url=https%3A%2F%2Fattacker.example");
 assert.equal(result.apiKey,"fixture-azure-key"); assert.equal(result.authorization,null);
 const defaulted = await wire(await f.call("/v1/native/azure-openai/openai/deployments/fixture-deployment/chat/completions",body));
 assert.equal(defaulted.url,"https://fixture.openai.azure.com/openai/deployments/fixture-deployment/chat/completions?api-version=configured-version");
 const missing = await f.call("/v1/native/azure-openai/openai/deployments/fixture-deployment/chat/completions?api-version=caller",body,{"x-fixture-missing-config":"1"});
 assert.equal(missing.status,503); assert.equal((await missing.json()).error.code,"provider_not_configured");
 assert.equal((await f.calls()).length,2,"caller query cannot satisfy mandatory operator configuration");
});

test("workerd unified create routes retain caller query for OpenAI and Anthropic", {timeout:60000}, async t => {
 const f = await fixture(t);
 for (const [path,body,upstreamPath] of [
  ["/v1/chat/completions",{model:"openai/gpt-6-astra",messages:[]},"https://api.openai.com/v1/chat/completions"],
  ["/v1/responses",{model:"openai/gpt-6-astra",input:"fixture"},"https://api.openai.com/v1/responses"],
  ["/v1/embeddings",{model:"openai/text-embedding-3-small",input:"fixture"},"https://api.openai.com/v1/embeddings"],
  ["/v1/messages",{model:"anthropic/claude-sonnet-4-6",max_tokens:16,messages:[]},"https://api.anthropic.com/v1/messages"],
 ]) {
  const result = await wire(await f.call(path+"?"+query,body));
  assert.equal(result.url,upstreamPath+"?"+query,path);
  assert.equal(result.method,"POST");
  assert.equal(JSON.parse(result.body).model,body.model.replace(/^(openai|anthropic)\//,""));
 }
 assert.equal((await f.calls()).length,4);
});

test("workerd compound unified create retains caller query on advisers and final synthesis", {timeout:60000}, async t => {
 const f = await fixture(t,{fusion:true});
 const result = await wire(await f.call("/v1/chat/completions?"+query,{model:"clawrouter/fusion",messages:[{role:"user",content:"fixture"}]}));
 assert.equal(result.url,"https://api.openai.com/v1/chat/completions?"+query);
 const calls = await f.calls();
 assert.equal(calls.length,2);
 for (const call of calls) {
  assert.equal(call.url,"https://api.openai.com/v1/chat/completions?"+query);
  assert.equal(call.method,"POST"); assert.equal(call.authorization,"Bearer fixture-upstream-key");
 }
});

test("workerd query transport retains explicit image, compact and durable-background query rejection", {timeout:60000}, async t => {
 const f = await fixture(t);
 for (const [endpoint,path,body,code] of [
  ["images_generations","/v1/images/generations",{model:"openai/gpt-image-2.5-flare",prompt:"fixture",n:1,size:"1024x1024",quality:"low"},"invalid_image_generation"],
  ["responses_compact","/v1/responses/compact",{model:"openai/gpt-6-astra",input:[]},"invalid_compact_query"],
  ["responses","/v1/responses",{model:"openai/gpt-6-astra",input:"fixture",background:true},"background_query_unsupported"],
 ]) {
  for (const carrier of ["unified","native","manifest"]) {
   const route = carrier === "manifest" ? "/v1/proxy/openai/"+endpoint : (carrier === "native" ? "/v1/native/openai" : "")+path;
   const response = await f.call(route+(carrier === "manifest" ? "" : "?option=&option=two"),carrier === "manifest" ? {body,query:{option:["","two"]}} : body);
   assert.equal(response.status,400,route+": "+await response.clone().text());
   assert.equal((await response.json()).error.code,code);
  }
 }
 assert.equal((await f.calls()).length,0,"unsupported query never reaches upstream");
});

test("workerd queries cannot override credential or provider authorization", {timeout:60000}, async t => {
 for (const [setup,headers,code] of [
  [{},{authorization:"Bearer invalid"},"invalid_proxy_key"],
  [{revoked:true},{},"proxy_key_revoked"],
  [{providers:["openai"]},{},"provider_not_allowed"],
 ]) {
  const f = await fixture(t,setup);
  const response = await f.call("/v1/native/replicate/v1/predictions/pred-fixture?policyId=other&provider=openai&"+query,undefined,headers);
  assert.equal(response.status,code === "invalid_proxy_key" ? 401 : 403);
  assert.equal((await response.json()).error.code,code);
  assert.equal((await f.calls()).length,0);
 }
});

for (const createPath of ["/v1/responses", "/v1/native/openai/v1/responses"]) test("query-bearing Responses creation retains its owner for continuation and controls: " + createPath, {timeout:60000}, async t => {
 const f = await fixture(t);
 const body = {model:"openai/gpt-6-astra",input:"fixture"};
 const created = await wire(await f.call(createPath+"?trace=1&trace=2",body));
 assert.equal(created.url,"https://api.openai.com/v1/responses?trace=1&trace=2");
 const continued = await wire(await f.call("/v1/responses",{...body,previous_response_id:created.id}));
 assert.equal(JSON.parse(continued.body).previous_response_id,created.id);
 for (const [path,options] of [[`/v1/responses/${created.id}`,{}],[`/v1/responses/${created.id}/cancel`,{method:"POST"}]]) {
  const response = await f.control(path, options); assert.equal(response.status,200,await response.clone().text()); await response.text();
 }
 const sent = await f.calls(); assert.equal(sent.length,4);
 assert.ok(sent.slice(1).every(call=>!new URL(call.url).search && call.authorization==="Bearer fixture-upstream-key"));
 for (const [path,options] of [["/v1/responses",{method:"POST",body:JSON.stringify({...body,previous_response_id:created.id})}],[`/v1/responses/${created.id}`,{}]]) {
  const changed = await f.control(path,{...options,headers:{"x-fixture-rotate":"1"}});
  assert.equal(changed.status,409); await changed.text();
 }
 await f.call("/fixture/config",{version:"changed"});
 const changedRoute = await f.call(`/v1/responses/${created.id}`);
 assert.equal(changedRoute.status,409); assert.equal((await changedRoute.json()).error.code,"response_owner_unavailable");
 assert.equal((await f.calls()).length,4,"credential and configured route changes still reject before egress");
});

test("caller queries cannot replace credential or operator upstream query keys",{timeout:60000},async t=>{
 const f=await fixture(t,{queryCredential:true});
 for(const name of ["api_key","region"]) for(const carrier of ["native","unified","manifest"]){
  const body={model:"openai/text-embedding-3-small",input:"fixture"};
  const path=carrier==="manifest"?"/v1/proxy/openai/embeddings":(carrier==="native"?"/v1/native/openai":"")+"/v1/embeddings";
  const response=await f.call(path+(carrier==="manifest"?"":"?"+name+"=caller&"+name+"=other"),carrier==="manifest"?{body,query:{[name]:["caller","other"]}}:body);
  assert.equal(response.status,400);assert.equal((await response.json()).error.code,"protected_query_parameter");
 }
 assert.equal((await f.calls()).length,0);
 const allowed=await wire(await f.call("/v1/embeddings?trace=1",{model:"openai/text-embedding-3-small",input:"fixture"}));
 assert.equal(allowed.url,"https://api.openai.com/v1/embeddings?api_key=fixture-upstream-key&region=operator-region&trace=1");
 assert.equal(allowed.authorization,null);
});
