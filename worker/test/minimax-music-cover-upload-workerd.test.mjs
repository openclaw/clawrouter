import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { startWorkerdFixture } from "../../test/helpers/workerd.mjs";

const router = String.raw`
import {beginMiniMaxMusicCoverInput} from './worker/minimax-music-cover-input.ts';
import {runInactiveMiniMaxMusicCoverUpload,MusicCoverUploadSource,musicCoverUploadLimits} from './worker/minimax-music-cover-upload.ts';
import {MiniMaxMusicCoverControl} from './worker/minimax-music-cover-control.ts';
import {BodyLease,bodyBudgetCharged} from './worker/body-budget.ts';
const gate=(mode,phase)=>fetch('https://cover-upload-gate.example/'+mode+'/'+phase,{redirect:'manual'}).then(async r=>{if(!r.ok)throw Error('fixture gate');await r.text();});
let active;
const produce=MusicCoverUploadSource.prototype.produce,dispose=MusicCoverUploadSource.prototype.disposeSource,split=BodyLease.prototype.splitCharges;
MusicCoverUploadSource.prototype.produce=async function(controller){
 const a=active;if(a)a.source=this;
 if(a&&['early','upload-reject'].includes(a.mode)&&this.emitted+2===this.length){a.uploadHeld=true;await gate(a.mode,'upload');}
 return produce.call(this,controller);
};
MusicCoverUploadSource.prototype.disposeSource=async function(){
 const a=active;if(a)a.discards++;
 await dispose.call(this);
 if(a?.mode==='upload-reject'){a.cancelHeld=true;await a.uploadCleanupGate;throw Error('synthetic FIRST upload discard rejection');}
};
BodyLease.prototype.splitCharges=function(left,right){
 const a=active;if(a){a.splitBefore=bodyBudgetCharged();a.splitReferences=a.source?.snapshot().references;a.splits++;
  if(a.mode==='split-fail'||a.mode==='unlock-pre')return null;}
 const result=split.call(this,left,right);if(a)a.splitAfter=bodyBudgetCharged();return result;
};
const post=MiniMaxMusicCoverControl.prototype.post;
MiniMaxMusicCoverControl.prototype.post=function(...args){if(active)active.owner=this;return post.apply(this,args);};
const state=()=>active?{mode:active.mode,charged:bodyBudgetCharged(),result:active.result,done:active.done,retired:active.retired,
 error:active.error,cleanupError:active.cleanupError,fetches:active.fetches,headers:active.headers,responseStatus:active.responseStatus,declaredUploadLength:active.declaredUploadLength,
 reads:active.reads,nativeReads:active.nativeReads,nativeEOF:active.nativeEOF,cancels:active.cancels,unlocks:active.unlocks,unlockAttempts:active.unlockAttempts,
 uploadHeld:active.uploadHeld,cancelHeld:active.cancelHeld,readHeld:active.readHeld,discards:active.discards,
 source:active.source?.snapshot(),splits:active.splits,splitBefore:active.splitBefore,splitAfter:active.splitAfter,splitReferences:active.splitReferences,
 outputBytes:active.outputBytes,maxOutputBacking:active.maxOutputBacking,flow:active.flow?.snapshot(),locked:active.original?.locked??false,
 retainedTickets:active.owner?.tickets.reduce((n,t)=>n+Number(!!t.work)+Number(!!t.input)+Number(!!t.response)+Number(!!t.cancellation),0)}:{};
function ownObserved(response,a){
 a.original=response.body;if(!response.body)return response;
 const get=response.body.getReader.bind(response.body);let cancellation,nativeDone=false,emptyBacking;
 response.body.getReader=options=>{const reader=get(options);return {
  async read(view){
   a.reads++;let part;
   if(nativeDone)part={done:true,value:new Uint8Array(emptyBacking,0,0)};
   else {a.nativeReads++;part=await reader.read(view);if(part.done){nativeDone=true;a.nativeEOF=true;
    if(['read8192','read8193'].includes(a.mode))emptyBacking=part.value?.buffer?.byteLength?part.value.buffer:new ArrayBuffer(16384);
   }}
   if(['read8192','read8193'].includes(a.mode)&&nativeDone){
    const limit=a.mode==='read8192'?8192:8193;
    if(a.reads<limit)return {done:false,value:new Uint8Array(emptyBacking,0,0)};
   }
   if(a.mode==='backing'&&!part.done)return {done:false,value:new Uint8Array(new ArrayBuffer(16385),0,2)};
   if(a.mode==='read-error')throw new Error('synthetic original read failure',{cause:{discarded:'x'.repeat(100000)}});
   if(['read','read-reject'].includes(a.mode)&&a.reads===1){a.readHeld=true;await gate(a.mode,'read');}
   return part;
  },cancel(reason){if(!cancellation){let resolve,reject;cancellation=new Promise((yes,no)=>{resolve=yes;reject=no;});
   Promise.resolve().then(async()=>{a.cancels++;try{await reader.cancel(reason);}finally{
    if(['read','read-reject','read-error','late','split-fail'].includes(a.mode)){a.cancelHeld=true;await a.responseCleanupGate;}
    if(a.mode==='read-reject')throw Error('synthetic FIRST response cancel rejection');
   }}).then(resolve,reject);}return cancellation;
  },releaseLock(){a.unlockAttempts++;if(a.mode==='unlock'||a.mode==='unlock-pre'){a.resolveUnlock();throw Error('synthetic pre-unlock failure');}a.unlocks++;reader.releaseLock();}
 };};return response;
}
async function consume(response,a){
 const reader=response.body.getReader();let offset=0;
 const prefix='{"base_resp":{"status_code":0},"data":{"status":2,"audio":"',suffix='"}}';
 try{for(;;){const p=await reader.read();if(p.done)break;
  if(p.value.buffer.byteLength>16384)throw Error('delivery backing');a.maxOutputBacking=Math.max(a.maxOutputBacking,p.value.buffer.byteLength);
  for(const byte of p.value){const expected=offset<prefix.length?prefix.charCodeAt(offset):offset<prefix.length+a.audio*2?(offset-prefix.length)%2?98:97:suffix.charCodeAt(offset-prefix.length-a.audio*2);
   if(byte!==expected)throw Error('delivery bytes');offset++;}
 }}finally{reader.releaseLock();}
 a.outputBytes=offset;if(offset!==prefix.length+a.audio*2+suffix.length)throw Error('delivery length');
}
export default {async fetch(request,env,context){
 const url=new URL(request.url);
 if(url.pathname==='/state')return Response.json(state());
 if(url.pathname==='/unlock-observed'){await active.unlockObserved;return Response.json(state());}
 if(url.pathname==='/contend'){const lease=new BodyLease();try{return Response.json({admitted:lease.grow(1024*1024),charged:bodyBudgetCharged()});}finally{lease.release();}}
 if(url.pathname==='/abort'){
  // Cancellation creates physical continuations in this probe's context. Keep
  // it alive; /start independently observes and asserts the retirement outcome.
  if(active?.flow)context.waitUntil(active.flow.retired.catch(()=>{}));
  active?.controller.abort('fixture abort');return Response.json({ok:true});
 }
 if(url.pathname!=='/start')return new Response(null,{status:404});
 if(active&&!active.retired)return new Response(null,{status:409});
 const a=active={mode:url.searchParams.get('mode')??'normal',audio:Number(url.searchParams.get('audio')??3),controller:new AbortController(),
  fetches:0,reads:0,nativeReads:0,cancels:0,unlocks:0,unlockAttempts:0,discards:0,splits:0,outputBytes:0,maxOutputBacking:0,headers:false,result:false,done:false,retired:false};
 a.unlockObserved=new Promise(resolve=>{a.resolveUnlock=resolve;});
 const input=beginMiniMaxMusicCoverInput({body:request.body,signal:a.controller.signal,deadlineAt:Date.now()+(a.mode==='deadline'?1500:60000),
  route:url.searchParams.get('route')==='manifest'?'manifest':'native',contentType:'application/json'});
 try{
  const sealed=await input.result;
  // Own fixture cleanup I/O in /start, before the separate /abort callback.
  if(a.mode==='upload-reject'){a.uploadCleanupGate=gate(a.mode,'cleanup');void a.uploadCleanupGate.catch(()=>{});}
  if(['read','read-reject','read-error','late','split-fail'].includes(a.mode)){
   a.responseCleanupGate=gate(a.mode,'cleanup');void a.responseCleanupGate.catch(()=>{});
  }
  a.flow=runInactiveMiniMaxMusicCoverUpload(sealed,async(url,init)=>{
   if(url!=='https://api.minimax.io/v1/music_generation'||init.method!=='POST'||init.redirect!=='manual')throw Error('fixed destination');
   a.declaredUploadLength=Number(new Headers(init.headers).get('content-length'));
   a.fetches++;const response=await fetch(url,init);a.headers=true;a.responseStatus=response.status;
   ownObserved(response,a);
   if(a.mode==='late')await gate(a.mode,'late');
   return response;
  });
  try{
   const response=await a.flow.result;a.result=true;
   if(a.mode==='unclaimed')await gate(a.mode,'delivery');
   if(a.mode==='downstream')await response.body.cancel();
   else if(a.mode==='deadline'){try{await a.flow.retired;}finally{try{await response.body.cancel();}catch{}}}
   else await consume(response,a);
  }catch{a.error='transport';}finally{a.done=true;}
  if(a.mode==='unlock'||a.mode==='unlock-pre'){
   context.waitUntil(a.flow.retired);return Response.json(state());
  }
  try{await a.flow.retired;}catch{a.cleanupError='control_cleanup';}
 }catch{a.error='input';await input.discard().catch(()=>{});}
 try{await input.retired;}catch{a.cleanupError??='input_cleanup';}a.retired=true;
 return Response.json(state());
}};`;

function input(bytes = 5, route = "native") {
  const prefix = (route === "manifest" ? '{"body":' : "") + '{"audio_base64":"';
  const tail = '","model":"music-cover","prompt":"Synthetic cover style"}' + (route === "manifest" ? "}" : "");
  let remaining = Math.floor(bytes / 3) * 4, phase = 0;
  return { length: Buffer.byteLength(prefix + tail) + Math.ceil(bytes / 3) * 4,
    body: new ReadableStream({ pull(c) {
      if (!phase) { phase = 1; c.enqueue(Buffer.from(prefix)); return; }
      if (remaining) { const count = Math.min(remaining, 16384); remaining -= count; c.enqueue(Buffer.alloc(count, 65)); return; }
      if (phase === 1) { phase = 2; c.enqueue(Buffer.from((bytes % 3 === 1 ? "AA==" : bytes % 3 === 2 ? "AAA=" : "") + tail)); return; }
      c.close();
    } }, { highWaterMark: 0 }) };
}
function responsePlan(maximum) {
  const value = { base_resp: { status_code: 0 }, data: { status: 2, audio: "" } };
  if (maximum) {
    value.extra = Object.fromEntries(Array.from({ length: 249 }, (_, i) => ["k" + i, null]));
    value.items = Array(255).fill(null);
    const keyUnits = ["base_resp", "status_code", "data", "status", "audio", "extra", "items", ...Object.keys(value.extra)].reduce((n,k) => n+k.length,0);
    value.extra.k0 = "x".repeat(32768 - keyUnits);
  }
  const text = JSON.stringify(value), marker = '"audio":"', split = text.indexOf(marker) + marker.length;
  return { prefix: text.slice(0, split), suffix: text.slice(split), metadata: Buffer.byteLength(text) };
}

test("inactive cover actual Workerd: exact 50M upload, partial unary HEX, atomic ownership and physical retirement", { timeout: 180000 }, async t => {
  const temporary = await mkdtemp(join(tmpdir(), "cover-upload-workerd-")); t.after(() => rm(temporary, { recursive: true, force: true }));
  const held = new Map(), arrived = new Set(), released = new Set(), clients = new Set(), errors = [];
  let mode = "normal", size = 5, audio = 3, posts = 0, uploaded = 0, uploadEnded = false, uploadValid = true, uploadEvidence;
  const release = key => { t.diagnostic("release " + key); released.add(key); held.get(key)?.end("ok"); held.delete(key); };
  const releaseAll = () => {
    // Open future arrivals too: failure can precede entry into a physical gate.
    for (const mode of ["early", "upload-reject", "read", "read-reject", "read-error", "late", "split-fail", "unclaimed"])
      for (const phase of ["upload", "cleanup", "read", "late", "delivery"]) released.add("/" + mode + "/" + phase);
    for (const response of held.values()) response.end("ok"); held.clear();
  };
  const server = createServer((request, response) => {
    if (request.url.startsWith("/gate/")) {
      const key = request.url.slice(5); t.diagnostic("gate " + key); arrived.add(key); if (released.has(key)) response.end("ok"); else held.set(key, response); return;
    }
    if (request.url !== "/provider" || request.method !== "POST" || request.headers.authorization) { response.writeHead(400); response.end(); return; }
    posts++; const currentMode = mode, expectedSize = size, expectedAudio = audio; t.diagnostic("provider POST " + currentMode);
    const prefix = Buffer.from('{"model":"music-cover","prompt":"Synthetic cover style","stream":false,"output_format":"hex","audio_base64":"');
    const suffix = Buffer.from('"}'), encoded = Math.ceil(expectedSize / 3) * 4, padding = (3 - expectedSize % 3) % 3;
    let count = 0, firstMismatch = null;
    request.on("data", chunk => {
      for (const byte of chunk) { const expected = count < prefix.length ? prefix[count]
        : count < prefix.length + encoded ? count < prefix.length + encoded - padding ? 65 : 61 : suffix[count - prefix.length - encoded];
        if (byte !== expected) { uploadValid = false; firstMismatch ??= { offset: count, expected: expected ?? null, actual: byte }; } count++; }
      uploaded = count;
    });
    request.on("error", error => { if (!["early", "upload-reject"].includes(currentMode)) errors.push(error); });
    const send = async () => {
      if (response.writableEnded || response.destroyed) return;
      if (currentMode === "bad-mime") { response.writeHead(200, { "content-type": "text/event-stream" }); response.end("data: {}\n\n"); return; }
      if (currentMode === "bodyless") { response.writeHead(503, { "content-length": "0" }); response.end(); return; }
      const plan = responsePlan(currentMode === "maximum"), extra = currentMode === "maximum" ? 65536 - plan.metadata : 0;
      const badTail = currentMode === "tail" ? "x" : "";
      response.writeHead(200, { "content-type": "application/json", "content-length": String(plan.metadata + expectedAudio * 2 + extra + badTail.length) });
      const write = async part => { if (response.destroyed) return false; if (!response.write(part)) await new Promise(resolve => { response.once("drain", resolve); response.once("close", resolve); }); return !response.destroyed; };
      if (!await write(plan.prefix)) return;
      let remaining = expectedAudio * 2;
      while (remaining) { const n = Math.min(16384, remaining); remaining -= n; if (!await write("ab".repeat(n / 2))) return; }
      if (!await write(plan.suffix)) return;
      if (extra && !await write(" ".repeat(extra))) return;
      response.end(badTail);
    };
    request.on("end", () => {
      uploadEnded = true;
      uploadEvidence = { bytes: count, expectedBytes: prefix.length + encoded + suffix.length,
        contentLength: request.headers["content-length"] ?? null, transferEncoding: request.headers["transfer-encoding"] ?? null, firstMismatch };
      // The forwarded HTTP hop may use chunked framing; exact payload length is independent.
      const contentLength = request.headers["content-length"], transferEncoding = request.headers["transfer-encoding"];
      const framingValid = contentLength === undefined ? transferEncoding === "chunked"
        : Number(contentLength) === count && transferEncoding === undefined;
      if (count !== prefix.length + encoded + suffix.length || !framingValid) uploadValid = false;
      if (!["early", "upload-reject"].includes(currentMode)) void send().catch(error => errors.push(error));
    });
    if (["early", "upload-reject"].includes(currentMode)) void send().catch(error => errors.push(error));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + server.address().port;
  const upstream = `export default {fetch(request){const u=new URL(request.url);
    if(u.hostname==='cover-upload-gate.example')return fetch(${JSON.stringify(base)}+'/gate'+u.pathname,{redirect:'manual'});
    if(u.href==='https://api.minimax.io/v1/music_generation')return fetch(${JSON.stringify(base)}+'/provider',{method:'POST',headers:request.headers,body:request.body,signal:request.signal,redirect:'manual'});
    throw Error('fixture egress denied');}};`;
  const runtime = await startWorkerdFixture(temporary, router, upstream, { preventEviction: true });
  t.after(async () => {
    releaseAll();
    for (const client of clients) client.controller.abort();
    const results = await Promise.allSettled([...clients].map(c => c.promise));
    try { const failed = results.filter(r => r.status === "rejected"); if (failed.length) throw new AggregateError(failed.map(r => r.reason), "owned fixture clients"); }
    finally { await runtime.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  });
  const call = async path => { const r = await runtime.dispatchFetch("https://router.example/" + path); assert.equal(r.status, 200); return r.json(); };
  const start = (nextMode = "normal", bytes = 5, route = "native", decoded = 3) => {
    mode = nextMode; size = bytes; audio = decoded; uploaded = 0; uploadEnded = false; uploadValid = true; uploadEvidence = undefined;
    t.diagnostic("start " + JSON.stringify({ mode, bytes, route, decoded }));
    const payload = input(bytes, route), controller = new AbortController(), client = { controller };
    client.promise = runtime.dispatchFetch(`https://router.example/start?mode=${mode}&route=${route}&audio=${audio}`, {
      method: "POST", headers: { "content-type": "application/json", "content-length": String(payload.length) },
      body: payload.body, duplex: "half", signal: controller.signal }).then(async r => {
        assert.equal(r.status, 200); const state = await r.json();
        t.diagnostic("settled " + JSON.stringify({ mode: state.mode, error: state.error, cleanupError: state.cleanupError,
          charged: state.charged, retired: state.retired })); return state;
      });
    clients.add(client); void client.promise.then(() => clients.delete(client), () => {}); return client;
  };
  const wait = async predicate => {
    let last;
    for (let i = 0; i < 400; i++) {
      const s = last = await call("state");
      // A previous invocation remains visible until /start reaches this isolate.
      if (s.mode === mode) {
        if (predicate(s)) { t.diagnostic("boundary " + JSON.stringify(s)); return s; }
        if (s.retired) throw Error("boundary ended: " + JSON.stringify(s));
      }
      await delay(10);
    }
    t.diagnostic("absent " + JSON.stringify({ mode, state: last }));
    throw Error("fixture boundary absent");
  };
  const check = state => { assert.equal(state.charged, 0); assert.equal(state.flow.ordinary, 1); assert.equal(state.flow.postAttempts, 1);
    assert.equal(state.retainedTickets, 0); assert.equal(state.source.references, 0); assert.equal(state.fetches, 1); };
  for (const route of ["native", "manifest"]) {
    const before = posts, client = start("maximum", 50_000_000, route, 4 * 1024 * 1024), state = await client.promise;
    check(state); assert.equal(state.error, undefined); assert.equal(uploadValid, true, JSON.stringify(uploadEvidence)); assert.equal(uploadEnded, true); assert.equal(posts - before, 1);
    assert.equal(state.declaredUploadLength, uploadEvidence.expectedBytes); assert.equal(state.source.length, uploadEvidence.expectedBytes);
    assert.equal(state.splitBefore, 96 * 1024 * 1024); assert.equal(state.splitAfter, state.splitBefore); assert.equal(state.splitReferences, 0);
    assert.ok(state.maxOutputBacking <= 16384); assert.ok(state.outputBytes > 8 * 1024 * 1024);
  }
  {
    const client = start("unclaimed"); const s = await wait(s => s.result);
    assert.equal(s.charged, 96 * 1024 * 1024); assert.equal(s.flow.ordinaryActive, 1);
    assert.deepEqual(await call("contend"), { admitted: false, charged: 96 * 1024 * 1024 });
    release("/unclaimed/delivery"); check(await client.promise);
  }
  for (const nextMode of ["downstream", "deadline", "read8192"]) {
    const s = await start(nextMode).promise; check(s); assert.equal(s.error, undefined);
    if (nextMode === "read8192") { assert.equal(s.reads, 8192); assert.equal(s.nativeEOF, true); assert.ok(s.nativeReads < s.reads); }
  }
  for (const nextMode of ["read8193", "backing", "bad-mime", "bodyless", "tail"]) {
    const s = await start(nextMode).promise; check(s); assert.equal(s.error, "transport");
    if (nextMode === "read8193") { assert.equal(s.reads, 8192); assert.equal(s.cancels, 1); }
  }
  for (const nextMode of ["early", "upload-reject"]) {
    const before = posts, client = start(nextMode);
    try {
      const s = await wait(s => s.uploadHeld && s.headers);
      assert.equal(posts - before, 1, JSON.stringify({ expectedMode: nextMode, observedMode: s.mode, responseStatus: s.responseStatus,
        fetches: s.fetches, done: s.done, retired: s.retired, uploadHeld: s.uploadHeld }));
      assert.equal(s.reads, 0); assert.equal(s.charged, 96 * 1024 * 1024);
      assert.equal(s.source.pending, true);
      if (nextMode === "upload-reject") {
        await call("abort"); await wait(s => s.cancelHeld && arrived.has("/upload-reject/cleanup"));
        assert.equal((await call("state")).charged, 96 * 1024 * 1024);
        release("/upload-reject/cleanup"); assert.equal((await call("state")).charged, 96 * 1024 * 1024);
      }
      release("/" + nextMode + "/upload"); const done = await client.promise; check(done);
      if (nextMode === "upload-reject") { assert.equal(done.cleanupError, "control_cleanup"); assert.equal(done.discards, 1); }
      else assert.equal(done.error, undefined);
    } finally { release("/" + nextMode + "/cleanup"); release("/" + nextMode + "/upload"); await client.promise; }
  }
  for (const nextMode of ["read", "read-reject", "read-error", "late", "split-fail"]) {
    const client = start(nextMode);
    try {
      if (nextMode === "late") { await wait(s => s.headers); await call("abort"); release("/late/late"); }
      else if (nextMode !== "split-fail" && nextMode !== "read-error") { await wait(s => s.readHeld); await call("abort"); }
      await wait(s => s.cancelHeld && arrived.has("/" + nextMode + "/cleanup")); const heldState = await call("state");
      assert.equal(heldState.charged, 96 * 1024 * 1024); assert.equal(heldState.locked, true); assert.equal(heldState.cancels, 1);
      if (nextMode === "late" || nextMode === "split-fail") assert.equal(heldState.reads, 0);
      assert.equal(heldState.done, true);
      release("/" + nextMode + "/cleanup");
      if (["read", "read-reject"].includes(nextMode)) { assert.equal((await call("state")).charged, 96 * 1024 * 1024); release("/" + nextMode + "/read"); }
      // Observe the ORIGINAL unlock boundary before waiting on the client join.
      await wait(s => s.unlockAttempts > 0);
      const done = await client.promise; check(done); assert.equal(done.error, "transport"); assert.equal(done.unlocks, 1);
      assert.equal(done.cleanupError, nextMode === "read-reject" ? "control_cleanup" : undefined);
    } finally { release("/" + nextMode + "/late"); release("/" + nextMode + "/cleanup"); release("/" + nextMode + "/read"); await client.promise; }
  }
  assert.deepEqual(errors, []);
});

for (const mode of ["unlock", "unlock-pre"]) test("actual Workerd retains locked response, slot and charge after " + mode, { timeout: 30000 }, async t => {
  const temporary = await mkdtemp(join(tmpdir(), "cover-unlock-workerd-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const upstream = `export default {async fetch(request){if(request.url!=='https://api.minimax.io/v1/music_generation')throw Error('egress');
    await request.arrayBuffer();return new Response('{"base_resp":{"status_code":0},"data":{"status":2,"audio":"ababab"}}',{headers:{'content-type':'application/json'}});}};`;
  const runtime = await startWorkerdFixture(temporary, router, upstream, { preventEviction: true });
  // These roots intentionally CANNOT retire. The isolated fixture ends only
  // after proving no released capacity; disposal is not a runtime cleanup ACK.
  t.after(() => runtime.dispose());
  const document = JSON.stringify({ model: "music-cover", prompt: "Synthetic cover style", audio_base64: "AAAAAAA=" });
  const response = await runtime.dispatchFetch("https://router.example/start?mode=" + mode, { method: "POST", body: document, signal: t.signal, headers: { "content-type": "application/json" } });
  assert.equal(response.status, 200); await response.json();
  // Public failure precedes physical unlock. Await the ORIGINAL hook, not a
  // status snapshot taken at public failure, before asserting retained custody.
  const observed = await runtime.dispatchFetch("https://router.example/unlock-observed", { signal: t.signal });
  assert.equal(observed.status, 200); const state = await observed.json();
  assert.equal(state.done, true); assert.equal(state.error, "transport"); assert.equal(state.retired, false);
  assert.equal(state.locked, true); assert.equal(state.unlockAttempts, 1); assert.equal(state.unlocks, 0);
  assert.equal(state.charged, 96 * 1024 * 1024); assert.equal(state.flow.ordinaryActive, 1); assert.equal(state.flow.postAttempts, 1);
  assert.equal(state.fetches, 1); assert.equal(state.source.references, 0);
  if (mode === "unlock-pre") { assert.equal(state.reads, 0); assert.equal(state.cancels, 1); assert.equal(state.splitAfter, undefined); }
  else { assert.equal(state.nativeEOF, true); assert.equal(state.splitAfter, 96 * 1024 * 1024); }
  const contender = await runtime.dispatchFetch("https://router.example/contend");
  assert.deepEqual(await contender.json(), { admitted: false, charged: 96 * 1024 * 1024 });
});
