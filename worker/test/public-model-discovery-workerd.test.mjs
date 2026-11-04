import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startWorkerdFixture } from "../../test/helpers/workerd.mjs";
const contracts = {
  cerebras: { base: "https://api.cerebras.ai/v1", format: "cerebras.public_catalog", endpoint: "public_models", urls: ["https://api.cerebras.ai/public/v1/models"] },
  nvidia: { base: "https://integrate.api.nvidia.com/v1", format: "nvidia.public_catalog", endpoint: "public_models", urls: ["https://integrate.api.nvidia.com/v1/models", "https://assets.ngc.nvidia.com/products/api-catalog/featured-models.json"] },
  chutes: { base: "https://llm.chutes.ai/v1", format: "chutes.models", endpoint: "models_list", urls: ["https://llm.chutes.ai/v1/models"] },
  venice: { base: "https://api.venice.ai/api/v1", format: "venice.models", endpoint: "models_list", urls: ["https://api.venice.ai/api/v1/models?type=text"] },
};
const router = `
export {PolicyBindingIndexObject,BudgetLedgerObject,UsageLedgerObject,GrantCredentialObject} from './worker/index.ts';
import worker from './worker/index.ts';
import {snapshot} from './worker/providers.ts';
import {authorityCall} from './worker/authority.ts';
import {putGrantCredentials} from './worker/grant-credentials.ts';
import {sha256Hex} from './worker/utils.ts';
const contracts=${JSON.stringify(contracts)},originalFetch=globalThis.fetch.bind(globalThis),calls=[];
globalThis.fetch=(input,init)=>{const request=new Request(input,init);calls.push({url:request.url,method:request.method,headers:[...request.headers],redirect:request.redirect});return originalFetch(request);};
const template=structuredClone(snapshot.providers.find(p=>p.id==='openai'));
for(const [id,c] of Object.entries(contracts)){
 const provider=structuredClone(template),endpoint={...provider.endpoints.find(e=>e.id==='models_list'),id:c.endpoint,path:'/models',method:'GET',methods:['GET'],request_format:c.format,response_format:c.format,native_proxy:!c.format.endsWith('.public_catalog'),timeout_ms:10000,path_params:[],path_param_styles:{},headers:{},query:{}};
 Object.assign(provider,{id,config_keys:['CATALOG_API_KEY'],optional_config_keys:[],base_urls:{default:c.base},native_prefixes:[id],routing:{nativePrefixes:[id],modelPrefixes:[id+'/'],baseUrlParam:null,serviceParam:null},auth:{schemes:[{type:'bearer',header:'Authorization',format:'Bearer '+String.fromCharCode(36)+'{secret}',secretKind:'api_key'}],grantTransports:{}},adapter:{...provider.adapter,injectHeaders:{},injectQuery:{},passthroughHeaders:[]},capabilities:[{id:'models.list',endpoint:c.endpoint,methods:['GET']}],endpoints:[endpoint],models:[{id:id+'/one',upstream:'one',capabilities:[],pricing:null,pricing_ref:null}]});
 snapshot.providers=[...snapshot.providers.filter(p=>p.id!==id),provider];
}
export default {async fetch(request,env){
 const pending=[],results=[];const ids=Object.keys(contracts);
 await authorityCall(env,'/policies/initialize-all',[{policyId:'fixture',policy:{enabled:true,generation:'g1',providers:ids,tenantId:'fixture',monthlyBudgetMicros:10000,requestCostMicros:700,retainRequestContent:false}}]);
 await authorityCall(env,'/credentials/initialize-all',[{credentialId:'fixture',credential:{enabled:true,secretSha256:await sha256Hex('fixture-secret'),policyId:'fixture',policyGeneration:'g1'}}]);
 await authorityCall(env,'/connections/initialize-all',ids.map(providerId=>({providerId,enabled:true,monthlyBudgetMicros:10000})));
 for(const id of ids){await putGrantCredentials(env,'oauth/fixture/'+id,{provider:id,kind:'api_key',enabled:true,credential:'synthetic-private-key'});
  const response=await worker.fetch(new Request('https://router.example/v1/proxy/'+id+'/'+contracts[id].endpoint,{headers:{authorization:'Bearer clawrouter-live-fixture-fixture-secret'}}),env,{waitUntil:p=>pending.push(p)});
  results.push({id,status:response.status,body:await response.json()});while(pending.length)await Promise.all(pending.splice(0));
 }
 return Response.json({results,calls});
},queue:worker.queue};`;
const upstream = `export default {async fetch(request){
 if([...request.headers].some(([name])=>!['accept','host'].includes(name)))return new Response('private header leaked',{status:400});
 if(request.url==='https://assets.ngc.nvidia.com/products/api-catalog/featured-models.json')return Response.json({'featured-models':[]});
 return Response.json({object:'list',...(request.url.includes('venice.ai')?{type:'text'}:{}),data:[]});
}};`;

test("workerd actual public catalogs construct supported requests and never forward inference credentials", { timeout: 60000 }, async t => {
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-public-catalogs-")); t.after(() => rm(temporary, { recursive: true, force: true }));
  const instance = await startWorkerdFixture(temporary, router, upstream); t.after(() => instance.dispose());
  const response = await fetch((await instance.ready).origin); assert.equal(response.status, 200, await response.clone().text()); const proof = await response.json();
  for (const result of proof.results) {
    assert.equal(result.status, 200, JSON.stringify(result));
    assert.deepEqual(result.body, contracts[result.id].format.endsWith('.public_catalog') ? { providerId: result.id, catalog: [] } : { object: "list", ...(result.id === "venice" ? { type: "text" } : {}), data: [] });
  }
  assert.deepEqual(proof.calls.map(call => call.url), Object.values(contracts).flatMap(c => c.urls));
  for (const call of proof.calls) { assert.equal(call.method, "GET"); assert.equal(call.redirect, "manual"); assert.deepEqual(call.headers, [["accept", "application/json"]]); }
});
