import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { startWorkerdFixture } from "../../test/helpers/workerd.mjs";
import { speechFixture } from "./openrouter-speech-runtime-fixture.mjs";
const router = `
export {PolicyBindingIndexObject,BudgetLedgerObject,UsageLedgerObject,GrantCredentialObject} from './worker/index.ts';
import worker from './worker/index.ts';
import {snapshot} from './worker/providers.ts';
import {authorityCall} from './worker/authority.ts';
import {putGrantCredentials} from './worker/grant-credentials.ts';
import {sha256Hex} from './worker/utils.ts';
import {bodyBudgetCharged} from './worker/body-budget.ts';
import {configureSpeech,speechBody} from './worker/test/openrouter-speech-runtime-fixture.mjs';
configureSpeech(snapshot.providers.find(p=>p.id==='openrouter'));
const original=globalThis.fetch.bind(globalThis);let fetches=0,capacity=0,body;
globalThis.fetch=async(input,init)=>{const request=new Request(input,init);if(request.url!=='https://openrouter.ai/api/v1/audio/speech'||request.headers.get('authorization')!=='Bearer synthetic-original-key'||request.redirect!=='manual')throw new Error('invalid original dispatch');fetches++;capacity=bodyBudgetCharged();body=await request.clone().json();return original(request);};
export default {async fetch(request,bindings){
 const env={...bindings,OPENROUTER_SITE_URL:'https://example.com'},pending=[];
 await authorityCall(env,'/policies/initialize-all',[{policyId:'fixture',policy:{enabled:true,generation:'g1',providers:['openrouter'],tenantId:'fixture',monthlyBudgetMicros:10000,requestCostMicros:700,retainRequestContent:false}}]);
 await authorityCall(env,'/credentials/initialize-all',[{credentialId:'fixture',credential:{enabled:true,secretSha256:await sha256Hex('fixture-secret'),policyId:'fixture',policyGeneration:'g1'}}]);
 await authorityCall(env,'/connections/initialize-all',[{providerId:'openrouter',enabled:true,monthlyBudgetMicros:10000}]);
 await putGrantCredentials(env,'oauth/fixture/openrouter',{provider:'openrouter',kind:'api_key',enabled:true,credential:'synthetic-original-key'});
 const supplied={...speechBody(),input:'x'.repeat(5000),provider:{zdr:true,data_collection:'deny'},speed:1.1};
 const response=await worker.fetch(new Request('https://router.example/v1/native/openrouter/v1/audio/speech',{method:'POST',headers:{authorization:'Bearer clawrouter-live-fixture-fixture-secret','content-type':'application/json'},body:JSON.stringify(supplied)}),env,{waitUntil:p=>pending.push(p)});
 const bytes=new Uint8Array(await response.arrayBuffer());while(pending.length)await Promise.all(pending.splice(0));
 let encoded='';for(const byte of bytes)encoded+=String.fromCharCode(byte);
 return Response.json({status:response.status,mime:response.headers.get('content-type'),length:response.headers.get('content-length'),audio:btoa(encoded),fetches,capacity,remaining:bodyBudgetCharged(),sameBody:JSON.stringify(body)===JSON.stringify(supplied)});
},queue:worker.queue};`;
const upstream = `export default {async fetch(request){const body=await request.json();
 if(body.model!=='hexgrad/kokoro-82m'||body.input.length!==5000||body.voice!=='synthetic_voice'||body.response_format!=='mp3')return new Response('invalid selected body',{status:400});
 const bytes=Uint8Array.from(atob(${JSON.stringify(speechFixture.base64)}),c=>c.charCodeAt(0));
 return new Response(bytes,{headers:{'content-type':'audio/mpeg','content-length':String(bytes.length),'content-encoding':'identity'}});
}};`;

test("workerd actual OpenRouter speech factory preserves native request and MP3, with bounded pre-dispatch capacity", { timeout: 60000 }, async t => {
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-openrouter-speech-")); t.after(() => rm(temporary, { recursive: true, force: true }));
  const instance = await startWorkerdFixture(temporary, router, upstream); t.after(() => instance.dispose());
  const response = await fetch((await instance.ready).origin); assert.equal(response.status, 200, await response.clone().text()); const proof = await response.json();
  assert.equal(proof.status, 200, JSON.stringify(proof)); assert.equal(proof.mime, "audio/mpeg"); assert.equal(proof.length, String(speechFixture.bytes));
  assert.equal(proof.audio, speechFixture.base64); assert.equal(createHash("sha256").update(Buffer.from(proof.audio, "base64")).digest("hex"), speechFixture.sha256);
  assert.equal(proof.sameBody, true); assert.equal(proof.fetches, 1); assert.equal(proof.capacity, 64 * 1024 * 1024); assert.equal(proof.remaining, 0);
});
