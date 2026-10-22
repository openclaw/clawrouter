import assert from "node:assert/strict";
import test from "node:test";
import { crc32, deflateSync } from "node:zlib";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { startWorkerdFixture } from "../../test/helpers/workerd.mjs";
import { readJson } from "../utils.ts";
import { jsonBodyBytes, jsonBodyStream } from "../json-body.ts";

const limit = 32 * 1024 * 1024;
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
 return worker.fetch(request,{...env,ANTHROPIC_API_KEY:"fixture-upstream-key",USAGE_QUEUE:{send:event=>ingestUsage(env,event)}},context);
}};`;
const upstream = `export default { async fetch(request) {
 if(!request.url.startsWith("https://api.anthropic.com/v1/messages")) throw Error("unexpected upstream");
 const body=await request.json();
 const blocks=body.messages[0].content;
 if(body.model!=="claude-opus-5-5" || !Array.isArray(blocks) || !blocks.length) throw Error("lost native request");
 // Inspect forwarded media, not just the response status: the complete large
 // strings must survive ingress, provider transforms, pricing and dispatch.
 const lengths=blocks.map(block=>block.source.data.length);
 if(request.url.endsWith("count_tokens")) return Response.json({input_tokens:123,lengths});
 return Response.json({type:"message",content:[{type:"text",text:JSON.stringify(lengths)}],stop_reason:"end_turn",usage:{input_tokens:10,output_tokens:1}});
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
   assert.equal(response.status,status);if(status===413)assert.equal((await response.json()).error.code,"request_too_large");else await response.text();
  }
  const invalid=await worker.dispatchFetch("https://router.example/v1/messages",{method:"POST",headers:{authorization:key,"content-type":"application/json"},body:fragmented(serialized.slice(0,-1)),duplex:"half"});
  assert.equal(invalid.status,400);assert.equal((await invalid.json()).error.code,"invalid_json");
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
  const send=(value,authorization=key)=>worker.dispatchFetch("https://router.example/v1/messages",{method:"POST",headers:{authorization,"content-type":"application/json"},body:fragmented(JSON.stringify(value)),duplex:"half"});
  const pdf=body("document");
  const denied=await send(pdf);assert.equal(denied.status,402);assert.equal((await denied.json()).error.code,"budget_exhausted");
  const unauthorized=await send(pdf,"Bearer synthetic-invalid");assert.equal(unauthorized.status,401);await unauthorized.text();
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
 const request=new Request("https://router.example/",{method:"POST",body:fragmented(expected,7),duplex:"half"});
 assert.deepEqual(await readJson(request,undefined,limit),JSON.parse(expected),"streamed ingress preserves the same JSON values");
 assert.equal(request.body.locked,false);
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
 ["deep nesting","[".repeat(129)+"0"+"]".repeat(129)],
 ["oversized object keys",JSON.stringify({["k".repeat(4097)]:1})],
 ["oversized numeric lexemes","1".repeat(4097)],
]) test(`expanded ingress rejects memory-amplifying JSON: ${name}`,async()=>{
 const request=new Request("https://router.example/",{method:"POST",body:fragmented(text,1024),duplex:"half"});
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
