import assert from "node:assert/strict";
import test from "node:test";
import { crc32, deflateSync } from "node:zlib";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { startWorkerdFixture } from "../../test/helpers/workerd.mjs";
import { readJson } from "../utils.ts";
import { jsonBodyBytes, jsonBodyStream } from "../json-body.ts";

const limit = 32_000_000;
const key = "Bearer clawrouter-live-fixture-fixture-key";
const router = `
import worker from "./worker/index.ts";
export * from "./worker/index.ts";
import { BudgetLedgerObject as Budget, usageStub, ingestUsage } from "./worker/ledgers.ts";
import { sha256Hex } from "./worker/utils.ts";
export class BudgetLedgerObject extends Budget {
  constructor(state) { super(state); this.sql=state.storage.sql; }
  async fetch(request) { if(new URL(request.url).pathname==="/rows") return Response.json([...this.sql.exec("SELECT * FROM budget_reservations")]); return super.fetch(request); }
}
const uploads = new Map();
export default { async fetch(request,env,context) {
 const url=new URL(request.url), path=url.pathname;
 if(path==="/fixture/setup") {
  const stub=env.ACCESS_CONTROL.get(env.ACCESS_CONTROL.idFromName("policy-bindings"));
  for(const [path,body] of [
   ["/policies/initialize-all",[{policyId:"fixture",policy:{enabled:true,generation:"g1",providers:["anthropic"],tenantId:"tenant",monthlyBudgetMicros:Number(url.searchParams.get("limit")??20000000),retainRequestContent:url.searchParams.has("retain")}}]],
   ["/credentials/initialize-all",[{credentialId:"fixture",credential:{enabled:true,secretSha256:await sha256Hex("fixture-key"),policyId:"fixture",policyGeneration:"g1"}}]],
   ["/connections/initialize-all",[{providerId:"anthropic",enabled:true,monthlyBudgetMicros:20000000}]]
  ]) { const r=await stub.fetch("https://owner"+path,{method:"POST",body:JSON.stringify(body)}); if(!r.ok)return r; }
  return Response.json({ok:true});
 }
 if(path==="/fixture/rows") return env.BUDGET_LEDGER.get(env.BUDGET_LEDGER.idFromName(url.searchParams.get("name"))).fetch("https://budget/rows");
 if(path==="/fixture/usage") return usageStub(env,"tenant","fixture").fetch("https://usage/snapshot?events=admin");
 if(path==="/fixture/content") { const objects=await env.CONTENT_ARCHIVE.list(); if(objects.objects.length!==1)throw Error("unexpected archive count"); const object=await env.CONTENT_ARCHIVE.get(objects.objects[0].key); const record=await object.json(); return Response.json({size:object.size,provider:record.provider,lengths:record.body.messages[0].content.map(block=>block.source.data.length),metadata:record.body.metadata}); }
 if(path==="/fixture/upload") {
  const id=url.searchParams.get("id"), action=url.searchParams.get("action"), state=uploads.get(id);
  if(action==="state") return Response.json(state ? {read:state.read,held:state.held,status:state.status,headersStatus:state.headersStatus,result:state.result,retry:state.retry} : null);
  if(action==="release") { state.released=true;return Response.json({ok:true}); }
  if(action==="cancel") { state.cancelRequested=true;return Response.json({ok:true}); }
  const total=Number(url.searchParams.get("bytes")??(9*1024*1024));
  const manifest=url.searchParams.get("route")?.includes("/proxy/");
  const prefix=new TextEncoder().encode((manifest?'{"body":':'')+'{"model":"claude-opus-5-5","max_tokens":1,"messages":[{"role":"user","content":"');
  const suffix=new TextEncoder().encode('"}],"metadata":{"user_id":"'+(url.searchParams.get("mode")??"normal")+'"}}'+(manifest?'}':''));
  const next={read:0,held:false,released:url.searchParams.has("free"),abort:new AbortController()};uploads.set(id,next);
  const stream=new ReadableStream({async pull(c) {
   if(next.read>=8*1024*1024+65536&&!next.released) { next.held=true;while(!next.released&&!next.abort.signal.aborted)await new Promise(resolve=>setTimeout(resolve,10)); }
   if(next.abort.signal.aborted)return;
   if(next.read===total) { c.close();return; }
   const count=Math.min(65536,total-next.read), chunk=new Uint8Array(count).fill(65);
   for(let i=0;i<count;i++) { const at=next.read+i;if(at<prefix.length)chunk[i]=prefix[at];else if(at>=total-suffix.length)chunk[i]=suffix[at-(total-suffix.length)]; }
   if(url.searchParams.has("malformed")&&next.read+count===total)chunk[count-1]=32;
   next.read+=count;c.enqueue(chunk);
  },cancel(){next.released=true;}},{highWaterMark:0});
  const headers={"content-type":"application/json"};
  if(!url.searchParams.has("anonymous"))headers.authorization=url.searchParams.has("invalid")?"Bearer clawrouter-live-fixture-wrong-secret":"Bearer clawrouter-live-fixture-fixture-key";
  const incoming=new Request("https://router.example"+(url.searchParams.get("route")??"/v1/messages"),{method:"POST",headers,body:stream,signal:next.abort.signal});
  const timer=setInterval(()=>{if(next.cancelRequested)next.abort.abort();},10);
  await (async()=>{
   try { const response=await worker.fetch(incoming,{...env,ANTHROPIC_API_KEY:"fixture-upstream-key",USAGE_QUEUE:{send:event=>ingestUsage(env,event)}},context);next.headersStatus=response.status;next.retry=response.headers.get("retry-after");next.result=await response.json();next.status=response.status; }
   catch { next.status=499; }
   finally {clearInterval(timer);}
  })();
  return Response.json({ok:true});
 }
 return worker.fetch(request,{...env,ANTHROPIC_API_KEY:"fixture-upstream-key",USAGE_QUEUE:{send:event=>ingestUsage(env,event)}},context);
}};`;
const upstream = `export default { async fetch(request) {
 if(!request.url.startsWith("https://api.anthropic.com/v1/messages")) throw Error("unexpected upstream");
 const text=await request.text();
 if(text.length>8*1024*1024 && request.headers.get("content-length")!==String(new TextEncoder().encode(text).byteLength))throw Error("large upload must have exact content-length");
 const body=JSON.parse(text);
 if(body.metadata?.user_id==="reject")return Response.json({type:"error",error:{type:"api_error",message:"fixture"}},{status:500});
 if(body.metadata?.user_id==="stream")return new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('event: message_start\\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":0}}}\\n\\n'));},async pull(c){await new Promise(resolve=>setTimeout(resolve,50));c.enqueue(new TextEncoder().encode(': keepalive\\n\\n'));}}),{headers:{"content-type":"text/event-stream"}});
 if(typeof body.messages[0].content==="string")return Response.json({type:"message",content:[{type:"text",text:JSON.stringify({messages:body.messages.length,values:body.messages[1]?.content?.[0]?.input?.values??null})}],stop_reason:"end_turn",usage:{input_tokens:10,output_tokens:1,speed:"standard",inference_geo:"global",service_tier:"standard"}});
 const blocks=body.messages[0].content;
 if(body.model!=="claude-opus-5-5" || !Array.isArray(blocks) || !blocks.length) throw Error("lost native request");
 // Inspect forwarded media, not just the response status: the complete large
 // strings must survive ingress, provider transforms, pricing and dispatch.
 const lengths=blocks.map(block=>block.source.data.length);
 if(request.url.endsWith("count_tokens")) return Response.json({input_tokens:123,lengths});
 return Response.json({type:"message",content:[{type:"text",text:JSON.stringify(lengths)}],stop_reason:"end_turn",usage:{input_tokens:10,output_tokens:1,speed:"standard",inference_geo:"global",service_tier:"standard"}});
}};`;

function png() {
 const chunk=(type,data)=>{
  const body=Buffer.concat([Buffer.from(type),data]),length=Buffer.alloc(4),crc=Buffer.alloc(4);
  length.writeUInt32BE(data.length);crc.writeUInt32BE(crc32(body));return Buffer.concat([length,body,crc]);
 };
 const header=Buffer.alloc(13);header.writeUInt32BE(1);header.writeUInt32BE(1,4);header[8]=8;header[9]=2;
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk("IHDR",header),chunk("tEXt",Buffer.concat([Buffer.from("fixture\0"),Buffer.alloc(4*1024*1024,65)])),chunk("IDAT",deflateSync(Buffer.alloc(4))),chunk("IEND",Buffer.alloc(0))]).toString("base64");
}
function pdf() {
 // A valid one-page PDF with a large, whitespace-only content stream.
 const contents=" ".repeat(9*1024*1024),objects=["<< /Type /Catalog /Pages 2 0 R >>","<< /Type /Pages /Kids [3 0 R] /Count 1 >>","<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>",`<< /Length ${contents.length} >>\nstream\n${contents}\nendstream`];
 let text="%PDF-1.7\n",offsets=[0];
 for(let index=0;index<objects.length;index++){offsets.push(text.length);text+=`${index+1} 0 obj\n${objects[index]}\nendobj\n`;}
 const xref=text.length;text+=`xref\n0 5\n0000000000 65535 f \n${offsets.slice(1).map(offset=>String(offset).padStart(10,"0")+" 00000 n \n").join("")}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
 return Buffer.from(text).toString("base64");
}
function body(type="image") {
 const data=type==="image"?png():pdf();
 return {model:"claude-opus-5-5",max_tokens:1,messages:[{role:"user",content:Array.from({length:type==="image"?5:1},()=>({type,source:{type:"base64",media_type:type==="image"?"image/png":"application/pdf",data}}))}]};
}
function fragmented(text,chunk=65536) {
 const bytes=new TextEncoder().encode(text);let offset=0;
 return new ReadableStream({pull(c){if(offset===bytes.length)return c.close();const end=Math.min(offset+chunk,bytes.length);c.enqueue(bytes.subarray(offset,end));offset=end;}},{highWaterMark:0});
}

// The non-Claude default remains 8 MiB. Ingress uses actual bytes, never trusts
// content-length, and must cancel immediately at the boundary rather than drain.
test("bounded JSON ingress cancels an over-limit stream with a lying length",async()=>{
 let pulls=0,canceled=false;
 const stream=new ReadableStream({pull(c){pulls++;c.enqueue(new Uint8Array(1024*1024));},cancel(){canceled=true;}},{highWaterMark:0});
 const request=new Request("https://router.example/",{method:"POST",headers:{"content-length":"1"},body:stream,duplex:"half"});
 await assert.rejects(readJson(request),error=>error.status===413);
 assert.equal(pulls,9);assert.equal(canceled,true);assert.equal(request.body.locked,false);
});

test("real workerd accepts large Claude vision/PDF bodies and preserves reservations",{timeout:180000},async()=>{
 const scratch=join(process.cwd(),".artifacts");await mkdir(scratch,{recursive:true});
 const temporary=await mkdtemp(join(scratch,"anthropic-ingress-"));let worker;
 try {
  worker=await startWorkerdFixture(temporary,router,upstream);
  assert.equal((await worker.dispatchFetch("https://router.example/fixture/setup")).status,200);
  const vision=body(), expected=vision.messages[0].content.map(block=>block.source.data.length);
  // A non-ASCII annotation forces UTF-8 decoding across chunk boundaries too.
  vision.metadata={user_id:"synthetic-é-界"};
  const serialized=JSON.stringify(vision);assert.ok(serialized.length>26*1024*1024 && serialized.length<limit);
  for(const path of ["/v1/messages","/v1/native/anthropic/v1/messages","/v1/proxy/anthropic/messages"]) {
   const text=path.includes("/proxy/")?JSON.stringify({body:vision}):serialized;
   const response=await worker.dispatchFetch("https://router.example"+path,{method:"POST",headers:{authorization:key,"content-type":"application/json"},body:fragmented(text),duplex:"half"});
   assert.equal(response.status,200,response.ok?"":await response.text());
   assert.deepEqual(JSON.parse((await response.json()).content[0].text),expected);
  }
  const pdf=body("document"), pdfLength=pdf.messages[0].content[0].source.data.length;
  for(const path of ["/v1/messages","/v1/messages/count_tokens","/v1/native/anthropic/v1/messages/count_tokens","/v1/proxy/anthropic/count_tokens"]) {
   const response=await worker.dispatchFetch("https://router.example"+path,{method:"POST",headers:{authorization:key,"content-type":"application/json"},body:fragmented(JSON.stringify(path.includes("/proxy/")?{body:pdf}:pdf)),duplex:"half"});
   assert.equal(response.status,200,response.ok?"":await response.text());
   const value=await response.json();assert.deepEqual(path.endsWith("count_tokens")?value.lengths:JSON.parse(value.content[0].text),[pdfLength]);
  }
  // Exact ingress boundary and +1 byte on a free count_tokens route isolate
  // size admission from monetary admission and provider media validation.
  const count=JSON.stringify(pdf), exact=count+" ".repeat(limit-count.length);
  for(const [extra,status] of [["",200],[" ",413]]) {
   const response=await worker.dispatchFetch("https://router.example/v1/messages/count_tokens",{method:"POST",headers:{authorization:key,"content-type":"application/json"},body:fragmented(exact+extra),duplex:"half"});
   assert.equal(response.status,status);if(status===413)assert.equal(response.headers.get("x-clawrouter-error-code"),"request_too_large");await response.text();
  }
  const invalid=await worker.dispatchFetch("https://router.example/v1/messages",{method:"POST",headers:{authorization:key,"content-type":"application/json"},body:fragmented(serialized.slice(0,-1)),duplex:"half"});
  assert.equal(invalid.status,400);assert.equal(invalid.headers.get("x-clawrouter-error-code"),"invalid_json");await invalid.text();
  const snapshot=await(await worker.dispatchFetch("https://router.example/fixture/usage")).json();
  const messages=snapshot.events.filter(e=>e.capability==="llm.messages");assert.equal(messages.length,4);
  for(const e of messages){assert.equal(e.actual_cost_micros,60);assert.equal(e.content_ref,null);}
  for(const e of messages.filter(e=>e.reserved_input_tokens!==1000000)) {
   assert.ok(e.reserved_input_tokens<3000,"#292 image bounds exclude base64 bytes");assert.ok(e.reserved_cost_micros<12020);
  }
  assert.equal(messages.filter(e=>e.reserved_input_tokens===1000000).length,1,"PDF retains full-window bound");
  const counts=snapshot.events.filter(e=>e.capability==="llm.count_tokens");
  assert.equal(counts.length,4);assert.ok(counts.every(e=>e.actual_cost_micros===0));
  for(const name of ["tenant:fixture","provider:anthropic"]) {
   const rows=await(await worker.dispatchFetch("https://router.example/fixture/rows?name="+name)).json();
   assert.equal(rows.filter(row=>row.reserved_micros===60 && row.settled===1).length,4);
  }
 } finally {await worker?.dispose();await rm(temporary,{recursive:true,force:true});}
});

test("declared oversize is rejected without reading and cancellation failures keep 413",async()=>{
 let pulls=0;
 const source=new ReadableStream({pull(){pulls++;},cancel(){throw Error("synthetic cancellation failure");}},{highWaterMark:0});
 const request=new Request("https://router.example/",{method:"POST",headers:{"content-length":String(limit+1)},body:source,duplex:"half"});
 await assert.rejects(readJson(request,undefined,limit),error=>error.status===413);
 assert.equal(pulls,0);
});

test("real workerd still denies a large PDF that exceeds its full-window hard budget",{timeout:60000},async()=>{
 const scratch=join(process.cwd(),".artifacts");await mkdir(scratch,{recursive:true});
 const temporary=await mkdtemp(join(scratch,"anthropic-ingress-budget-"));let worker;
 try {
  worker=await startWorkerdFixture(temporary,router,upstream);
  assert.equal((await worker.dispatchFetch("https://router.example/fixture/setup?limit=2000000")).status,200);
  const send=value=>worker.dispatchFetch("https://router.example/v1/messages",{method:"POST",headers:{authorization:key,"content-type":"application/json"},body:fragmented(JSON.stringify(value)),duplex:"half"});
  const pdf=body("document");
  const denied=await send(pdf);assert.equal(denied.status,402);assert.equal(denied.headers.get("x-clawrouter-error-code"),"budget_exhausted");await denied.text();
  // Unauthenticated large ingress and zero-charge behavior are covered below
  // with a workerd-owned source, avoiding Node upload-pump cancellation races.
  const snapshot=await(await worker.dispatchFetch("https://router.example/fixture/usage")).json();
  assert.equal(snapshot.events.length,1);assert.equal(snapshot.events[0].reserved_input_tokens,1000000);assert.equal(snapshot.events[0].actual_cost_micros,0);
  for(const name of ["tenant:fixture","provider:anthropic"]) {
   const rows=await(await worker.dispatchFetch("https://router.example/fixture/rows?name="+name)).json();
   assert.ok(rows.every(row=>row.reserved_micros===0));
  }
 } finally {await worker?.dispose();await rm(temporary,{recursive:true,force:true});}
});

test("chunked JSON preserves escaped Unicode, duplicate/prototype keys, numbers and optional fields",async()=>{
 const value=JSON.parse('{"__proto__":{"safe":true},"duplicate":1,"duplicate":2}');
 value.media="a".repeat(4095)+"😀"+"b".repeat(4094)+"\ud800"+"\udfff";
 value.text='"\\\b\t\n\f\r\u0000é界';value.array=[null,true,false,-0,1e30,1e-30];value.omitted=undefined;
 const expected=JSON.stringify(value);
 assert.equal(jsonBodyBytes(value),new TextEncoder().encode(expected).byteLength);
 const actual=await new Response(jsonBodyStream(value)).text();
 assert.equal(actual,expected);assert.deepEqual(JSON.parse(actual),JSON.parse(expected));
 for(const pad of ["", "x".repeat(8*1024*1024)]) {
  const wire=expected.slice(0,-1)+',"duplicate":3,"pad":'+JSON.stringify(pad)+'}';
  const request=new Request("https://router.example/",{method:"POST",body:fragmented(wire,pad?65535:7),duplex:"half"});
  assert.deepEqual(await readJson(request,undefined,limit),JSON.parse(wire),"both parsers preserve Unicode, own __proto__ and last duplicate key");
  assert.equal(request.body.locked,false);
 }
});

test("real workerd retains a large Claude request in R2 without whole-document transport copies",{timeout:60000},async()=>{
 const scratch=join(process.cwd(),".artifacts");await mkdir(scratch,{recursive:true});
 const temporary=await mkdtemp(join(scratch,"anthropic-ingress-retention-"));let worker;
 try {
  worker=await startWorkerdFixture(temporary,router,upstream,{r2Buckets:["CONTENT_ARCHIVE"]});
  assert.equal((await worker.dispatchFetch("https://router.example/fixture/setup?retain")).status,200);
  const vision=body();vision.metadata={user_id:"synthetic-é-界-😀"};
  const response=await worker.dispatchFetch("https://router.example/v1/messages",{method:"POST",headers:{authorization:key,"content-type":"application/json"},body:fragmented(JSON.stringify(vision)),duplex:"half"});
  assert.equal(response.status,200,response.ok?"":await response.text());await response.text();
  const archive=await(await worker.dispatchFetch("https://router.example/fixture/content")).json();
  assert.ok(archive.size>26*1024*1024);assert.equal(archive.provider,"anthropic");
  assert.deepEqual(archive.lengths,vision.messages[0].content.map(block=>block.source.data.length));assert.deepEqual(archive.metadata,vision.metadata);
  const snapshot=await(await worker.dispatchFetch("https://router.example/fixture/usage")).json();
  assert.equal(snapshot.events.length,1);assert.equal(snapshot.events[0].content_retained,true);assert.ok(snapshot.events[0].content_ref);assert.equal(snapshot.events[0].actual_cost_micros,60);
 } finally {await worker?.dispose();await rm(temporary,{recursive:true,force:true});}
});

for(const [name,text] of [
 ["dense containers",JSON.stringify(Array.from({length:65536},()=>[]))],
 ["deep nesting","[".repeat(128)+"0"+"]".repeat(128)],
 ["oversized object keys",JSON.stringify({["k".repeat(4097)]:1})],
 ["oversized numeric lexemes","1".repeat(4097)],
]) test(`expanded ingress rejects memory-amplifying JSON: ${name}`,async()=>{
 const padded='{"pad":"'+"x".repeat(8*1024*1024)+'","value":'+text+'}';
 const request=new Request("https://router.example/",{method:"POST",body:fragmented(padded),duplex:"half"});
 await assert.rejects(readJson(request,undefined,limit),error=>error.status===413&&error.code==="request_too_large");
 assert.equal(request.body.locked,false);
});

test("streamed ingress enforces bytes rather than decoded string length",async()=>{
 const text=JSON.stringify({input:"界".repeat(Math.floor(limit/3))});
 assert.ok(text.length<limit);assert.ok(new TextEncoder().encode(text).byteLength>limit);
 const request=new Request("https://router.example/",{method:"POST",body:fragmented(text),duplex:"half"});
 await assert.rejects(readJson(request,undefined,limit),error=>error.status===413);
 assert.equal(request.body.locked,false);
});


async function fixture(run) {
 const scratch=join(process.cwd(),".artifacts");await mkdir(scratch,{recursive:true});
 const temporary=await mkdtemp(join(scratch,"anthropic-admission-"));let worker;
 try {
  worker=await startWorkerdFixture(temporary,router,upstream);
  assert.equal((await worker.dispatchFetch("https://router.example/fixture/setup")).status,200);
  await run(worker);
 } finally {await worker?.dispose();await rm(temporary,{recursive:true,force:true});}
}
async function upload(worker,id,action="start",options={}) {
 const params=new URLSearchParams({id,action,...options});
 const pending=worker.dispatchFetch("https://router.example/fixture/upload?"+params);
 // Keep the creating workerd request context live while another request drives
 // its explicit barrier/cancellation; no cross-request resolution after EOF.
 if(action==="start") { void pending.then(response=>response.text()).catch(()=>{});return; }
 return (await pending).json();
}
async function waitUpload(worker,id,predicate) {
 const deadline=Date.now()+15000;
 while(Date.now()<deadline) {const state=await upload(worker,id,"state");if(state&&predicate(state))return state;await new Promise(resolve=>setTimeout(resolve,10));}
 assert.fail("upload did not reach expected state: "+id+" "+JSON.stringify(await upload(worker,id,"state")));
}

test("real workerd preserves sub-8 MiB native-valid 25k-message and 70k-number requests",{timeout:60000},async t=>fixture(async worker=>{
 const numbers=Array.from({length:70000},(_,i)=>i%97);
 const cases=[
  {model:"claude-opus-5-5",max_tokens:1,messages:Array.from({length:25000},(_,i)=>({role:i%2?"assistant":"user",content:"hi"}))},
  {model:"claude-opus-5-5",max_tokens:1,tools:[{name:"plot",input_schema:{type:"object"}}],messages:[{role:"user",content:"plot"},{role:"assistant",content:[{type:"tool_use",id:"toolu_1",name:"plot",input:{values:numbers}}]},{role:"user",content:[{type:"tool_result",tool_use_id:"toolu_1",content:"ok"}]}]},
 ];
 for(const body of cases) for(const path of ["/v1/messages","/v1/native/anthropic/v1/messages","/v1/proxy/anthropic/messages"]) await t.test(`${body.messages.length===25000?"25k messages":"70k numbers"} via ${path}`,async()=>{
  const text=JSON.stringify(path.includes("/proxy/")?{body}:body);assert.ok(Buffer.byteLength(text)<8*1024*1024);
  const response=await worker.dispatchFetch("https://router.example"+path,{method:"POST",headers:{authorization:key,"content-type":"application/json"},body:fragmented(text),duplex:"half"});
  assert.equal(response.status,200,await response.clone().text());
  const actual=JSON.parse((await response.json()).content[0].text);
  assert.equal(actual.messages,body.messages.length);assert.deepEqual(actual.values,body.messages.length===25000?null:numbers);
 });
}));

test("real workerd stops unauthenticated 30 MB Claude uploads near 8 MiB",{timeout:60000},()=>fixture(async worker=>{
 for(const route of ["/v1/messages","/v1/native/anthropic/v1/messages/count_tokens","/v1/proxy/anthropic/messages"]) for(const auth of ["anonymous","invalid"]) {
  const id=route+auth;
  await upload(worker,id,"start",{route,[auth]:"1",bytes:"30000000",free:"1"});
  const state=await waitUpload(worker,id,s=>s.status);
  assert.equal(state.status,401);assert.ok(state.read<=8*1024*1024+65536,JSON.stringify(state));
 }
 const snapshot=await(await worker.dispatchFetch("https://router.example/fixture/usage")).json();assert.equal(snapshot.events.length,0);
}));

test("real workerd limits expanded Claude uploads to two and releases success, parse error, rejection and cancel",{timeout:120000},()=>fixture(async worker=>{
 const start=async(id,options={})=>{await upload(worker,id,"start",options);return waitUpload(worker,id,s=>s.held||s.status);};
 assert.equal((await start("one")).held,true);assert.equal((await start("two",{route:"/v1/proxy/anthropic/messages"})).held,true);
 const denied=await start("three");assert.equal(denied.status,503);assert.equal(denied.retry,"1");
 assert.equal((await start("count-overload",{route:"/v1/native/anthropic/v1/messages/count_tokens"})).status,503,"token counting shares the same isolate bound");
 assert.equal(denied.result.type,"error");assert.equal(denied.result.error.type,"overloaded_error");
 assert.equal((await start("anonymous",{anonymous:"1"})).status,401,"authentication precedes overload");
 const snapshot=await(await worker.dispatchFetch("https://router.example/fixture/usage")).json();assert.equal(snapshot.events.length,0,"overload is unsent and nonbillable");
 for(const name of ["tenant:fixture","provider:anthropic"])assert.deepEqual(await(await worker.dispatchFetch("https://router.example/fixture/rows?name="+name)).json(),[]);
 assert.equal((await start("small",{bytes:"1024",free:"1"})).status,200,"small requests do not consume expanded slots");
 await upload(worker,"one","release");assert.equal((await waitUpload(worker,"one",s=>s.status)).status,200);
 assert.equal((await start("malformed",{malformed:"1"})).held,true,"success frees a slot");
 await upload(worker,"two","cancel");await waitUpload(worker,"two",s=>s.status);
 assert.equal((await start("rejection",{mode:"reject"})).held,true,"ingress cancellation frees a slot");
 await upload(worker,"malformed","release");assert.equal((await waitUpload(worker,"malformed",s=>s.status)).status,400);
 assert.equal((await start("replacement")).held,true,"parse error frees a slot");
 await upload(worker,"rejection","release");assert.equal((await waitUpload(worker,"rejection",s=>s.status)).status,500);
 assert.equal((await start("last")).held,true,"upstream rejection frees a slot");
 for(const id of ["replacement","last"]) {await upload(worker,id,"release");assert.equal((await waitUpload(worker,id,s=>s.status)).status,200);}
}));

test("real workerd holds expanded slots through response delivery and frees them on caller cancellation",{timeout:60000},()=>fixture(async worker=>{
 for(const id of ["stream1","stream2"]) {await upload(worker,id,"start",{mode:"stream",free:"1"});assert.equal((await waitUpload(worker,id,s=>s.headersStatus)).headersStatus,200);}
 await upload(worker,"overload","start",{free:"1"});assert.equal((await waitUpload(worker,"overload",s=>s.status)).status,503);
 await upload(worker,"stream1","cancel");await waitUpload(worker,"stream1",s=>s.status);
 await upload(worker,"after-cancel","start",{free:"1"});assert.equal((await waitUpload(worker,"after-cancel",s=>s.status)).status,200);
 await upload(worker,"stream2","cancel");await waitUpload(worker,"stream2",s=>s.status);
}));
