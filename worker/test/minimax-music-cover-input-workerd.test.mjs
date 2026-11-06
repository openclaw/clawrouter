import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { startWorkerdFixture } from "../../test/helpers/workerd.mjs";

const router = String.raw`
import { beginMiniMaxMusicCoverInput, claimMiniMaxMusicCoverInput, musicCoverInputLimits } from './worker/minimax-music-cover-input.ts';
import { BodyLease, bodyBudgetCharged } from './worker/body-budget.ts';
class UnusedOwner { fetch() { throw new Error('foundation has no authority/RPC path'); } }
export { UnusedOwner as PolicyBindingIndexObject, UnusedOwner as BudgetLedgerObject, UnusedOwner as UsageLedgerObject, UnusedOwner as GrantCredentialObject };
let active;
const originalDigest=crypto.subtle.digest.bind(crypto.subtle);
const gate=(mode,phase)=>fetch('https://cover-gate.example/'+mode+'/'+phase,{redirect:'manual'}).then(async r=>{if(!r.ok)throw Error('fixture gate');await r.text();});
const snapshot=()=>active?{...active.op?.snapshot(),mode:active.mode,charged:bodyBudgetCharged(),locked:active.body.locked,
  result:active.result,retired:active.retired,code:active.code,cleanupCode:active.cleanupCode,cancels:active.cancels,unlocks:active.unlocks,
  readHeld:active.readHeld,cleanupDone:active.cleanupDone,hashHeld:active.hashHeld,hashBytes:active.hashBytes,hashBacking:active.hashBacking,
  value:active.value,claimDenied:active.claimDenied}:{};
Object.defineProperty(crypto.subtle,'digest',{value:async function(...args){
 const a=active;a.hashBytes=args[1].byteLength;a.hashBacking=args[1].buffer.byteLength;
 const result=await originalDigest(...args);
 if(a.mode==='hash'||a.mode==='hash-reject'){a.hashHeld=true;a.ready();await gate(a.mode,'hash');if(a.mode==='hash-reject')throw Error('sanitized fixture hash');}
 return result;
}});
export default {async fetch(request,env,context){
 const url=new URL(request.url);
 if(url.pathname==='/state')return Response.json(snapshot());
 if(url.pathname==='/contend'){const lease=new BodyLease();try{return Response.json({allowed:lease.grow(1024*1024),charged:bodyBudgetCharged()});}finally{lease.release();}}
 if(url.pathname!=='/start')return new Response(null,{status:404});
 if(active&&!active.retired)return new Response(null,{status:409});
 const mode=url.searchParams.get('mode'),a=active={mode,body:request.body,result:false,retired:false,cancels:0,unlocks:0,readHeld:false,cleanupDone:false,hashHeld:false};
 let ready;const entered=new Promise(r=>ready=r);a.ready=ready;
 const controller=new AbortController(),getReader=request.body.getReader.bind(request.body);let readCount=0;
 request.body.getReader=options=>{const reader=getReader(options);return {
  async read(view){readCount++;
   if((mode==='reads8192'||mode==='reads8193')&&readCount<=(mode==='reads8192'?8190:8191))return {done:false,value:view.subarray(0,0)};
   try {const part=await reader.read(view);
    if(mode==='backing')return {done:false,value:new Uint8Array(new ArrayBuffer(16385),0,2)};
    return part;
   }finally{if((mode==='read'||mode==='cancel-reject')&&readCount===1){a.readHeld=true;ready();await gate(mode,'read');}}
  },
  async cancel(reason){a.cancels++;try{await reader.cancel(reason);}finally{
   if(mode==='read'||mode==='cancel-reject'){await gate(mode,'cleanup');a.cleanupDone=true;}
   if(mode==='cancel-reject')throw {ignored:'original rejection is not persisted'};
  }},releaseLock(){a.unlocks++;reader.releaseLock();}
 }};
 a.op=beginMiniMaxMusicCoverInput({body:request.body,signal:controller.signal,deadlineAt:Date.now()+60000,
  route:url.searchParams.get('route')==='manifest'?'manifest':'native',contentType:'application/json'});
 if(['read','cancel-reject','hash','hash-reject'].includes(mode))context.waitUntil(entered.then(()=>gate(mode,'abort')).then(()=>controller.abort()));
 context.waitUntil(a.op.result.then(async sealed=>{
  a.value=claimMiniMaxMusicCoverInput(sealed);try{claimMiniMaxMusicCoverInput(sealed);}catch{a.claimDenied=true;}
  a.result=true;ready();await gate(mode,'delivery');await a.op.discard();
 },error=>{a.code=error.code;a.result=true;ready();}).catch(()=>{}));
 context.waitUntil(a.op.retired.then(()=>{a.retired=true;},error=>{a.cleanupCode=error.code;a.retired=true;}));
 await entered;return Response.json({...snapshot(),limits:musicCoverInputLimits});
}};`;

async function barriers(t) {
  const held = new Map(), released = new Set();
  const server = createServer((request, response) => {
    if (request.method !== "GET" || !/^\/[a-z0-9-]+\/(abort|read|cleanup|hash|delivery)$/.test(request.url)) { response.writeHead(400); response.end(); return; }
    if (released.has(request.url)) { response.end("ok"); return; }
    held.set(request.url, response); request.on("close", () => held.delete(request.url));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const release = (mode, phase) => { const key = "/" + mode + "/" + phase; released.add(key); held.get(key)?.end("ok"); held.delete(key); };
  t.after(async () => { for (const response of held.values()) response.end("ok"); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { origin: "http://127.0.0.1:" + server.address().port, release };
}

function input(bytes = 2, { route = "native", maximum = false, audio, suffix = "", malformed = false, raw } = {}) {
  const encoder = new TextEncoder(), plan = { prompt: maximum ? "s".repeat(300) : "Synthetic style", ...(maximum ? { lyrics: "🎵".repeat(930) } : {}), model: "music-cover" };
  const prefix = (route === "manifest" ? '{"body":' : "") + '{"audio_base64":"';
  const tail = '",' + JSON.stringify(plan).slice(1) + (route === "manifest" ? "}" : "");
  let padding = maximum ? 65536 - encoder.encode(prefix + tail).length : 0;
  function* pieces() {
    if (raw !== undefined) { for (let offset = 0; offset < raw.length; offset += 256) yield encoder.encode(raw.slice(offset, offset + 256)); return; }
    yield encoder.encode(prefix);
    if (malformed) { yield new Uint8Array([0xff]); return; }
    if (audio !== undefined) yield encoder.encode(audio);
    else {
      let count = Math.floor(bytes / 3) * 4;
      while (count) { const take = Math.min(16384, count); yield encoder.encode("A".repeat(take)); count -= take; }
      if (bytes % 3) yield encoder.encode(bytes % 3 === 1 ? "AA==" : "AAA=");
    }
    yield encoder.encode(tail);
    while (padding) { const take = Math.min(16384, padding); yield encoder.encode(" ".repeat(take)); padding -= take; }
    if (suffix) yield encoder.encode(suffix);
  }
  const iterator = pieces();
  return new ReadableStream({ pull(c) { const next = iterator.next(); if (next.done) c.close(); else c.enqueue(next.value); }, cancel() { iterator.return(); } }, { highWaterMark: 0 });
}
function zeroHash(bytes) {
  const hash = createHash("sha256"), part = Buffer.alloc(16384);
  while (bytes) { const take = Math.min(bytes, part.length); hash.update(part.subarray(0, take)); bytes -= take; }
  return hash.digest("hex");
}

test("cover INPUT ONLY actual Workerd: decimal50M, seven-category bounds, malformed intake, physical retirement and contention", { timeout: 180000 }, async t => {
  const temporary = await mkdtemp(join(tmpdir(), "minimax-cover-input-workerd-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const control = await barriers(t);
  const upstream = `export default {fetch(request){if(new URL(request.url).hostname!=='cover-gate.example')throw Error('no provider calls');return fetch(${JSON.stringify(control.origin)}+new URL(request.url).pathname,{redirect:'manual'});}};`;
  const runtime = await startWorkerdFixture(temporary, router, upstream);
  const modes = ["maximum", "manifest", "read", "cancel-reject", "hash", "hash-reject", "reads8192", "reads8193", "backing", "padding", "trailing", "overflow", "utf8", "tokens", "scalar", "escapes"];
  t.after(async () => { for (const mode of modes) for (const phase of ["abort", "read", "cleanup", "hash", "delivery"]) control.release(mode, phase); await runtime.dispose(); });
  const call = async path => { const response = await runtime.dispatchFetch("https://router.example" + path); assert.equal(response.status, 200); return response.json(); };
  const until = async predicate => { let value; for (let i = 0; i < 500; i++) { value = await call("/state"); if (predicate(value)) return value; await delay(10); } assert.fail(JSON.stringify(value)); };
  const start = async (mode, bytes, options = {}) => {
    const response = await runtime.dispatchFetch("https://router.example/start?mode=" + mode + "&route=" + (options.route ?? "native"),
      { method: "POST", headers: { "content-type": "application/json" }, body: input(bytes, options), duplex: "half" });
    assert.equal(response.status, 200); return response.json();
  };
  for (const mode of ["maximum", "manifest"]) {
    const route = mode === "manifest" ? "manifest" : "native";
    let state = await start(mode, 50_000_000, { maximum: true, route });
    assert.equal(state.value.bytes, 50_000_000, JSON.stringify(state)); assert.equal(state.hashBacking, 50_000_000);
    assert.equal(state.hashBytes, 50_000_000); assert.equal(state.value.sha256, zeroHash(50_000_000));
    assert.equal(state.wire, 66_732_204); assert.equal(state.nonAudio, 65536); assert.equal(state.maxFeed, 256);
    assert.ok(state.maxBacking <= 16384); assert.ok(state.reads <= 8192); assert.equal(state.locked, false); assert.equal(state.claimDenied, true);
    assert.equal(state.limits.remainder.reduce((a, b) => a + b), 655360); assert.equal(state.limits.records, 12);
    assert.equal(state.limits.records * state.limits.recordCell + state.limits.unusedRecordAllowance, 256 * 1024);
    assert.equal(state.limits.hashPhase + state.limits.slack, 96 * 1024 * 1024);
    assert.equal(state.charged, 96 * 1024 * 1024); assert.deepEqual(await call("/contend"), { allowed: false, charged: 96 * 1024 * 1024 });
    control.release(mode, "delivery"); state = await until(s => s.retired); assert.equal(state.charged, 0); assert.equal(state.unlocks, 1);
  }
  for (const mode of ["read", "cancel-reject", "hash", "hash-reject"]) {
    let state = await start(mode, 2); assert.equal(state.charged, 96 * 1024 * 1024);
    assert.equal(mode.startsWith("hash") ? state.hashHeld : state.readHeld, true);
    control.release(mode, "abort"); state = await until(s => s.result); assert.equal(state.code, "cancelled");
    assert.equal(state.retired, false); assert.equal(state.charged, 96 * 1024 * 1024);
    assert.deepEqual(await call("/contend"), { allowed: false, charged: 96 * 1024 * 1024 });
    if (mode.startsWith("hash")) { assert.equal(state.locked, false); control.release(mode, "hash"); }
    else {
      assert.equal(state.cancels, 1); assert.equal(state.locked, true); control.release(mode, "cleanup");
      state = await until(s => s.cleanupDone); assert.equal(state.charged, 96 * 1024 * 1024); assert.equal(state.locked, true);
      control.release(mode, "read");
    }
    state = await until(s => s.retired); assert.equal(state.charged, 0); assert.equal(state.locked, false); assert.equal(state.unlocks, 1);
    assert.equal(state.cleanupCode, mode === "cancel-reject" ? "cleanup" : undefined);
  }
  for (const [mode, bytes, options] of [["padding", 2, { audio: "AAB=" }], ["trailing", 2, { suffix: "x" }],
    ["utf8", 2, { malformed: true }], ["overflow", 50_000_001, {}], ["backing", 2, {}], ["reads8193", 2, {}],
    ["tokens", 2, { raw: '{"audio_base64":' + "[".repeat(256) }],
    ["scalar", 2, { raw: '{"audio_base64":"AAA=","model":"music-cover","prompt":"Synthetic style","lyrics":"' + "\\u0001".repeat(1000) + '"}' }]]) {
    let state = await start(mode, bytes, options); state = await until(s => s.retired);
    assert.equal(state.code, "invalid", JSON.stringify(state)); assert.equal(state.digestStarted, false); assert.equal(state.charged, 0);
    assert.equal(state.locked, false); assert.equal(state.unlocks, 1); assert.equal(state.cancels, 1);
    if (mode === "reads8193") assert.equal(state.reads, 8193); // Denied attempt; only8192 original reads are invoked.
  }
  let state = await start("reads8192", 2); assert.equal(state.value.bytes, 2); assert.equal(state.reads, 8192);
  control.release("reads8192", "delivery"); state = await until(s => s.retired); assert.equal(state.charged, 0);
  state = await start("escapes", 2, { audio: "\\u0041\\u0041\\u0041=" }); assert.equal(state.value.bytes, 2);
  assert.ok(state.nonAudio > 18); control.release("escapes", "delivery"); state = await until(s => s.retired); assert.equal(state.charged, 0);
});
