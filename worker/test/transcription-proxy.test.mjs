import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { sqlBudgetNamespace } from "./sql-budget-namespace.mjs";
import { proxyKey, usageEnv } from "./usage-budget-fixture.mjs";
const { default: handler } = await import("../index.ts");
const { providerById } = await import("../providers.ts");
const { operationAffordability } = await import("../operation-budget.ts");
const { transcriptionLimits } = await import("../transcription-body.ts");

const audio = new Uint8Array([0,255,128,42]);
const validUsage = { type:"tokens", input_tokens:14, input_token_details:{ audio_tokens:12,text_tokens:2 }, output_tokens:45,total_tokens:59 };
const owners = ["tenant:maintainer_access:owner@example.com","provider:openai"];
function form(fields = {}, file = new File([audio], "sample.wav", {type:"audio/wav"})) {
  const body = new FormData(); body.set("model","openai/gpt-4o-transcribe"); body.set("file",file);
  for(const [key,value] of Object.entries(fields)) body.set(key,value);
  return body;
}
function fixture(t, options = {}, policy = {}) {
  const env = usageEnv([], { limit:1_000_000, fixedCost:200, retainContent:false, ...options });
  const events=[], pending=[], retained=[], admissions=[], ledger=sqlBudgetNamespace(t);
  const original = env.ACCESS_CONTROL.get;
  let authorityEdit = value => value;
  env.ACCESS_CONTROL.get = (...args) => {
    const stub=original(...args);
    return { fetch: async (url,init) => {
      const response=await stub.fetch(url,init), value=await response.json();
      if(value.policy) Object.assign(value.policy.policy,policy);
      if(new URL(url).pathname === "/admission/resolve") admissions.push(JSON.parse(init.body));
      return Response.json(authorityEdit(value));
    } };
  };
  env.BUDGET_LEDGER=ledger; env.OPENAI_API_KEY="fixture-upstream-key";
  env.USAGE_QUEUE={send:async event => events.push(event)};
  env.CONTENT_ARCHIVE={put:async (...args)=>retained.push(args)};
  const call = (body=form(), {path="/v1/audio/transcriptions",headers={},signal}={}) => handler.fetch(new Request("https://router.example"+path,{method:"POST",headers:{authorization:"Bearer "+proxyKey(),...headers},body,signal,...(body instanceof ReadableStream ? {duplex:"half"} : {})}),env,{waitUntil:p=>pending.push(p)});
  return {env,events,pending,retained,ledger,call,admissions,editAuthority(fn){authorityEdit=fn}};
}

for(const path of ["/v1/audio/transcriptions","/v1/native/openai/v1/audio/transcriptions","/v1/proxy/openai/transcriptions"]) test("transcription exact multipart and fixed durable accounting: "+path,async t=>{
  const f=fixture(t);
  const upstream=t.mock.method(globalThis,"fetch",async(url,init)=>{
    assert.equal(String(url),"https://api.openai.com/v1/audio/transcriptions");
    assert.equal(init.redirect,"manual"); assert.equal(init.headers.get("authorization"),"Bearer fixture-upstream-key");
    assert.equal(init.headers.has("x-api-key"),false); assert.equal(init.headers.has("content-type"),false);
    const body=init.body; assert.ok(body instanceof FormData);
    assert.equal(body.get("model"),"gpt-4o-transcribe"); assert.equal(body.get("prompt"),"synthetic prompt é"); assert.equal(body.get("language"),"en");
    assert.equal(body.get("file").name,"sample.wav"); assert.equal(body.get("file").type,"audio/wav");
    assert.deepEqual(new Uint8Array(await body.get("file").arrayBuffer()),audio);
    return Response.json({text:"synthetic transcript",usage:validUsage},{headers:{"set-cookie":"not-forwarded"}});
  });
  const response=await f.call(form({model:path.includes("native") ? "gpt-4o-transcribe":"openai/gpt-4o-transcribe",language:"en",prompt:"synthetic prompt é",stream:"false",response_format:"json"}),{path,headers:{"x-api-key":"not-an-upstream-key"}});
  assert.equal(response.status,200,await response.clone().text()); assert.equal((await response.json()).text,"synthetic transcript");
  assert.equal(response.headers.get("x-clawrouter-content-retention"),"off"); assert.equal(response.headers.has("set-cookie"),false);
  await Promise.all(f.pending); assert.equal(upstream.mock.callCount(),1); assert.equal(f.events.length,1); assert.equal(f.retained.length,0);
  assert.equal(f.events[0].total_tokens,59); assert.equal(f.events[0].actual_cost_micros,200); assert.equal(f.events[0].cost_basis,"policy_fixed");
  assert.equal(f.events[0].model,"openai/gpt-4o-transcribe"); assert.equal(f.events[0].content_retained,false);
  assert.ok(!JSON.stringify(f.events).includes("synthetic"));
  assert.equal(f.admissions[0].selection,undefined); assert.equal(f.admissions[1].selection.model,"gpt-4o-transcribe");
  for(const name of owners) { const rows=f.ledger.get(name).reservations(); assert.equal(rows.length,1); assert.equal(rows[0].dispatch_started,1); assert.equal(rows[0].settled,1); assert.equal(rows[0].reserved_micros,200); }
});

test("unauthenticated upload is never read, including invalid MIME/claimed oversized content",async t=>{
  const f=fixture(t); let reads=0;
  const stream=new ReadableStream({pull(){reads++;}},{highWaterMark:0});
  const response=await f.call(stream,{headers:{authorization:"invalid","content-type":"bad","content-length":String(transcriptionLimits.raw+1)}});
  assert.equal(response.status,401); assert.equal(reads,0); assert.equal(f.events.length,0);
  await stream.cancel();
});

test("multipart rejects duplicates, type confusion, options, names and malformed framing before egress",async t=>{
  const f=fixture(t), upstream=t.mock.method(globalThis,"fetch",async()=>{throw new Error("invalid input escaped");});
  const bad=[];
  for(const key of ["model","file"]) { const b=form(); b.append(key,key==="file"?new File([audio],"second.wav",{type:"audio/wav"}):"openai/gpt-4o-transcribe"); bad.push(b); }
  for(const fields of [{stream:"true"},{response_format:"text"},{chunking_strategy:"auto"},{diarization:"true"},{speaker:"a"},{timestamp_granularities:"word"},{logprobs:"true"},{language:"eng"},{prompt:"p".repeat(16385)},{model:"openai/whisper-1"},{model:"google/gpt-4o-transcribe"},{file:"not a File"},{model:new File([audio],"model.wav",{type:"audio/wav"})}]) bad.push(form(fields));
  for(const name of ["../unsafe.wav","C:\\unsafe.wav","bad.txt","bad"+String.fromCharCode(0)+".wav"]) bad.push(form({},new File([audio],name,{type:"audio/wav"})));
  bad.push(form({},new File([],"empty.wav",{type:"audio/wav"})),form({},new File([audio],"wrong.wav",{type:"text/plain"})));
  for(const b of bad) { const response=await f.call(b); assert.ok([400,413].includes(response.status),await response.text()); }
  for(const [body,type] of [["--wrong--","multipart/form-data; boundary=expected"],["{}","application/json"],["--x"+crlf+'Content-Disposition: form-data; name="model"'+crlf.repeat(2)+"x","multipart/form-data; boundary=x"]]) {
    const response=await f.call(body,{headers:{"content-type":type}}); assert.equal(response.status,400);
  }
  assert.equal(upstream.mock.callCount(),0); for(const name of owners) assert.equal(f.ledger.get(name).reservations().length,0);
});

test("chunked oversize is bounded without Content-Length and cancels the raw reader",async t=>{
  const f=fixture(t);let pulls=0,cancels=0;
  const upstream=t.mock.method(globalThis,"fetch",async()=>{throw new Error("oversize escaped");});
  const stream=new ReadableStream({pull(c){pulls++;c.enqueue(new Uint8Array(1_000_000));},cancel(){cancels++;}},{highWaterMark:0});
  const response=await f.call(stream,{headers:{"content-type":"multipart/form-data; boundary=x"}});
  assert.equal(response.status,413); assert.equal(pulls,26); assert.equal(cancels,1); assert.equal(upstream.mock.callCount(),0);
});

for(const bound of ["policy","provider","daily","weekly"]) test("unqualified whole upload blocks enforced "+bound+" budget and catalog",async t=>{
  const f=fixture(t,{limit:bound==="policy"?1_000_000:null,providerLimit:bound==="provider"?1_000_000:null,fixedCost:null,dailyLimit:bound==="daily"?1_000_000:undefined,weeklyLimit:bound==="weekly"?1_000_000:undefined});
  const upstream=t.mock.method(globalThis,"fetch",async()=>{throw new Error("unqualified upload escaped");});
  const response=await f.call(); assert.equal(response.status,400); assert.equal((await response.json()).error.code,"pricing_required"); assert.equal(upstream.mock.callCount(),0);
  const provider=providerById("openai"),model=provider.models.find(x=>x.id==="openai/gpt-4o-transcribe"),endpoint=provider.endpoints.find(x=>x.id==="transcriptions");
  const p={monthlyBudgetMicros:bound==="policy"?1_000_000:null,requestCostMicros:null,dailyBudgetMicros:bound==="daily"?1_000_000:null,weeklyBudgetMicros:bound==="weekly"?1_000_000:null};
  assert.deepEqual(operationAffordability({policy:p},{monthlyBudgetMicros:bound==="provider"?1_000_000:null},model,"audio.transcription",endpoint),{status:"exact-blocked",reasonCode:"pricing_required"});
});

for(const mode of ["unmetered","soft"]) test("authoritative token usage is measured in explicit "+mode+" mode, not bounded by one context",async t=>{
  const f=fixture(t,{limit:mode==="soft"?1_000_000:null,providerLimit:mode==="soft"?1_000_000:null,fixedCost:null},{budgetMode:mode==="soft"?"soft":"reserve"});
  t.mock.method(globalThis,"fetch",async()=>Response.json({text:"synthetic",usage:{...validUsage,input_tokens:20000,input_token_details:{audio_tokens:19998,text_tokens:2},total_tokens:20045}}));
  const response=await f.call(); assert.equal(response.status,200); await response.json();
  assert.equal(f.events[0].actual_cost_micros,50450); assert.equal(f.events[0].cost_basis,"manifest_pricing"); assert.equal(f.events[0].reserved_input_tokens,null); assert.equal(f.events[0].reserved_cost_micros,0);
});

for(const usage of [undefined,{}, {...validUsage,type:"duration"},{...validUsage,input_tokens:"14"},{...validUsage,output_tokens:-1},{...validUsage,total_tokens:58},{...validUsage,input_token_details:{audio_tokens:13,text_tokens:2}},{...validUsage,input_token_details:null},{...validUsage,input_tokens:1.5}]) test("invalid/missing transcription usage stays explicitly unknown: "+JSON.stringify(usage),async t=>{
  const f=fixture(t,{limit:null,providerLimit:null,fixedCost:null});
  t.mock.method(globalThis,"fetch",async()=>Response.json({text:"synthetic transcript",usage}));
  const response=await f.call(); assert.equal(response.status,200); assert.equal(response.headers.get("x-clawrouter-accounting"),"unpriced-usage");
  assert.equal(f.events[0].total_tokens,null); assert.equal(f.events[0].cost_basis,"unpriced_usage");
  assert.equal(f.events[0].actual_cost_micros,0,"numeric storage placeholder is explicitly unknown, not none/free");
});

for(const scenario of ["missing-usage","malformed-json","truncated-length","wrong-mime","oversized-response","fetch-error","read-error","rejection401","rejection429","redirect"]) test("post-dispatch "+scenario+" never replays and retains explicit fixed accounting unless rejected",async t=>{
  const f=fixture(t); let canceled=0;
  const upstream=t.mock.method(globalThis,"fetch",async()=>{
    if(scenario==="fetch-error") throw new Error("synthetic network loss");
    if(scenario==="rejection401"||scenario==="rejection429") return Response.json({error:{message:"synthetic rejection"}},{status:scenario==="rejection401"?401:429,headers:{"retry-after":"3","set-cookie":"secret"}});
    if(scenario==="redirect") return new Response("redirect",{status:307,headers:{location:"https://not-followed.example"}});
    if(scenario==="malformed-json") return new Response('{"text":"partial",',{headers:{"content-type":"application/json"}});
    if(scenario==="wrong-mime") return new Response("synthetic",{headers:{"content-type":"text/plain"}});
    if(scenario==="truncated-length") return Response.json({text:"synthetic",usage:validUsage},{headers:{"content-length":"100000"}});
    if(scenario==="read-error") return new Response(new ReadableStream({pull(c){c.error(new Error("synthetic truncated"));}}),{headers:{"content-type":"application/json"}});
    if(scenario==="oversized-response") return new Response(new ReadableStream({pull(c){c.enqueue(new Uint8Array(1_000_000));},cancel(){canceled++;}},{highWaterMark:0}),{headers:{"content-type":"application/json"}});
    return Response.json({text:"synthetic"});
  });
  const response=await f.call(); const rejection=scenario.startsWith("rejection");
  assert.equal(response.status,rejection?Number(scenario.slice(-3)):scenario==="missing-usage"?200:502);
  if(rejection) { assert.equal((await response.json()).error.message,"synthetic rejection"); assert.equal(response.headers.get("retry-after"),"3");assert.equal(response.headers.has("set-cookie"),false); }
  assert.equal(upstream.mock.callCount(),1); assert.equal(f.events.length,1); assert.equal(f.events[0].actual_cost_micros,rejection?0:200); assert.equal(f.events[0].cost_basis,rejection?"none":"policy_fixed");
  for(const name of owners) assert.equal(f.ledger.get(name).reservations()[0].reserved_micros,rejection?0:200);
  if(scenario==="oversized-response") assert.equal(canceled,1);
});

test("dispatch ACK failure sends no upload and refunds all four SQL budget legs",async t=>{
  const f=fixture(t,{dailyLimit:1_000_000,weeklyLimit:1_000_000});
  const get=f.ledger.get.bind(f.ledger), names=new Set();
  f.env.BUDGET_LEDGER={idFromName:x=>x,get(name){names.add(name);const stub=get(name);return {fetch:(url,init)=>new URL(url).pathname==="/dispatch"?Response.json({dispatched:false}):stub.fetch(url,init)}}};
  const upstream=t.mock.method(globalThis,"fetch",async()=>{throw new Error("dispatch failure escaped");});
  const response=await f.call();assert.equal(response.status,503);assert.equal((await response.json()).error.code,"accounting_unavailable");assert.equal(upstream.mock.callCount(),0);
  // Monthly/day/week intentionally share the principal's physical SQL shard.
  const rows=[...names].flatMap(name=>get(name).reservations());
  assert.equal(rows.length,4);assert.equal(new Set(rows.map(row=>row.reservation_id)).size,4);
  assert.equal(f.events[0].actual_cost_micros,0);
  for(const row of rows) {assert.equal(row.settled,1);assert.equal(row.reserved_micros,0);}
});

for(const scenario of ["revoked-after-read","model-denied","provider-denied","grant-denied"]) test("fresh operation authority enforces "+scenario+" before egress",async t=>{
  const f=fixture(t); let admissions=0;
  f.editAuthority(value=>{
    if(value.credential && ++admissions===2) {
      if(scenario==="revoked-after-read") value.credential.credential.enabled=false;
      if(scenario==="model-denied") value.policy.policy.models=["openai/tts-1"];
      if(scenario==="provider-denied") value.policy.policy.providers=["anthropic"];
      if(scenario==="grant-denied") value.selection={selected:null,hasConfiguredGrant:true};
    } return value;
  });
  const upstream=t.mock.method(globalThis,"fetch",async()=>{throw new Error("authority denial escaped");});
  const response=await f.call();assert.equal(response.status,scenario==="grant-denied"?503:403);assert.equal(upstream.mock.callCount(),0);
});

for(const before of [true,false]) test("cancellation "+(before?"before":"after")+" dispatch owns settlement and late response disposal",async t=>{
  const f=fixture(t), caller=new AbortController();let cancel=0,entered;
  const reached=new Promise(resolve=>{entered=resolve;});
  const upstream=t.mock.method(globalThis,"fetch",async(_url,init)=>{
    entered();
    return new Response(new ReadableStream({pull(){caller.abort(new Error("synthetic canceled"));},cancel(){cancel++;}},{highWaterMark:0}),{headers:{"content-type":"application/json"}});
  });
  if(before) caller.abort(new Error("synthetic canceled"));
  const response=await f.call(form(),{signal:caller.signal});
  assert.ok([400,499].includes(response.status));assert.equal(upstream.mock.callCount(),before?0:1);
  if(!before) {await reached;assert.equal(cancel,1);assert.equal(f.events[0].actual_cost_micros,200);assert.equal(f.events[0].status,"client_error");}
});

test("settlement and recovery publication failure stops successful transcript delivery",async t=>{
  const f=fixture(t), get=f.ledger.get.bind(f.ledger);
  f.env.BUDGET_LEDGER={idFromName:x=>x,get(name){const stub=get(name);return {fetch:(url,init)=>new URL(url).pathname==="/settle"?Promise.reject(new Error("synthetic ledger outage")):stub.fetch(url,init)}}};
  f.env.USAGE_QUEUE.send=async()=>{throw new Error("synthetic recovery outage");};
  f.env.USAGE_LEDGER={idFromName:x=>x,get:()=>({fetch:async()=>{throw new Error("synthetic usage outage");}})};
  const upstream=t.mock.method(globalThis,"fetch",async()=>Response.json({text:"must not be delivered",usage:validUsage}));
  const response=await f.call(); assert.equal(response.status,503); assert.equal((await response.json()).error.code,"accounting_unavailable"); assert.equal(upstream.mock.callCount(),1);
  for(const name of owners) assert.equal(get(name).reservations()[0].settled,0);
});

const crlf = String.fromCharCode(13,10);
function rawMultipart(parts, boundary = "fixture-boundary") {
  const chunks = parts.map(({name, value, filename, type, extra = ""}) =>
    Buffer.concat([Buffer.from('--' + boundary + crlf + 'Content-Disposition: form-data; name="' + name + '"' + (filename === undefined ? '' : '; filename="' + filename + '"') + crlf + (type ? 'Content-Type: ' + type + crlf : '') + extra + crlf), Buffer.from(value), Buffer.from(crlf)]));
  return {body:Buffer.concat([...chunks,Buffer.from('--' + boundary + '--' + crlf)]), headers:{"content-type":"multipart/form-data; boundary=" + boundary}};
}
const modelPart = {name:"model", value:"openai/gpt-4o-transcribe"};
const filePart = {name:"file", value:audio, filename:"sample.wav", type:"audio/wav"};

test("binary boundary prefixes are preserved, not mistaken for framing", async t => {
  const f=fixture(t), bytes=Buffer.from('audio' + crlf + '--fixture-boundaryNOT-A-DELIMITER' + crlf + 'more');
  const raw=rawMultipart([modelPart,{...filePart,value:bytes}]);
  t.mock.method(globalThis,"fetch",async(_url,init)=>{
    assert.deepEqual(Buffer.from(await init.body.get("file").arrayBuffer()),bytes);
    return Response.json({text:"synthetic",usage:validUsage});
  });
  assert.equal((await f.call(raw.body,{headers:raw.headers})).status,200);
});

test("raw/file/part/header bounds and missing fields are independently enforced",async t=>{
  const f=fixture(t), upstream=t.mock.method(globalThis,"fetch",async()=>{throw new Error("invalid upload escaped");});
  const cases=[
    [rawMultipart([modelPart,{...filePart,value:new Uint8Array(transcriptionLimits.file+1)}]),413],
    [rawMultipart([modelPart,{...filePart,extra:'X-Unsupported: ' + 'a'.repeat(2048) + crlf}]),400],
    [rawMultipart([modelPart]),400], [rawMultipart([filePart]),400],
    [rawMultipart([modelPart,filePart,...Array.from({length:5},()=>({name:"language",value:"en"}))]),400],
    [rawMultipart([modelPart,{...filePart,type:undefined}]),400],
  ];
  for(const [raw,status] of cases) assert.equal((await f.call(raw.body,{headers:raw.headers})).status,status);
  const raw=rawMultipart([modelPart,filePart]);
  assert.equal((await f.call(raw.body,{headers:{...raw.headers,"content-encoding":"gzip"}})).status,400);
  assert.equal((await f.call(Buffer.concat([raw.body,Buffer.from('epilogue')]),{headers:raw.headers})).status,400);
  assert.equal((await f.call(raw.body,{headers:{...raw.headers,"content-length":String(transcriptionLimits.raw+1)}})).status,413);
  assert.equal(upstream.mock.callCount(),0);
});

test("lying small Content-Length cannot bypass actual stream bound",async t=>{
  const f=fixture(t);let canceled=0;
  const stream=new ReadableStream({pull(c){c.enqueue(new Uint8Array(1_000_000));},cancel(){canceled++;}},{highWaterMark:0});
  const response=await f.call(stream,{headers:{"content-type":"multipart/form-data; boundary=x","content-length":"1"}});
  assert.equal(response.status,413);assert.equal(canceled,1);
});

test("pending ingress has a real deadline and cancels without reserving or egress",async t=>{
  const f=fixture(t); let entered,canceled=0;
  const reached=new Promise(resolve=>{entered=resolve;});
  t.mock.timers.enable({apis:["setTimeout"]});
  const stream=new ReadableStream({pull(){entered();},cancel(){canceled++;}},{highWaterMark:0});
  const pending=f.call(stream,{headers:{"content-type":"multipart/form-data; boundary=x"}});
  await reached; t.mock.timers.tick(transcriptionLimits.readMs);
  const response=await pending;assert.equal(response.status,408);assert.equal(canceled,1);
  for(const name of owners) assert.equal(f.ledger.get(name).reservations().length,0);
});

test("upstream EOF remains under the endpoint deadline and retains fixed cost",async t=>{
  const f=fixture(t);let entered,canceled=0;
  const reached=new Promise(resolve=>{entered=resolve;});
  t.mock.timers.enable({apis:["setTimeout"]});
  const upstream=t.mock.method(globalThis,"fetch",async()=>new Response(new ReadableStream({pull(){entered();},cancel(){canceled++;}},{highWaterMark:0}),{headers:{"content-type":"application/json"}}));
  const pending=f.call();await reached;t.mock.timers.tick(120_000);
  const response=await pending;assert.equal(response.status,504);assert.equal(canceled,1);assert.equal(upstream.mock.callCount(),1);
  assert.equal(f.events[0].status,"timeout");assert.equal(f.events[0].actual_cost_micros,200);
});

test("fixed budget insufficiency rolls back all acknowledged earlier legs before egress",async t=>{
  const f=fixture(t,{limit:1_000_000,providerLimit:199});
  const upstream=t.mock.method(globalThis,"fetch",async()=>{throw new Error("over-budget upload escaped");});
  const response=await f.call();assert.equal(response.status,402);assert.equal(upstream.mock.callCount(),0);
  assert.equal(f.events.length,1,"definitively denied legs must not enqueue missing-reservation recovery");
  assert.equal(f.events[0].type,"clawrouter.usage.v1");
  const rows=f.ledger.get(owners[0]).reservations();assert.equal(rows.length,1);assert.equal(rows[0].settled,1);assert.equal(rows[0].reserved_micros,0);
});

test("cancellation after reservation ACK but before dispatch refunds and sends no upload",async t=>{
  const f=fixture(t), caller=new AbortController(), get=f.ledger.get.bind(f.ledger);let reserves=0;
  f.env.BUDGET_LEDGER={idFromName:x=>x,get(name){const stub=get(name);return {fetch:async(url,init)=>{const response=await stub.fetch(url,init);if(new URL(url).pathname==="/reserve" && ++reserves===2) caller.abort(new Error("synthetic canceled"));return response;}}}};
  const upstream=t.mock.method(globalThis,"fetch",async()=>{throw new Error("canceled upload escaped");});
  const response=await f.call(form(),{signal:caller.signal});assert.equal(response.status,499);assert.equal(upstream.mock.callCount(),0);await Promise.all(f.pending);
  for(const name of owners) {const row=get(name).reservations()[0];assert.equal(row.settled,1);assert.equal(row.reserved_micros,0);assert.equal(row.dispatch_started,0);}
});

test("transcription never archives raw content even under a generic retain-enabled policy",async t=>{
  const f=fixture(t,{retainContent:true});
  t.mock.method(globalThis,"fetch",async()=>Response.json({text:"synthetic transcript",usage:validUsage}));
  const response=await f.call(form({prompt:"synthetic prompt"}));assert.equal(response.status,200);await Promise.all(f.pending);
  assert.equal(response.headers.get("x-clawrouter-content-retention"),"off");assert.deepEqual(f.retained,[]);
  assert.ok(!JSON.stringify(f.events).includes("synthetic"));assert.equal(f.events[0].content_retained,false);
});

test("deadline while reserve ACK is pending owns the eventual refund and never dispatches",async t=>{
  const f=fixture(t), get=f.ledger.get.bind(f.ledger);let entered,release;
  const reached=new Promise(resolve=>{entered=resolve;});const gate=new Promise(resolve=>{release=resolve;});
  f.env.BUDGET_LEDGER={idFromName:x=>x,get(name){const stub=get(name);return {fetch:async(url,init)=>{
    const response=await stub.fetch(url,init);
    if(new URL(url).pathname === "/reserve" && name === owners[1]) {entered();await gate;}
    return response;
  }}}};
  t.mock.timers.enable({apis:["setTimeout"]});
  const upstream=t.mock.method(globalThis,"fetch",async()=>{throw new Error("expired upload escaped");});
  const pending=f.call();await reached;t.mock.timers.tick(120_000);
  const response=await pending;assert.equal(response.status,504);assert.equal(upstream.mock.callCount(),0);
  release();await Promise.all(f.pending);
  for(const name of owners) {const row=get(name).reservations()[0];assert.equal(row.settled,1);assert.equal(row.reserved_micros,0);assert.equal(row.dispatch_started,0);}
});

for(const details of [undefined,{}, {audio_tokens:12}, {text_tokens:2}]) test("optional usage detail counters do not erase authoritative totals: "+JSON.stringify(details),async t=>{
  const f=fixture(t,{limit:null,providerLimit:null,fixedCost:null});
  t.mock.method(globalThis,"fetch",async()=>Response.json({text:"synthetic",usage:{...validUsage,input_token_details:details}}));
  const response=await f.call();assert.equal(response.status,200);assert.equal(f.events[0].total_tokens,59);assert.equal(f.events[0].actual_cost_micros,485);assert.equal(f.events[0].cost_basis,"manifest_pricing");
});

test("advertised Access playground multipart route authenticates session and preserves authority",async t=>{
  const f=fixture(t), token="a".repeat(64), email="owner@example.com";
  const {sha256Hex}=await import("../utils.ts");
  const key="local/sessions/"+await sha256Hex(token), expiresAtMs=Date.now()+60_000;
  f.env.CLAWROUTER_LOCAL_AUTH="enabled";
  f.env.POLICY_KV={get:async keys=>Array.isArray(keys)?new Map():keys===key?{email,role:"user",expiresAtMs}:null};
  const get=f.env.ACCESS_CONTROL.get.bind(f.env.ACCESS_CONTROL);
  f.env.ACCESS_CONTROL.get=(...args)=>{const stub=get(...args);return {fetch:(url,init)=>{
    const path=new URL(url).pathname;
    if(path==="/users/resolve") return Response.json({initialized:true,users:[{email,record:{enabled:true,role:"user",tenantId:"tenant",groups:[]}}],missingEmails:[]});
    if(path==="/resolve") return Response.json({initialized:true,bindings:[{enabled:true,priority:1,policyId:"maintainer_access"}],missingPrincipals:[]});
    return stub.fetch(url,init);
  }}};
  const upstream=t.mock.method(globalThis,"fetch",async(_url,init)=>{
    assert.equal(init.headers.get("authorization"),"Bearer fixture-upstream-key");assert.equal(init.headers.has("cookie"),false);
    assert.deepEqual(new Uint8Array(await init.body.get("file").arrayBuffer()),audio);
    return Response.json({text:"synthetic",usage:validUsage});
  });
  const path="/v1/playground/v1/audio/transcriptions", headers={authorization:"",cookie:"clawrouter_session="+token,origin:"https://router.example"};
  assert.equal((await f.call(form(),{path,headers:{...headers,origin:"https://other.example"}})).status,403);
  assert.equal((await f.call(form(),{path,headers:{...headers,cookie:""}})).status,401);
  const response=await f.call(form(),{path,headers});assert.equal(response.status,200,await response.clone().text());
  assert.equal(upstream.mock.callCount(),1);assert.equal(f.events[0].auth_type,"access");assert.equal(f.events[0].principal_id,email);assert.equal(f.events[0].credential_id,null);
});

for(const [filename,type] of [["sdk.wav","application/octet-stream"],["voice.ogg","audio/ogg"],["voice.flac","audio/flac"]]) test("vendor/SDK multipart format fidelity: "+filename+" "+type,async t=>{
  const f=fixture(t);const upstream=t.mock.method(globalThis,"fetch",async(_url,init)=>{
    const file=init.body.get("file");assert.equal(file.name,filename);assert.equal(file.type,type);assert.deepEqual(new Uint8Array(await file.arrayBuffer()),audio);
    return Response.json({text:"synthetic",usage:validUsage});
  });
  const response=await f.call(form({},new File([audio],filename,{type})));assert.equal(response.status,200,await response.clone().text());assert.equal(upstream.mock.callCount(),1);
});

test("committed reserve with lost ACK refunds every attempted SQL leg without egress",async t=>{
  const f=fixture(t), get=f.ledger.get.bind(f.ledger);
  f.env.BUDGET_LEDGER={idFromName:x=>x,get(name){const stub=get(name);return {fetch:async(url,init)=>{
    const response=await stub.fetch(url,init);
    if(name===owners[1] && new URL(url).pathname==="/reserve") throw new Error("synthetic committed ACK loss");
    return response;
  }}}};
  const upstream=t.mock.method(globalThis,"fetch",async()=>{throw new Error("unacknowledged upload escaped");});
  const response=await f.call();assert.ok(response.status>=500);assert.equal(upstream.mock.callCount(),0);await Promise.all(f.pending);
  for(const name of owners) {const row=get(name).reservations()[0];assert.equal(row.settled,1);assert.equal(row.reserved_micros,0);assert.equal(row.dispatch_started,0);}
});

test("dispatch through terminal cleanup has an unsettled waitUntil lifetime owner",async t=>{
  const f=fixture(t);t.mock.method(globalThis,"fetch",async()=>{
    let completed=0;for(const p of f.pending) p.then(()=>completed++);await Promise.resolve();await Promise.resolve();
    assert.ok(f.pending.length>completed,"a pending lifetime promise must already own dispatch/accounting, not only an earlier reserve ACK");
    return Response.json({text:"synthetic",usage:validUsage});
  });
  const response=await f.call();assert.equal(response.status,200);await Promise.all(f.pending);
});

for(const cause of ["deadline","caller"]) test("complete response owns terminal outcome before delayed settlement ACK: "+cause,async t=>{
  const f=fixture(t), get=f.ledger.get.bind(f.ledger), caller=new AbortController();let entered,release;
  const reached=new Promise(resolve=>{entered=resolve;}), gate=new Promise(resolve=>{release=resolve;});
  f.env.BUDGET_LEDGER={idFromName:x=>x,get(name){const stub=get(name);return {fetch:async(url,init)=>{
    const response=await stub.fetch(url,init);if(new URL(url).pathname==="/settle") {entered();await gate;}return response;
  }}}};
  t.mock.timers.enable({apis:["setTimeout"]});
  t.mock.method(globalThis,"fetch",async()=>Response.json({text:"synthetic",usage:validUsage}));
  const pending=f.call(form(),{signal:caller.signal});await reached;
  if(cause==="deadline") t.mock.timers.tick(120_000);else caller.abort(new Error("synthetic late disconnect"));
  release();const response=await pending;assert.equal(response.status,200);assert.equal(f.events[0].status,"success");assert.equal(f.events[0].status_code,200);await Promise.all(f.pending);
});

test("canceled pending reserve owns later attempted legs even when their committed ACK is lost",async t=>{
  const f=fixture(t), get=f.ledger.get.bind(f.ledger), caller=new AbortController();let entered,release;
  const reached=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  f.env.BUDGET_LEDGER={idFromName:x=>x,get(name){const stub=get(name);return {fetch:async(url,init)=>{
    const reserving=new URL(url).pathname==="/reserve";
    if(reserving && name===owners[0]) {entered();await gate;}
    const response=await stub.fetch(url,init);
    if(reserving && name===owners[1]) throw new Error("synthetic late committed ACK loss");
    return response;
  }}}};
  const upstream=t.mock.method(globalThis,"fetch",async()=>{throw new Error("canceled upload escaped");});
  const pending=f.call(form(),{signal:caller.signal});await reached;caller.abort(new Error("synthetic cancel"));
  assert.equal((await pending).status,499);release();await Promise.all(f.pending);
  assert.equal(upstream.mock.callCount(),0);
  for(const name of owners) {const rows=get(name).reservations();assert.equal(rows.length,1);assert.equal(rows[0].settled,1);assert.equal(rows[0].reserved_micros,0);assert.equal(rows[0].dispatch_started,0);}
});


for(const [bound,code] of [["policy","budget_exhausted"],["provider","provider_budget_exhausted"],["daily","daily_budget_exhausted"],["weekly","weekly_budget_exhausted"]])
for(const limit of [0,200])
for(const phase of ["before-headers","after-headers"]) test("soft denial is nonbillable with no SQL charge: "+bound+" "+limit+" "+phase,async t=>{
  const options={limit:bound==="policy"?limit:null,providerLimit:bound==="provider"?limit:null,dailyLimit:bound==="daily"?limit:undefined,weeklyLimit:bound==="weekly"?limit:undefined};
  const f=fixture(t,options,{budgetMode:"soft"}),get=f.ledger.get.bind(f.ledger),calls=[];
  if(limit) {
    const {reserveBudget,markBudgetDispatched,settleBudget}=await import("../accounting.ts");
    const auth={policyId:"maintainer_access",principalId:"owner@example.com",policy:{tenantId:"tenant",budgetScope:"principal",monthlyBudgetMicros:options.limit,dailyBudgetMicros:options.dailyLimit,weeklyBudgetMicros:options.weeklyLimit}};
    const held=await reserveBudget(f.env,auth,"audio.transcription",{reserveMicros:limit,basis:"policy_fixed",inputTokens:null,outputTokens:null},{providerId:"openai",monthlyBudgetMicros:options.providerLimit});
    await markBudgetDispatched(f.env,held);
    await settleBudget(f.env,held,limit);
    assert.equal(f.events.length,0,"seed is a fully acknowledged SQL charge, not a queued recovery job");
  }
  const prior=owners.map(name=>get(name).reservations());
  f.env.BUDGET_LEDGER={idFromName:x=>x,get(name){const stub=get(name);return {fetch:(url,init)=>{calls.push(new URL(url).pathname);return stub.fetch(url,init);}}}};
  let signal,disposed=0;
  const upstream=t.mock.method(globalThis,"fetch",async(_url,init)=>{
    signal=init.signal;
    if(phase==="before-headers") return new Promise((_resolve,reject)=>{signal.addEventListener("abort",()=>reject(signal.reason),{once:true});});
    return new Response(new ReadableStream({pull(){},cancel(){disposed++;}},{highWaterMark:0}),{headers:{"content-type":"application/json"}});
  });
  const response=await f.call();assert.equal(response.status,402);assert.equal((await response.json()).error.code,code);
  await Promise.all(f.pending);
  assert.equal(upstream.mock.callCount(),1);assert.equal(signal.aborted,true);
  if(phase==="after-headers") assert.equal(disposed,1);
  assert.equal(f.events.length,1);assert.equal(f.events[0].actual_cost_micros,0);assert.equal(f.events[0].cost_basis,"none");assert.equal(f.events[0].status,"denied");assert.equal(f.events[0].status_code,402);
  assert.ok(!calls.some(path=>["/reserve","/dispatch","/charge"].includes(path)),"soft denial cannot create a monetary charge, including zero-charge rows");
  assert.deepEqual(owners.map(name=>get(name).reservations()),prior);assert.deepEqual(f.retained,[]);
});

test("soft denial waits for durable usage ACK and fails closed when publication and recovery fail",async t=>{
  const f=fixture(t,{limit:0},{budgetMode:"soft"});
  f.env.USAGE_QUEUE.send=async()=>{throw new Error("synthetic queue outage");};
  f.env.USAGE_LEDGER={idFromName:x=>x,get:()=>({fetch:async()=>{throw new Error("synthetic usage outage");}})};
  const upstream=t.mock.method(globalThis,"fetch",async(_url,init)=>new Promise((_resolve,reject)=>{
    init.signal.addEventListener("abort",()=>reject(init.signal.reason),{once:true});
  }));
  const response=await f.call();assert.equal(response.status,503);assert.equal((await response.json()).error.code,"accounting_unavailable");
  await Promise.all(f.pending);assert.equal(upstream.mock.callCount(),1);
  for(const name of owners) assert.deepEqual(f.ledger.get(name).reservations(),[]);
});
