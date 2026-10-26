import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { startWorkerdFixture } from "../../test/helpers/workerd.mjs";
import { proxyJsonBodyLimit } from "../request-body-limits.ts";

const limit = 32_000_000;
const key = "Bearer clawrouter-live-fixture-fixture-key";
const router = `
import worker from "./worker/index.ts";
export * from "./worker/index.ts";
import { ingestUsage, usageStub } from "./worker/ledgers.ts";
import { sha256Hex } from "./worker/utils.ts";
export default { async fetch(request,env,context) {
 const url=new URL(request.url);
 if(url.pathname==="/fixture/setup") {
  const stub=env.ACCESS_CONTROL.get(env.ACCESS_CONTROL.idFromName("policy-bindings"));
  for(const [path,body] of [
   ["/policies/initialize-all",[{policyId:"fixture",policy:{enabled:true,generation:"g1",providers:["openai"],tenantId:"tenant",monthlyBudgetMicros:Number(url.searchParams.get("limit")??200000000),retainRequestContent:url.searchParams.has("retain")}}]],
   ["/credentials/initialize-all",[{credentialId:"fixture",credential:{enabled:true,secretSha256:await sha256Hex("fixture-key"),policyId:"fixture",policyGeneration:"g1"}}]],
   ["/connections/initialize-all",[{providerId:"openai",enabled:true,monthlyBudgetMicros:200000000}]]
  ]) { const response=await stub.fetch("https://owner"+path,{method:"POST",body:JSON.stringify(body)});if(!response.ok)return response; }
  return Response.json({ok:true});
 }
 if(url.pathname==="/fixture/usage")return usageStub(env,"tenant","fixture").fetch("https://usage/snapshot?events=admin");
 if(url.pathname==="/fixture/content") {
  const objects=await env.CONTENT_ARCHIVE.list(),records=[];
  for(const item of objects.objects) { const object=await env.CONTENT_ARCHIVE.get(item.key),record=await object.json();records.push({provider:record.provider,length:record.body.input.length,digest:await sha256Hex(record.body.input)}); }
  return Response.json(records);
 }
 return worker.fetch(request,{...env,USAGE_QUEUE:{send:event=>ingestUsage(env,event)}},context);
}};`;
const upstream = `export default { async fetch(request) {
 if(!request.url.startsWith("https://api.openai.com/v1/"))throw Error("unexpected upstream");
 const text=await request.text(),body=JSON.parse(text);
 if(text.length>8*1024*1024&&request.headers.get("content-length")!==String(new TextEncoder().encode(text).byteLength))throw Error("large upload must have exact content-length");
 if(body.model!=="gpt-6-astra")throw Error("wrong model");
 const content=body.input??body.messages[0].content;
 const input=typeof content==="string"?content:content[0].content[0].image_url??content[0].content[0].file_data;
 const echo={length:input.length,digest:Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(input))),b=>b.toString(16).padStart(2,"0")).join("")};
 if(request.url.endsWith("input_tokens"))return Response.json({object:"response.input_tokens",input_tokens:37,...echo});
 const usage={input_tokens:10,output_tokens:1,total_tokens:11,input_tokens_details:{cached_tokens:0,cache_write_tokens:0},output_tokens_details:{reasoning_tokens:0}};
 if(request.url.endsWith("chat/completions"))return Response.json({id:"chat_fixture",object:"chat.completion",choices:[{message:{role:"assistant",content:JSON.stringify(echo)},finish_reason:"stop"}],service_tier:"default",usage:{prompt_tokens:10,completion_tokens:1,total_tokens:11,prompt_tokens_details:{cached_tokens:0,cache_write_tokens:0}}});
 return Response.json({id:(request.url.endsWith("compact")?"cmp_":"resp_")+crypto.randomUUID(),object:request.url.endsWith("compact")?"response.compaction":"response",status:"completed",service_tier:"default",output:[{type:"message",role:"assistant",content:[{type:"output_text",text:JSON.stringify(echo),annotations:[]}]}],usage});
}};`;
function fragmented(text) {
 const bytes=new TextEncoder().encode(text);let offset=0;
 return new ReadableStream({pull(c){if(offset===bytes.length)return c.close();const end=Math.min(offset+65536,bytes.length);c.enqueue(bytes.subarray(offset,end));offset=end;}},{highWaterMark:0});
}
async function fixture(run, options="") {
 const scratch=join(process.cwd(),".artifacts");await mkdir(scratch,{recursive:true});
 const temporary=await mkdtemp(join(scratch,"openai-ingress-"));let worker;
 try {worker=await startWorkerdFixture(temporary,router,upstream,{r2Buckets:["CONTENT_ARCHIVE"]});assert.equal((await worker.dispatchFetch("https://router.example/fixture/setup"+options)).status,200);await run(worker);}
 finally {await worker?.dispose();await rm(temporary,{recursive:true,force:true});}
}
function send(worker,path,body,headers={}) {
 return worker.dispatchFetch("https://router.example"+path,{method:"POST",headers:{authorization:key,"content-type":"application/json",...headers},body:fragmented(body),duplex:"half"});
}
const endpoints=[
 ["responses","/v1/responses","openai.responses"],
 ["chat_completions","/v1/chat/completions","openai.chat_completions"],
 ["responses_compact","/v1/responses/compact","openai.responses_compact"],
 ["responses_input_tokens","/v1/responses/input_tokens","openai.responses_input_tokens"],
];

test("expanded JSON is limited to resolved OpenAI conversation endpoints",()=>{
 for(const [, ,format] of endpoints)assert.equal(proxyJsonBodyLimit("openai",format),limit);
 for(const provider of ["azure-openai","local-openai","anthropic"])for(const [, ,format] of endpoints)assert.equal(proxyJsonBodyLimit(provider,format),8*1024*1024);
 for(const format of ["openai.embeddings","openai.models","openai.images_generations","openai.moderations","openai.standalone_search"])assert.equal(proxyJsonBodyLimit("openai",format),8*1024*1024);
 assert.equal(proxyJsonBodyLimit("anthropic","anthropic.messages"),limit);
});

test("real workerd forwards complete expanded OpenAI conversations through native and manifest routes",{timeout:180000},()=>fixture(async worker=>{
 const input="synthetic-é-界-"+"A".repeat(9*1024*1024);
 const digest=Buffer.from(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(input))).toString("hex");
 for(const [endpoint,path] of endpoints)for(const route of ["/v1/native/openai"+path,"/v1/proxy/openai/"+endpoint]) {
  const body={model:"gpt-6-astra",...(endpoint==="chat_completions"?{messages:[{role:"user",content:input}],max_completion_tokens:1}:{input,...(endpoint==="responses"?{max_output_tokens:1}:{})})};
  const response=await send(worker,route,JSON.stringify(route.includes("/proxy/")?{body}:body));
  assert.equal(response.status,200,await response.clone().text());const result=await response.json();
  const echo=endpoint==="responses_input_tokens"?result:JSON.parse(endpoint==="chat_completions"?result.choices[0].message.content:result.output[0].content[0].text);
  assert.equal(echo.length,input.length);assert.equal(echo.digest,digest);
 }
 const snapshot=await(await worker.dispatchFetch("https://router.example/fixture/usage")).json();
 assert.equal(snapshot.events.length,8);
 for(const event of snapshot.events)assert.equal(event.actual_cost_micros,event.capability==="llm.count_tokens"?0:150,JSON.stringify(event));
}));

test("real workerd enforces exact OpenAI byte boundary, malformed input and unchanged unified cap",{timeout:180000},()=>fixture(async worker=>{
 const body=JSON.stringify({model:"gpt-6-astra",input:"synthetic-é-界"});
 const exact=body+" ".repeat(limit-Buffer.byteLength(body));
 for(const route of ["/v1/native/openai/v1/responses/input_tokens","/v1/proxy/openai/responses_input_tokens"]) {
  const wire=route.includes("/proxy/")?'{"body":'+body+'}':body;
  const exact=wire+" ".repeat(limit-Buffer.byteLength(wire));
  for(const [suffix,status] of [["",200],[" ",413]]) {const response=await send(worker,route,exact+suffix);assert.equal(response.status,status,await response.clone().text());if(status===413)assert.equal(response.headers.get("x-clawrouter-error-code"),"request_too_large");await response.text();}
 }
 const malformed=await send(worker,"/v1/native/openai/v1/responses/input_tokens",exact+"x");assert.equal(malformed.status,413);await malformed.text();
 const invalid=await send(worker,"/v1/native/openai/v1/responses/input_tokens",'{"model":"gpt-6-astra","input":"'+"A".repeat(9*1024*1024));assert.equal(invalid.status,400);await invalid.text();
 const unchanged=await send(worker,"/v1/responses",JSON.stringify({model:"openai/gpt-6-astra",input:"A".repeat(9*1024*1024)}));assert.equal(unchanged.status,413);await unchanged.text();
}));

test("expanded OpenAI retention preserves the whole request and hard budgets still deny",{timeout:90000},async()=>{
 const input="A".repeat(9*1024*1024),body=JSON.stringify({model:"gpt-6-astra",input,max_output_tokens:1});
 await fixture(async worker=>{
  const response=await send(worker,"/v1/native/openai/v1/responses",body);assert.equal(response.status,200,await response.clone().text());await response.text();
  const records=await(await worker.dispatchFetch("https://router.example/fixture/content")).json();
  assert.deepEqual(records,[{provider:"openai",length:input.length,digest:Buffer.from(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(input))).toString("hex")}]);
 },"?retain=1");
 await fixture(async worker=>{
  const response=await send(worker,"/v1/native/openai/v1/responses",body);assert.equal(response.status,402);assert.equal(response.headers.get("x-clawrouter-error-code"),"budget_exhausted");await response.text();
  const snapshot=await(await worker.dispatchFetch("https://router.example/fixture/usage")).json();assert.equal(snapshot.events.length,1);assert.equal(snapshot.events[0].actual_cost_micros,0);
 },"?limit=1");
});

test("real workerd preserves expanded inline image and file data",{timeout:90000},()=>fixture(async worker=>{
 for(const [type,field,prefix] of [["input_image","image_url","data:image/png;base64,"],["input_file","file_data","data:application/pdf;base64,"]]) {
  // Synthetic media is inspected by the fixture, never sent to a paid provider.
  const data=prefix+"A".repeat(9*1024*1024),body={model:"gpt-6-astra",input:[{role:"user",content:[{type,[field]:data,...(type==="input_file"?{filename:"synthetic.pdf"}:{})}]}]};
  for(const route of ["/v1/native/openai/v1/responses/input_tokens","/v1/proxy/openai/responses_input_tokens"]) {
   const response=await send(worker,route,JSON.stringify(route.includes("/proxy/")?{body}:body));assert.equal(response.status,200,await response.clone().text());
   const result=await response.json();assert.equal(result.length,data.length);assert.equal(result.digest,Buffer.from(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(data))).toString("hex"));
  }
 }
}));
