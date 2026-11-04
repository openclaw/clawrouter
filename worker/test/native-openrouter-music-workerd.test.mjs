import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { channel } from "node:diagnostics_channel";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startWorkerdFixture } from "../../test/helpers/workerd.mjs";

// Shared only between this test host and its synthetic upstream Worker. Neither
// buffers the full wire/audio. The router under test uses the actual fetch path.
function* musicWire(full = true, padded = true, terminal = true) {
  const size = full ? 16 * 1024 * 1024 : 236;
  const header = new Uint8Array(44), view = new DataView(header.buffer);
  const text = (offset, value) => { for (let i = 0; i < value.length; i++) header[offset + i] = value.charCodeAt(i); };
  text(0, "RIFF"); view.setUint32(4, size - 8, true); text(8, "WAVEfmt "); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 24000, true); view.setUint32(28, 48000, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, "data"); view.setUint32(40, size - 44, true);
  let bytes = 0;
  const envelope = (choices, extra = {}) => "data: " + JSON.stringify({ id: "gen-full-size-fixture", model: "google/lyria-3-pro-preview", choices, ...extra }) + "\n\n";
  for (let offset = 0; offset < size; offset += 24576) {
    const audio = new Uint8Array(Math.min(24576, size - offset));
    if (!offset) audio.set(header);
    const part = envelope([{ index: 0, delta: { audio: { data: btoa(String.fromCharCode(...audio)) } }, finish_reason: null }]);
    bytes += part.length; yield part;
  }
  for (const part of [envelope([{ index: 0, delta: {}, finish_reason: "stop" }]),
    envelope([], { usage: { prompt_tokens: 99, completion_tokens: 999, cost: 12.34 } })]) { bytes += part.length; yield part; }
  const done = "data: [DONE]\n\n";
  let padding = padded ? 32 * 1024 * 1024 - bytes - done.length : 0;
  while (padding) {
    let size = Math.min(padding, 128 * 1024);
    if (padding > size && padding - size < 3) size -= 3;
    yield ":" + "p".repeat(size - 3) + "\n\n"; padding -= size;
  }
  if (terminal) yield done;
}

// A real pending socket keeps the upstream request's read alive. An exhausted
// JS generator with no pending I/O is a hung request in workerd, not a provider
// waiting for more audio. This source is private to the quarantine-abort case.
async function pendingMusicSource(t) {
  const metrics={requests:0,bytes:0,closed:0};
  let resolveClosed, abortGate, abortReleased=false;
  const closed=new Promise(resolve=>{resolveClosed=resolve;});
  const server=createServer((request,response)=>{
    if(request.method==='GET'&&request.url==='/abort-gate'){abortGate=response;if(abortReleased)response.end('released');return;}
    if(request.method==='GET'&&request.url==='/release-abort'){abortReleased=true;abortGate?.end('released');response.end('released');return;}
    if(request.method!=='GET'||request.url!=='/pending-music'){response.writeHead(404);response.end();return;}
    metrics.requests++;metrics.status=200;
    response.on('close',()=>{metrics.closed++;resolveClosed();});
    response.writeHead(200,{'content-type':'text/event-stream'});
    for(const part of musicWire(false,false,false)){metrics.bytes+=Buffer.byteLength(part);response.write(part);}
    // Deliberately no end(): the caller must cancel this actual response read.
  });
  t.after(()=>new Promise((resolve,reject)=>{
    server.closeAllConnections();server.close(error=>error?reject(error):resolve());
  }));
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  return {url:'http://127.0.0.1:'+server.address().port+'/pending-music',metrics,closed};
}

const router = `
export { PolicyBindingIndexObject, BudgetLedgerObject, UsageLedgerObject, GrantCredentialObject } from './worker/index.ts';
import worker from './worker/index.ts';
import { snapshot } from './worker/providers.ts';
import { authorityCall } from './worker/authority.ts';
import { putGrantCredentials } from './worker/grant-credentials.ts';
import { sha256Hex } from './worker/utils.ts';
import { bodyBudgetCharged } from './worker/body-budget.ts';
import { usageStub } from './worker/ledgers.ts';
import { HttpOperation } from './worker/http-operation.ts';
// This is the published source1 composition dependency, not a substitute selector.
import { configureMusic, musicBody } from './worker/test/openrouter-music-runtime-fixture.mjs';
configureMusic(snapshot.providers.find(value => value.id === 'openrouter'));
const originalFetch = globalThis.fetch.bind(globalThis), originalReader = ReadableStream.prototype.getReader;
const bodies = new WeakSet(), operations = new WeakMap(); let initialized, metrics = {}, pending = new Set(), incomingApplication;
// Capture only fixed categories, never upstream messages, bodies or credentials.
function readFailure(error) {
  const message=typeof error?.message==='string'?error.message:'';
  return {name:['Error','TypeError','AbortError','TimeoutError'].includes(error?.name)?error.name:'other',
    category:message.includes('code had hung and would never generate a response')?'workerd_hung_request'
      :message==='unbounded transport window'?'fixture_input_window'
      :message==='unbounded returned window'?'fixture_returned_window':'unclassified'};
}
// Observe the original operation without changing its first cause. The explicit
// fixture-controlled incoming signal below is not physical-disconnect evidence.
const originalStop = HttpOperation.prototype.stop;
HttpOperation.prototype.stop = function(cause, reason) {
  const current=operations.get(this.signal), first=this.delivery===undefined;
  const result=originalStop.call(this,cause,reason);
  if(current&&first){
    current.operationCause=cause;current.operationStatus=this.status;current.operationDelivery=this.delivery;
    current.operationReasonName=reason?.name;current.operationStopOrder=++current.sequence;
    current.controlledReasonMatches=incomingApplication?.current===current&&reason===incomingApplication.reason;
  }
  return result;
};
globalThis.fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  if (url !== 'https://openrouter.ai/api/v1/chat/completions') throw new Error('unexpected physical destination');
  const current=metrics; current.fetches++; current.fetchStartOrder=++current.sequence; current.dispatchCapacity=bodyBudgetCharged();
  const signal=init?.signal ?? (input instanceof Request ? input.signal : undefined);
  if(signal&&current.mode==='quarantine-cancel')operations.set(signal,current);
  current.upstreamAborted=signal?.aborted ?? false;
  signal?.addEventListener('abort',()=>{current.upstreamAborted=true;current.upstreamAbortOrder=++current.sequence;},{once:true});
  const response = await originalFetch(input, init); current.upstreamStatus=response.status;current.upstreamHeadersOrder=++current.sequence;
  const attempt=response.headers.get('x-fixture-music-attempt');
  current.physicalAttempt=attempt&&/^[1-9][0-9]{0,7}$/.test(attempt)?Number(attempt):null;
  if (response.body) bodies.add(response.body); return response;
};
ReadableStream.prototype.getReader = function(options) {
  const reader = originalReader.call(this, options);
  if (bodies.has(this)) {
    bodies.delete(this); const current=metrics; current.nativeReaders++; current.byob=options?.mode === 'byob';
    const read = reader.read.bind(reader), cancel = reader.cancel.bind(reader);
    reader.read = async (view, options) => {
      current.reads++; current.activeReads++;current.readStartOrder=++current.sequence;
      try {
        if (!view || view.buffer.byteLength > 65536) throw new Error('unbounded transport window');
        current.maxWindow=Math.max(current.maxWindow,view.buffer.byteLength);
        const result=await read(view,options); current.lastReadDone=result.done;current.readReturnOrder=++current.sequence;
        if(result.value){
          if(result.value.buffer.byteLength>65536)throw new Error('unbounded returned window');
          current.bytes+=result.value.byteLength;
        }
        return result;
      } catch(error){current.readErrorName=error?.name;current.readFailure=readFailure(error);current.readErrorOrder=++current.sequence;throw error;}
      finally {current.activeReads--;}
    };
    reader.cancel = reason => { current.cancels++;current.cancelOrder=++current.sequence;return cancel(reason); };
  }
  return reader;
};
export default { async fetch(request, bindings, context) {
  const url = new URL(request.url), env = {...bindings, OPENROUTER_SITE_URL:'https://example.com'};
  if (url.pathname === '/proof') return Response.json({...metrics, pending:pending.size, capacity:bodyBudgetCharged()});
  // Read only after the operation settles, so observation cannot keep a stalled
  // upstream request alive or provide the cancellation barrier itself.
  if (url.pathname === '/physical-proof') return originalFetch('https://openrouter.ai/__fixture_music_phase');
  if (url.pathname === '/usage') return usageStub(env,'fixture','fixture').fetch('https://usage/snapshot?events=admin');
  if (url.pathname === '/__fixture/music/abort-incoming') {
    if(request.method!=='POST'||url.search)return new Response('invalid fixture control',{status:400});
    const active=incomingApplication,current=active?.current;
    // The slot owns the original application Request, never a caller-supplied ID.
    // It is single-use and only injectable while that exact paid read is pending.
    if(!active||current!==metrics||current.mode!=='quarantine-cancel'||current.controlInjections
      ||active.controller.signal.aborted||active.request.signal.aborted||current.operationCause!==undefined
      ||current.status!==undefined||current.fetches!==1||current.nativeReaders!==1
      ||current.upstreamStatus!==200||current.bytes!==753||current.activeReads!==1)
      return new Response('original fixture read unavailable',{status:409});
    current.controlInjections=1;current.controlInjectionOrder=++current.sequence;
    await (await originalFetch('https://openrouter.ai/__fixture_release_abort')).text();
    // Acknowledges injection only. Cleanup and accounting must be observed later.
    return Response.json({injected:true});
  }
  initialized ??= (async () => {
    await authorityCall(env, '/policies/initialize-all', [{policyId:'fixture',policy:{enabled:true,generation:'g1',providers:['openrouter'],tenantId:'fixture',monthlyBudgetMicros:10000,requestCostMicros:700,retainRequestContent:false}}]);
    await authorityCall(env, '/credentials/initialize-all', [{credentialId:'fixture',credential:{enabled:true,secretSha256:await sha256Hex('fixture-secret'),policyId:'fixture',policyGeneration:'g1'}}]);
    await authorityCall(env, '/connections/initialize-all', [{providerId:'openrouter',enabled:true,monthlyBudgetMicros:10000}]);
    await putGrantCredentials(env, 'oauth/fixture/openrouter', {provider:'openrouter',kind:'api_key',enabled:true,credential:'synthetic-original-key'});
  })();
  await initialized;
  const mode = url.searchParams.get('mode');
  if (pending.size || bodyBudgetCharged()) {
    metrics.guardRejection = {requestedMode:mode,previousMode:metrics.mode,pending:pending.size,capacity:bodyBudgetCharged()};
    return Response.json({error:'fixture_previous_delivery_pending',...metrics.guardRejection},{status:500});
  }
  metrics = {mode,fetches:0,nativeReaders:0,reads:0,activeReads:0,bytes:0,maxWindow:0,cancels:0,byob:false,sequence:1,requestStartOrder:1,fixtureRequestAborted:request.signal.aborted,routedRequestAborted:false};
  const current=metrics;
  const fixtureSignal=request.signal;
  fixtureSignal.addEventListener('abort',()=>{current.fixtureRequestAborted=true;current.fixtureRequestAbortOrder=++current.sequence;},{once:true});
  if (!['full','delivery-cancel','quarantine-cancel','small','truncated'].includes(mode)) return new Response('invalid fixture mode',{status:400});
  const controlled=mode==='quarantine-cancel'?new AbortController():undefined;
  if(controlled){
    current.incomingApplicationAborted=controlled.signal.aborted;
    controlled.signal.addEventListener('abort',()=>{current.incomingApplicationAborted=true;current.incomingApplicationAbortOrder=++current.sequence;},{once:true});
  }
  const body = musicBody(); body.messages[0].content = mode;
  const routedRequest=new Request('https://router.example/v1/native/openrouter/v1/chat/completions',{
    method:'POST',headers:{authorization:'Bearer clawrouter-live-fixture-fixture-secret','content-type':'application/json'},body:JSON.stringify(body),signal:controlled?.signal??fixtureSignal
  });
  if(controlled)incomingApplication={current,request:routedRequest,controller:controlled,
    reason:Object.freeze({source:'fixture-controlled incoming application signal'})};
  if(controlled){
    const active=incomingApplication;
    // Cancellation must run in the original request's I/O continuation.
    context.waitUntil(originalFetch('https://openrouter.ai/__fixture_abort_gate').then(response=>response.text())
      .then(()=>active.controller.abort(active.reason)));
  }
  const routedSignal=routedRequest.signal;current.routedRequestAborted=routedSignal.aborted;
  routedSignal.addEventListener('abort',()=>{current.routedRequestAborted=true;current.routedRequestAbortOrder=++current.sequence;},{once:true});
  try {
    const response = await worker.fetch(routedRequest,env,{waitUntil(promise){const tracked=Promise.resolve(promise).finally(()=>pending.delete(tracked));pending.add(tracked);context.waitUntil(tracked);}});
    current.status=response.status;current.returnOrder=++current.sequence;current.beforeDeliveryCapacity=bodyBudgetCharged();
    // Do not call response.text()/arrayBuffer() here: actual delivery must leave
    // the isolate without another whole-wire allocation or synthetic reader.
    return response;
  } finally {if(incomingApplication?.current===current)incomingApplication=undefined;}
}, queue:worker.queue };
`;
const upstream = pendingUrl => `const musicWire = ${musicWire.toString()};
let attempts=0;const phases=[];
export default {async fetch(request){
  if(request.url==='https://openrouter.ai/__fixture_abort_gate')return fetch(new URL('/abort-gate',${JSON.stringify(pendingUrl)}));
  if(request.url==='https://openrouter.ai/__fixture_release_abort')return fetch(new URL('/release-abort',${JSON.stringify(pendingUrl)}));
  if(request.url==='https://openrouter.ai/__fixture_music_phase'&&request.method==='GET')return Response.json({attempts,phases});
  const phase={attempt:++attempts,post:request.method==='POST',pathMatches:request.url==='https://openrouter.ai/api/v1/chat/completions',
    pulls:0,bytes:0,exhausted:false,canceled:false,requestAborted:request.signal.aborted};
  phases.push(phase);if(phases.length>8)phases.shift();
  request.signal.addEventListener('abort',()=>{phase.requestAborted=true;},{once:true});
  if(request.url !== 'https://openrouter.ai/api/v1/chat/completions' || request.method !== 'POST'
    || request.headers.get('authorization') !== 'Bearer synthetic-original-key') {phase.status=400;return new Response('invalid original dispatch',{status:400});}
  const body = await request.json(); if(body.model !== 'google/lyria-3-pro-preview' || body.audio.format !== 'wav') {phase.status=400;return new Response('invalid native body',{status:400});}
  const mode = body.messages[0].content, small = mode === 'small' || mode === 'quarantine-cancel';
  phase.mode=['full','delivery-cancel','quarantine-cancel','small','truncated'].includes(mode)?mode:'other';phase.status=200;
  if(mode==='quarantine-cancel'){
    // No native credential is forwarded to this loopback byte source. Its real
    // pending network read belongs to this original synthetic provider request.
    const network=await fetch(${JSON.stringify(pendingUrl)},{signal:request.signal});
    phase.networkStatus=network.status;phase.activeReads=0;
    if(network.status!==200||!network.body)throw new Error('fixture network source unavailable');
    const reader=network.body.getReader();
    return new Response(new ReadableStream({async pull(controller){
      phase.pulls++;phase.activeReads++;
      try{
        const part=await reader.read();if(phase.canceled)return;
        if(part.done){phase.exhausted=true;reader.releaseLock();controller.close();return;}
        phase.bytes+=part.value.byteLength;controller.enqueue(part.value);
      }finally{phase.activeReads--;}
    },async cancel(reason){phase.canceled=true;try{await reader.cancel(reason);}finally{reader.releaseLock();}}},{highWaterMark:0}),
      {headers:{'content-type':'text/event-stream','x-fixture-music-attempt':String(phase.attempt)}});
  }
  const parts = musicWire(!small,!small,mode !== 'truncated' && mode !== 'quarantine-cancel'); let finished = false;
  return new Response(new ReadableStream({pull(controller){
    phase.pulls++;
    if(finished) return; const part=parts.next();
    if(part.done){finished=true;phase.exhausted=true;if(mode==='truncated')controller.close();return;}
    const bytes=new TextEncoder().encode(part.value);phase.bytes+=bytes.byteLength;controller.enqueue(bytes);
  },cancel(){phase.canceled=true;finished=true;parts.return();}},{highWaterMark:0}),{headers:{'content-type':'text/event-stream','x-fixture-music-attempt':String(phase.attempt)}});
}};`;

async function readFixtureJson(url) {
  const response = await fetch(url);
  try { assert.equal(response.status, 200, 'fixture observation failed'); return await response.json(); }
  finally { await response.body?.cancel().catch(() => {}); }
}
async function settled(origin) {
  let value;
  for (let attempt = 0; attempt < 100; attempt++) {
    value = await readFixtureJson(new URL('/proof', origin));
    if (value.capacity === 0 && value.pending === 0) return value;
    await delay(50);
  }
  assert.fail("original music operation did not release capacity after delivery/cancellation: " + JSON.stringify(value));
}
async function settlement(origin, count, status) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const { events } = await readFixtureJson(new URL('/usage', origin));
    if (events.length >= count) {
      assert.equal(events.length, count); assert.equal(new Set(events.map(event => event.id)).size, count);
      const event = events[0]; assert.equal(event.status, status);
      assert.equal(event.actual_cost_micros, 700); assert.equal(event.cost_basis, 'policy_fixed');
      assert.equal(event.grant_key, 'oauth/fixture/openrouter'); assert.equal(event.capability, 'music.generate');
      assert.equal(event.input_tokens, null); assert.equal(event.output_tokens, null); assert.equal(event.total_tokens, null);
      return event;
    }
    await delay(50);
  }
  assert.fail('original operation did not publish one conservative policy-fixed settlement');
}
function assertPhysical(value) {
  assert.equal(value.fetches, 1); assert.equal(value.nativeReaders, 1); assert.equal(value.byob, true);
  assert.ok(value.reads > 0); assert.equal(value.maxWindow, 65536); assert.equal(value.cancels, 1);
  assert.ok(value.dispatchCapacity >= 64 * 1024 * 1024 && value.dispatchCapacity <= 96 * 1024 * 1024);
  assert.equal(value.capacity, 0); assert.equal(value.pending, 0);
}

// A failed header/status assertion must still stop the HTTP pump and retire its
// original operation. Otherwise the first case can retain capacity into the next.
async function musicRequest(origin, mode, run) {
  const abort = new AbortController(); let response, failure;
  const pending = fetch(new URL('/?mode=' + mode, origin), {signal:abort.signal})
    .then(value => { response = value; return value; });
  void pending.catch(() => {}); // Observe a rejection even if a fixture assertion fails first.
  try { return await run(pending, abort); }
  catch (error) { failure = error; throw error; }
  finally {
    abort.abort();
    await pending.catch(() => {});
    await response?.body?.cancel().catch(() => {});
    try { await settled(origin); }
    catch (error) {
      if (failure) throw new AggregateError([failure,error], 'fixture assertion failed and cleanup did not release the original operation');
      throw error;
    }
  }
}
async function assertStatus(response, expected, origin) {
  if (response.status !== expected)
    assert.fail(JSON.stringify({expectedStatus:expected,actualStatus:response.status,proof:await readFixtureJson(new URL('/proof',origin))}));
}

// Observe only this host request. A socket close is not proof of a TCP RST or
// an incoming Worker abort; neither the dispatcher nor the socket is changed.
function observeMusicHostTransport(origin) {
  const target=new URL('/?mode=quarantine-cancel',origin);
  const state={origin:target.origin,path:target.pathname+target.search,requests:0,sequence:0,dropped:0,events:[]};
  let request,socket;
  const socketState=()=>socket&&({destroyed:socket.destroyed,readableEnded:socket.readableEnded,writableEnded:socket.writableEnded});
  const record=(phase,fields={})=>{
    const order=++state.sequence;
    if(state.events.length<16)state.events.push({order,phase,...fields,socket:socketState()});else state.dropped++;
    return order;
  };
  const matches=value=>value?.method==='GET'&&String(value.origin)===target.origin&&value.path===state.path;
  const created=message=>{
    if(!matches(message?.request))return;
    state.requests++;
    if(!request){request=message.request;record('request-created');}
  };
  const closed=hadError=>record('socket-close',{hadError:hadError===true});
  const sent=message=>{
    if(!request||message?.request!==request)return;
    if(!socket){socket=message.socket;socket?.once('close',closed);}
    record('headers-sent',{sameRequest:true,portMatches:socket?.remotePort===Number(target.port)});
  };
  const failed=message=>{
    if(!request||message?.request!==request)return;
    const error=message.error;
    record('request-error',{sameRequest:true,
      name:['Error','TypeError','AbortError','TimeoutError','RequestAbortedError','SocketError'].includes(error?.name)?error.name:'other',
      code:['ABORT_ERR','ECONNRESET','UND_ERR_ABORTED','UND_ERR_SOCKET','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT'].includes(error?.code)?error.code:'other'});
  };
  channel('undici:request:create').subscribe(created);
  channel('undici:client:sendHeaders').subscribe(sent);
  channel('undici:request:error').subscribe(failed);
  return {snapshot:()=>({...state,socket:socketState()}),record,dispose(){
    channel('undici:request:create').unsubscribe(created);
    channel('undici:client:sendHeaders').unsubscribe(sent);
    channel('undici:request:error').unsubscribe(failed);
    socket?.removeListener('close',closed);
  }};
}

test("workerd full-output music uses actual fetch BYOB, original wire, bounded delivery and cancellation", {timeout:120000}, async t => {
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-full-music-workerd-")); t.after(() => rm(temporary, {recursive:true,force:true}));
  const network=await pendingMusicSource(t);
  const instance = await startWorkerdFixture(temporary,router,upstream(network.url),{directRouter:true}); t.after(() => instance.dispose());
  const origin = (await instance.ready).origin;
  await t.test("exact 16 MiB WAV / 32 MiB SSE reaches the consumer with the response lease held", () => musicRequest(origin,'full',async pending => {
    const response = await pending;
    await assertStatus(response,200,origin); assert.equal(response.headers.get('content-type'),'text/event-stream');
    // Workerd ignores manually assigned Content-Length for an ordinary stream:
    // https://developers.cloudflare.com/workers/runtime-apis/response/#set-the-content-length-header
    // Prove the actual count/hash after complete delivery, independently of HTTP framing.
    const hash=createHash('sha256'); let bytes=0;
    for await (const chunk of response.body) {bytes+=chunk.byteLength;hash.update(chunk);}
    const expected=createHash('sha256'); for(const part of musicWire())expected.update(part);
    // Independently decoder-qualified 16 MiB WAV in this exact 32 MiB SSE fixture.
    const expectedHash=expected.digest('hex');
    assert.equal(expectedHash,'b25351f0c76ebc191d53b6275d14277aff41279a3c1d1af45131af243875bd43');
    assert.equal(bytes,32*1024*1024); assert.equal(hash.digest('hex'),expectedHash);
    const proof=await settled(origin);assertPhysical(proof);assert.equal(proof.bytes,bytes);
    assert.ok(proof.beforeDeliveryCapacity>=64*1024*1024);
    await settlement(origin,1,'success');
  }));
  await t.test("small DONE on an open socket never requires filling the BYOB window", () => musicRequest(origin,'small',async pending => {
    const response=await pending;await assertStatus(response,200,origin);
    assert.equal(await response.text(),[...musicWire(false,false)].join(''));
    const proof=await settled(origin);assertPhysical(proof);assert.ok(proof.bytes<65536);
    await settlement(origin,2,'success');
  }));
  await t.test("full-size replay cancellation releases the original operation without replaying POST", () => musicRequest(origin,'delivery-cancel',async (pending,abort) => {
    const response=await pending;await assertStatus(response,200,origin);
    const reader=response.body.getReader();
    try { assert.ok((await reader.read()).value.length); }
    finally { abort.abort(); await reader.cancel().catch(()=>{}); reader.releaseLock(); }
    const proof=await settled(origin);assertPhysical(proof);assert.equal(proof.bytes,32*1024*1024);
    assert.ok(proof.beforeDeliveryCapacity>=64*1024*1024);
    await settlement(origin,3,'client_error');
  }));
  await t.test("controlled incoming signal cancels quarantine without partial audio; host transport is separate", async caseTest => {
    // HOST TRANSPORT ONLY: on locked workerd 1.20261023.1, the real host abort
    // and socket close did not propagate before headers (90d5553 trace).
    // Physical pre-header propagation remains BLOCKED, not a cancellation PASS.
    // This case explicitly injects an application signal to prove common cleanup.
    // The outer signal stays observed; a future runtime may propagate it.
    const origin=(await instance.unsafeGetDirectURL('router')).origin;
    const count=(await readFixtureJson(new URL('/usage',origin))).events.length;
    const transport=observeMusicHostTransport(origin);
    try { return await musicRequest(origin,'quarantine-cancel',async(pending,abort)=>{
      const reason=new DOMException('fixture music caller cancellation','AbortError');
      const host={phase:'fetch-pending',bytes:0,abortEvents:0,signalInitiallyAborted:abort.signal.aborted};
      abort.signal.addEventListener('abort',()=>{
        host.abortEvents++;host.signalAborted=abort.signal.aborted;host.reasonMatches=abort.signal.reason===reason;
        transport.record('host-abort',{reasonMatches:host.reasonMatches});
      },{once:true});
      const outcome=pending.then(async response=>{
        host.phase='headers';host.status=response.status;host.mime=response.headers.get('content-type');
        host.headersBeforeAbort=!abort.signal.aborted;
        transport.record('host-headers',{status:host.status,beforeAbort:host.headersBeforeAbort});
        if(!response.body){host.phase='no-body';return;}
        const reader=response.body.getReader();host.phase='read-pending';
        try {
          const part=await reader.read();host.bytes=part.value?.byteLength ?? 0;host.bodyDone=part.done;host.phase='read-resolved';
          if(host.bytes && host.bytes<=4096){
            try{const value=JSON.parse(new TextDecoder().decode(part.value));host.bodyErrorCode=typeof value?.error?.code==='string'?value.error.code:undefined;}catch{}
          }
        } catch(error){host.phase='read-rejected';host.readErrorName=error?.name;host.readRejectedAfterAbort=abort.signal.aborted;transport.record('host-read-rejected',{afterAbort:host.readRejectedAfterAbort});}
        finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
      },error=>{host.phase='fetch-rejected';host.fetchErrorName=error?.name;host.fetchReasonMatches=error===reason;host.fetchRejectedAfterAbort=abort.signal.aborted;transport.record('host-fetch-rejected',{afterAbort:host.fetchRejectedAfterAbort,reasonMatches:host.fetchReasonMatches});});
      let beforeAbort,barrier=false,hostBeforeAbort,networkBeforeAbort,beforeInjection,injection,afterAbort,physical,receipt;
      try {
        for(let attempt=0;attempt<100;attempt++){
          beforeAbort=await readFixtureJson(new URL('/proof',origin));
          const current=beforeAbort.mode==='quarantine-cancel';
          if(current&&beforeAbort.nativeReaders===1&&beforeAbort.bytes>0&&beforeAbort.bytes<65536
            &&beforeAbort.activeReads===1&&beforeAbort.status===undefined&&!beforeAbort.fixtureRequestAborted&&!beforeAbort.routedRequestAborted&&!beforeAbort.upstreamAborted){barrier=true;break;}
          if((current&&beforeAbort.status!==undefined) || host.bytes || host.fetchErrorName || host.readErrorName)break;
          await delay(20);
        }
        hostBeforeAbort={...host};networkBeforeAbort={...network.metrics};abort.abort(reason);await outcome;
        // Host transport completion does not authorize a cleanup claim. Explicit
        // injection into the original application Request begins a separate proof.
        beforeInjection=await readFixtureJson(new URL('/proof',origin));
        const control=await fetch(new URL('/__fixture/music/abort-incoming',origin),{method:'POST'});
        try {assert.equal(control.status,200,'original incoming signal injection rejected');injection=await control.json();}
        finally {await control.body?.cancel().catch(()=>{});}
        assert.deepEqual(injection,{injected:true});
        afterAbort=await settled(origin);physical=await readFixtureJson(new URL('/physical-proof',origin));
        if(barrier)await network.closed;
        const trace=JSON.stringify({barrier,beforeAbort,hostBeforeAbort,host,beforeInjection,injection,afterAbort,physical,networkBeforeAbort,network:network.metrics});
        // Record the real ledger outcome before any signal-observation assertion.
        // Common first-cause status remains independently checked below.
        receipt=await settlement(origin,count+1,'client_error');
        assert.deepEqual(networkBeforeAbort,{requests:1,bytes:753,closed:0,status:200},trace);
        assert.deepEqual(network.metrics,{requests:1,bytes:753,closed:1,status:200},trace);
        assert.equal(barrier,true,trace);assert.equal(host.signalInitiallyAborted,false,trace);
        assert.equal(hostBeforeAbort.abortEvents,0,trace);assert.equal(host.abortEvents,1,trace);
        assert.equal(abort.signal.aborted,true,trace);assert.equal(host.signalAborted,true,trace);
        assert.equal(abort.signal.reason,reason,trace);assert.equal(host.reasonMatches,true,trace);
        assert.equal(host.bytes,0,trace);assert.equal(afterAbort.upstreamAborted,true,trace);assert.equal(afterAbort.activeReads,0,trace);
        if(host.status===undefined){
          assert.equal(host.fetchErrorName,'AbortError',trace);assert.equal(host.fetchReasonMatches,true,trace);
          assert.equal(host.fetchRejectedAfterAbort,true,trace);
        } else {
          // Response headers and body cancellation are separate observations.
          assert.equal(host.status,200,trace);assert.equal(host.mime,'text/event-stream',trace);
          assert.equal(host.readErrorName,'AbortError',trace);assert.equal(host.readRejectedAfterAbort,true,trace);
        }
        // The real outer signal is an observation, not a prescribed false value.
        // Controlled incoming/routed signals and first cause are strict proof.
        assert.equal(typeof afterAbort.fixtureRequestAborted,'boolean',trace);
        assert.equal(beforeInjection.incomingApplicationAborted,false,trace);
        assert.equal(beforeInjection.routedRequestAborted,false,trace);
        assert.equal(afterAbort.incomingApplicationAborted,true,trace);
        assert.equal(afterAbort.routedRequestAborted,true,trace);
        assert.equal(afterAbort.controlInjections,1,trace);assert.equal(afterAbort.controlledReasonMatches,true,trace);
        assert.ok(afterAbort.controlInjectionOrder<afterAbort.operationStopOrder,trace);
        assert.equal(afterAbort.operationCause,'caller',trace);assert.equal(afterAbort.operationStatus,'client_error',trace);
        assert.equal(receipt.status,'client_error',trace);assert.equal(afterAbort.operationDelivery,'canceled',trace);
        const attempts=physical.phases.filter(value=>value.mode==='quarantine-cancel');
        assert.equal(attempts.length,1,trace);assert.equal(attempts[0].attempt,afterAbort.physicalAttempt,trace);
        assert.equal(physical.attempts,afterAbort.physicalAttempt,trace);
        assert.equal(attempts[0].post,true,trace);assert.equal(attempts[0].pathMatches,true,trace);
        assertPhysical(afterAbort);
      } finally {
        caseTest.diagnostic(JSON.stringify({barrier,beforeAbort,hostBeforeAbort,host,beforeInjection,injection,afterAbort,physical,networkBeforeAbort,network:network.metrics,
          hostTransportOnly:transport.snapshot(),physicalPreHeaderPropagation:'BLOCKED in locked runtime; controlled signal is not wire proof',
          receipt:receipt&&{status:receipt.status,cost:receipt.actual_cost_micros,basis:receipt.cost_basis,
            grant:receipt.grant_key,capability:receipt.capability,input:receipt.input_tokens,output:receipt.output_tokens,total:receipt.total_tokens}}));
      }
    }); } finally { transport.dispose(); }
  });
  await t.test("full audio with missing native DONE is an atomic failure", () => musicRequest(origin,'truncated',async pending => {
    const response=await pending;await assertStatus(response,502,origin);
    const text=await response.text();assert.ok(text.length<4096);assert.doesNotMatch(text,/UklG|AAAA/);
    assertPhysical(await settled(origin));
    await settlement(origin,5,'provider_error');
  }));
});
