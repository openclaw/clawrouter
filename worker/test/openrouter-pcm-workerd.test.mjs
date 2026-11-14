import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startWorkerdFixture } from "../../test/helpers/workerd.mjs";

const router = `
export {PolicyBindingIndexObject,BudgetLedgerObject,UsageLedgerObject,GrantCredentialObject} from './worker/index.ts';
import worker from './worker/index.ts';
import {snapshot} from './worker/providers.ts';
import {authorityCall} from './worker/authority.ts';
import {putGrantCredentials} from './worker/grant-credentials.ts';
import {sha256Hex} from './worker/utils.ts';
import {BodyLease,bodyBudgetCharged} from './worker/body-budget.ts';
import {usageStub} from './worker/ledgers.ts';
import {configurePcm,pcmBody} from './worker/test/openrouter-pcm-runtime-fixture.mjs';
const provider=snapshot.providers.find(p=>p.id==='openrouter');configurePcm(provider);
const original=globalThis.fetch.bind(globalThis);let initialized,proof={},pending=new Set();
globalThis.fetch=async(input,init)=>{
 const request=new Request(input,init),current=proof;
 if(request.url!=='https://openrouter.ai/api/v1/audio/speech'||request.headers.get('authorization')!=='Bearer synthetic-original-key'||request.redirect!=='manual')throw new Error('invalid original PCM dispatch');
 current.fetches++;current.capacity=bodyBudgetCharged();current.upstreamAborted=request.signal.aborted;
 request.signal.addEventListener('abort',()=>{current.upstreamAborted=true;},{once:true});
 current.body=await request.clone().json();return original(request);
};
export default {async fetch(request,bindings,context){
 const env={...bindings,OPENROUTER_API_KEY:'synthetic-environment-key',GOOGLE_API_KEY:'synthetic-unrelated-key',OPENROUTER_SITE_URL:'https://example.com'},url=new URL(request.url);
 if(url.pathname==='/proof')return Response.json({...proof,remaining:bodyBudgetCharged(),pending:pending.size});
 if(url.pathname==='/usage')return usageStub(env,'fixture','fixture').fetch('https://usage/snapshot?events=admin');
 initialized??=(async()=>{
  await authorityCall(env,'/policies/initialize-all',[{policyId:'fixture',policy:{enabled:true,generation:'g1',providers:['openrouter'],tenantId:'fixture',monthlyBudgetMicros:10000,requestCostMicros:700,retainRequestContent:false}}]);
  await authorityCall(env,'/credentials/initialize-all',[{credentialId:'fixture',credential:{enabled:true,secretSha256:await sha256Hex('fixture-secret'),policyId:'fixture',policyGeneration:'g1'}}]);
  await authorityCall(env,'/connections/initialize-all',[{providerId:'openrouter',enabled:true,monthlyBudgetMicros:10000}]);
  await putGrantCredentials(env,'oauth/fixture/openrouter',{provider:'openrouter',kind:'api_key',enabled:true,credential:'synthetic-original-key'});
 })();await initialized;
 if(bodyBudgetCharged()||pending.size)return new Response('previous delivery pending',{status:500});
 const mode=url.searchParams.get('mode');proof={fetches:0,mode};
 provider.endpoints.find(e=>e.id==='speech').timeout_ms=mode==='deadline'?1000:10000;
 const body={...pcmBody(),input:mode},envelope=url.searchParams.get('manifest')==='true';
 const lease=mode==='capacity'?new BodyLease():null;if(lease&&!lease.grow(32*1024*1024))throw new Error('fixture lease refused');
 const routed=new Request('https://router.example'+(envelope?'/v1/proxy/openrouter/speech':'/v1/native/openrouter/v1/audio/speech'),{
  method:'POST',headers:{authorization:'Bearer clawrouter-live-fixture-fixture-secret','content-type':'application/json'},
  body:JSON.stringify(envelope?{body:{...body,model:'openrouter/'+body.model}}:body),signal:request.signal});
 try{
  const response=await worker.fetch(routed,env,{waitUntil(p){const tracked=Promise.resolve(p).finally(()=>pending.delete(tracked));pending.add(tracked);context.waitUntil(tracked);}});
  proof.status=response.status;proof.nativeLength=response.headers.get("content-length");proof.beforeDelivery=bodyBudgetCharged();return response;
 }finally{lease?.release();}
},queue:worker.queue};`;

const upstream = pendingUrl => `export default {async fetch(request){
 const body=await request.json();
 if(request.headers.get('authorization')!=='Bearer synthetic-original-key'||body.model!=='google/gemini-3.1-flash-tts-preview'||body.voice!=='Kore'||body.response_format!=='pcm')return new Response('invalid native PCM request',{status:400});
 if(body.input==='deadline'){
  const response=await fetch(${JSON.stringify(pendingUrl)},{signal:request.signal});
  return new Response(response.body,{headers:{'content-type':'audio/pcm'}});
 }
 const bytes=new Uint8Array(body.input==='odd'?3:body.input==='full'?16*1024*1024:2048);
 for(let i=0;i<bytes.length;i++)bytes[i]=i%251;
 return new Response(bytes,{headers:{'content-type':'audio/pcm','content-encoding':'identity','content-length':String(bytes.length)}});
}};`;

test("workerd PCM common factory preserves opaque native/manifest bytes, capacity, EOF and deadline cancellation", { timeout: 60000 }, async t => {
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-pcm-runtime-")); t.after(() => rm(temporary, { recursive: true, force: true }));
  let networkRequests = 0, networkClosed = 0;
  const server = createServer((request, response) => {
    networkRequests++; response.on("close", () => { networkClosed++; });
    response.writeHead(200, { "content-type": "audio/pcm" }); response.write(Buffer.from([1, 2]));
    // Real pending I/O: only the original operation's deadline cancels this read.
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const instance = await startWorkerdFixture(temporary, router, upstream(`http://127.0.0.1:${server.address().port}/pending`));
  t.after(() => instance.dispose()); const origin = (await instance.ready).origin;
  const json = async path => { const response = await fetch(new URL(path, origin)); assert.equal(response.status, 200); return response.json(); };
  async function settled() {
    for (let i = 0; i < 100; i++) { const proof = await json("/proof"); if (proof.remaining === 0 && proof.pending === 0) return proof; await delay(10); }
    assert.fail(JSON.stringify(await json("/proof")));
  }
  for (const [mode, manifest, bytes] of [["full", false, 16 * 1024 * 1024], ["small", true, 2048]]) {
    const response = await fetch(new URL(`/?mode=${mode}&manifest=${manifest}`, origin)); assert.equal(response.status, 200, await response.clone().text());
    assert.equal(response.headers.get("content-type"), "audio/pcm");
    // Workerd may omit assigned Content-Length on an ordinary output stream.
    // https://developers.cloudflare.com/workers/runtime-apis/response/#set-the-content-length-header
    // Wire count/hash below require full EOF independently of HTTP framing.
    const length = response.headers.get("content-length"); if (length !== null) assert.equal(length, String(bytes));
    const hash = createHash("sha256"); let count = 0;
    for await (const chunk of response.body) { count += chunk.byteLength; hash.update(chunk); }
    const expected = Uint8Array.from({ length: bytes }, (_, i) => i % 251);
    assert.equal(count, bytes); assert.equal(hash.digest("hex"), createHash("sha256").update(expected).digest("hex"));
    const proof = await settled(); if (proof.nativeLength !== null) assert.equal(proof.nativeLength, String(bytes)); assert.equal(proof.fetches, 1); assert.equal(proof.capacity, 64 * 1024 * 1024); assert.equal(proof.beforeDelivery, 64 * 1024 * 1024);
    assert.equal(proof.body.input, mode); assert.equal(proof.body.model, "google/gemini-3.1-flash-tts-preview");
  }
  for (const [mode, status, fetches] of [["odd", 502, 1], ["capacity", 503, 0], ["deadline", 502, 1]]) {
    const response = await fetch(new URL(`/?mode=${mode}`, origin)); assert.equal(response.status, status, await response.clone().text());
    assert.ok(!response.headers.get("content-type").includes("audio")); await response.text();
    const proof = await settled(); assert.equal(proof.fetches, fetches);
    if (mode === "deadline") assert.equal(proof.upstreamAborted, true);
  }
  for (let i = 0; i < 100 && networkClosed !== 1; i++) await delay(10);
  assert.equal(networkRequests, 1); assert.equal(networkClosed, 1);
  const usage = await json("/usage"); assert.equal(usage.events.length, 5);
  assert.deepEqual(usage.events.map(row => row.actual_cost_micros).sort((a,b) => a-b), [0,700,700,700,700]);
  for (const row of usage.events) { assert.equal(row.input_tokens, null); assert.equal(row.output_tokens, null); assert.equal(row.total_tokens, null); }
});
