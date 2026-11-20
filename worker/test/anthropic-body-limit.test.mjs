import assert from "node:assert/strict";
import test from "node:test";
import { crc32, deflateSync } from "node:zlib";
import { createHash } from "node:crypto";
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
 if(path==="/fixture/retention") {
  // This OUTER fixture request owns delivery and all original background roots.
  // Production's small-archive waitUntil scheduling remains unchanged.
  const roots=[],failures=[],effects={reserve:0,provider:0,r2:0,usage:0};
  let closed=false,hasPrimary=false,primary,status,errorCode,result;
  const track=work=>{if(closed)throw Error("retention fixture enrollment closed");const outcome=Promise.resolve(work).then(value=>({failed:false,value}),error=>({failed:true,error}));roots.push(outcome);return work;};
  const consume=async body=>{
   const reader=body.getReader(),decoder=new TextDecoder(),cleanup=[];let text="",eof=false,failed=false,reason;
   try{for(;;){const part=await reader.read();if(part.done){eof=true;break;}text+=decoder.decode(part.value,{stream:true});}text+=decoder.decode();}
   catch(error){failed=true;reason=error;}
   finally{if(!eof)try{await reader.cancel();}catch(error){cleanup.push(error);}try{reader.releaseLock();}catch(error){cleanup.push(error);}}
   if(cleanup.length)throw new AggregateError(failed?[reason,...cleanup]:cleanup,"retention fixture body cleanup");if(failed)throw reason;return text;
  };
  const nativeFetch=globalThis.fetch;
  const selectedEnv={...env,ANTHROPIC_API_KEY:"fixture-upstream-key",
   BUDGET_LEDGER:{idFromName:name=>env.BUDGET_LEDGER.idFromName(name),get:id=>{const stub=env.BUDGET_LEDGER.get(id);return {fetch(input,init){if(new URL(String(input)).pathname==="/reserve")effects.reserve++;return stub.fetch(input,init);}};}},
   CONTENT_ARCHIVE:{put(...args){effects.r2++;return track(env.CONTENT_ARCHIVE.put(...args));}},
   USAGE_QUEUE:{send(event){effects.usage++;return track(ingestUsage(env,event));}}};
  const ownedContext={waitUntil:track};
  globalThis.fetch=(input,init)=>{if(String(input).startsWith("https://api.anthropic.com/"))effects.provider++;return nativeFetch(input,init);};
  try{
   const response=await worker.fetch(new Request("https://router.example/v1/messages",request),selectedEnv,ownedContext);
   status=response.status;errorCode=response.headers.get("x-clawrouter-error-code");
   const text=await track(consume(response.body));
   if(status===503&&JSON.parse(text).error.message!=="accounting preflight is unavailable")throw Error("unexpected retained denial");
  }catch(error){hasPrimary=true;primary=error;}
  finally{
   // A settled parent may have enrolled children. Every tag is joined, even
   // when distinct roots reject with undefined or the same reason object.
   let joined=0;while(joined<roots.length){const batch=roots.slice(joined);joined=roots.length;for(const outcome of await Promise.all(batch))if(outcome.failed)failures.push(outcome.error);}
   closed=true;globalThis.fetch=nativeFetch;
  }
  if(failures.length)throw new AggregateError(hasPrimary?[primary,...failures]:failures,"retention fixture roots");if(hasPrimary)throw primary;
  // These reads follow the actual joins in the SAME originating request.
  const snapshot=JSON.parse(await consume((await usageStub(env,"tenant","fixture").fetch("https://usage/snapshot?events=admin")).body));
  const objects=await env.CONTENT_ARCHIVE.list();
  result={kind:"fixture-owned delivery and original background joins before R2/usage inspection",status,errorCode,effects,events:snapshot.events.length,archives:objects.objects.length,closed,joined:roots.length};
  if(status===200){
   if(objects.objects.length!==1||snapshot.events.length!==1)throw Error("unexpected retained result count");
   const object=await env.CONTENT_ARCHIVE.get(objects.objects[0].key),bytes=new Uint8Array(await object.arrayBuffer());
   const record=JSON.parse(new TextDecoder().decode(bytes)),event=snapshot.events[0];
   if(!Number.isSafeInteger(record.occurredAtMs)||!/^content_[a-f0-9]{32}$/.test(event.content_ref))throw Error("invalid retained metadata");
   const expected={version:"clawrouter.retained-request.v1",contentRef:event.content_ref,requestId:request.headers.get("x-request-id"),occurredAtMs:record.occurredAtMs,expiresAtMs:record.occurredAtMs+30*86400000,tenantId:"tenant",policyId:"fixture",credentialId:"fixture",principalId:null,provider:"anthropic",capability:"llm.messages",model:"anthropic/claude-opus-5-5",body:record.body};
   const expectedBytes=new TextEncoder().encode(JSON.stringify(expected));
   const completeBytesEqual=bytes.length===expectedBytes.length&&bytes.every((value,index)=>value===expectedBytes[index]);
   const digest=async value=>[...new Uint8Array(await crypto.subtle.digest("SHA-256",value))].map(value=>value.toString(16).padStart(2,"0")).join("");
   result.archive={size:object.size,completeBytesEqual,sha256:await digest(bytes),expectedSha256:await digest(expectedBytes),bodySha256:await sha256Hex(JSON.stringify(record.body)),provider:record.provider,metadata:record.body.metadata};
   result.receipt={requestId:event.request_id,contentRef:event.content_ref,retained:event.content_retained,cost:event.actual_cost_micros};
  }
  return Response.json(result);
 }
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
   if(next.read>=Number(url.searchParams.get("hold")??8*1024*1024+65536)&&!next.released) { next.held=true;while(!next.released&&!next.abort.signal.aborted)await new Promise(resolve=>setTimeout(resolve,10)); }
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

test("JSON byte counting matches JSON.stringify across escapes, surrogates and chunk boundaries",()=>{
 const units=["a","\n",'"',"\\","\u0001","\u007f","\u0080","é","€","\u2028","🦊","\ud800","\udfff","日"];
 let seed=7;const next=n=>(seed=(seed*1103515245+12345)&0x7fffffff)%n;
 for(let round=0;round<200;round++) {
  const text=(next(2)?"x".repeat(4095-next(2)):"")+Array.from({length:next(6000)},()=>units[next(units.length)]).join("");
  const value={[text.slice(0,9)]:text,list:[text.slice(next(40)),undefined,-0,NaN,1e21,{nested:text,omitted:undefined}]};
  assert.equal(jsonBodyBytes(value),new TextEncoder().encode(JSON.stringify(value)).byteLength,`round ${round}`);
 }
 assert.throws(()=>jsonBodyBytes({value:1n}),TypeError);
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

test("real workerd denies oversized retained Claude input and joins a complete admitted R2 archive",{timeout:60000},async t=>{
 const scratch=join(process.cwd(),".artifacts");await mkdir(scratch,{recursive:true});
 const temporary=await mkdtemp(join(scratch,"anthropic-ingress-retention-"));let worker,hasPrimary=false,primary;
 const roots=[];
 const observe=work=>{roots.push(work.then(value=>({failed:false,value}),error=>({failed:true,error})));return work;};
 t.after(async()=>{
  const failures=[];for(const outcome of await Promise.all(roots))if(outcome.failed)failures.push(outcome.error);
  try{await worker?.dispose();}catch(error){failures.push(error);}
  try{await rm(temporary,{recursive:true,force:true});}catch(error){failures.push(error);}
  if(failures.length)throw new AggregateError(hasPrimary?[primary,...failures]:failures,"retention host cleanup");
 });
 const call=(url,init)=>observe((async()=>{const response=await worker.dispatchFetch(url,init);const text=await response.text();assert.equal(response.status,200,text);return JSON.parse(text);})());
 try {
  worker=await startWorkerdFixture(temporary,router,upstream,{r2Buckets:["CONTENT_ARCHIVE"]});
  assert.equal((await call("https://router.example/fixture/setup?retain")).ok,true);
  const vision=body();vision.metadata={user_id:"synthetic-é-界-😀"};
  const oversized=JSON.stringify(vision);assert.equal(Buffer.byteLength(oversized),27963145);assert.ok(Buffer.byteLength(oversized)<limit);
  const send=(text,id)=>call("https://router.example/fixture/retention",{method:"POST",headers:{authorization:key,"content-type":"application/json","x-request-id":id},body:fragmented(text),duplex:"half"});
  const denied=await send(oversized,"fixture-retention-denied");
  assert.equal(denied.status,503);assert.equal(denied.errorCode,"accounting_preflight_unavailable");
  assert.deepEqual(denied.effects,{reserve:0,provider:0,r2:0,usage:0});assert.equal(denied.events,0);assert.equal(denied.archives,0);assert.equal(denied.closed,true);
  vision.messages[0].content=vision.messages[0].content.slice(0,1);
  const admitted=JSON.stringify(vision),result=await send(admitted,"fixture-retention-admitted");
  assert.equal(result.status,200);assert.equal(result.closed,true);assert.ok(result.joined>0);
  assert.deepEqual(result.effects,{reserve:2,provider:1,r2:1,usage:1});assert.equal(result.events,1);assert.equal(result.archives,1);
  assert.ok(result.archive.size>5*1024*1024&&result.archive.size<8*1024*1024);
  assert.equal(result.archive.completeBytesEqual,true);assert.equal(result.archive.sha256,result.archive.expectedSha256);
  assert.equal(result.archive.bodySha256,createHash("sha256").update(admitted).digest("hex"));
  assert.equal(result.archive.provider,"anthropic");assert.deepEqual(result.archive.metadata,vision.metadata);
  assert.equal(result.receipt.requestId,"fixture-retention-admitted");assert.equal(result.receipt.retained,true);assert.ok(result.receipt.contentRef);assert.equal(result.receipt.cost,60);
 }catch(error){hasPrimary=true;primary=error;throw error;}
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

// A held 30 MB upload leases about 57 MiB of the 96 MiB isolate body budget,
// so a second one cannot fit until the first releases its lease.
const big={bytes:"30000000",hold:String(28*1024*1024)};
test("real workerd budgets large Claude uploads by bytes and releases success, parse error, rejection and cancel",{timeout:180000},()=>fixture(async worker=>{
 const start=async(id,options={})=>{await upload(worker,id,"start",{...big,...options});return waitUpload(worker,id,s=>s.held||s.status);};
 assert.equal((await start("one")).held,true);
 const denied=await start("three",{route:"/v1/proxy/anthropic/messages"});assert.equal(denied.status,503);assert.equal(denied.retry,"1");
 assert.ok(denied.read<28*1024*1024,"refused while reading, before holding the full body");
 assert.equal((await start("count-overload",{route:"/v1/native/anthropic/v1/messages/count_tokens"})).status,503,"token counting shares the same isolate budget");
 assert.equal(denied.result.type,"error");assert.equal(denied.result.error.type,"overloaded_error");
 assert.equal((await start("anonymous",{anonymous:"1"})).status,401,"authentication precedes overload");
 const snapshot=await(await worker.dispatchFetch("https://router.example/fixture/usage")).json();assert.equal(snapshot.events.length,0,"overload is unsent and nonbillable");
 for(const name of ["tenant:fixture","provider:anthropic"])assert.deepEqual(await(await worker.dispatchFetch("https://router.example/fixture/rows?name="+name)).json(),[]);
 assert.equal((await start("small",{bytes:"1024",free:"1"})).status,200,"small requests lease nothing");
 await upload(worker,"one","release");assert.equal((await waitUpload(worker,"one",s=>s.status)).status,200);
 assert.equal((await start("malformed",{malformed:"1"})).held,true,"success frees its lease");
 await upload(worker,"malformed","release");assert.equal((await waitUpload(worker,"malformed",s=>s.status)).status,400);
 assert.equal((await start("replacement")).held,true,"parse error frees its lease");
 await upload(worker,"replacement","cancel");await waitUpload(worker,"replacement",s=>s.status);
 assert.equal((await start("rejection",{mode:"reject"})).held,true,"ingress cancellation frees its lease");
 await upload(worker,"rejection","release");assert.equal((await waitUpload(worker,"rejection",s=>s.status)).status,500);
 assert.equal((await start("last")).held,true,"upstream rejection frees its lease");
 await upload(worker,"last","release");assert.equal((await waitUpload(worker,"last",s=>s.status)).status,200);
}));

test("real workerd holds body leases through response delivery and frees them on caller cancellation",{timeout:90000},()=>fixture(async worker=>{
 await upload(worker,"stream","start",{...big,mode:"stream",free:"1"});assert.equal((await waitUpload(worker,"stream",s=>s.headersStatus)).headersStatus,200);
 await upload(worker,"overload","start",{...big,free:"1"});assert.equal((await waitUpload(worker,"overload",s=>s.status)).status,503);
 await upload(worker,"stream","cancel");await waitUpload(worker,"stream",s=>s.status);
 await upload(worker,"after-cancel","start",{...big,free:"1"});assert.equal((await waitUpload(worker,"after-cancel",s=>s.status)).status,200);
}));
