import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { startBundledWorkerdFixture } from './helpers/workerd.mjs';
const require = createRequire(import.meta.resolve('wrangler/package.json'));
const { build } = require('esbuild');

// Fixed 15ms authority RPC / 30ms status RPC delays wrap real production
// authority and SQLite ledgers. Neither authorization nor accounting is mocked.
const router = String.raw`
import handler, { BudgetLedgerObject as RealBudgetLedger } from './worker/index.ts';
import { putGrantCredentials } from './worker/grant-credentials.ts';
import { isPreparationLimit } from './worker/provider-templates.ts';
export * from './worker/index.ts';
let delay = { authority: 15, ledger: 30 }, calls = { authority: 0, ledger: 0, held: 0 };
let holdPath = '', releases = [], observations = [], observing = false;
let holdInspection = false, heldInspection = false;
let preparation = { owners:0, main:0, asr:0, reused:0, wrongOwner:0, observations:0, pending:0, peakPending:0, settled:0, registered:0, background:0, phase:'idle', joined:false, operationSettled:false, operationFailed:false, producerClosed:false, enrollmentClosed:false, drainComplete:false, drainFailed:false, drainFailures:0, drainUndefined:0, drainRoots:0 };
// All original promises and failure reasons stay in this request's drain owner.
function preparationProbe(ctx, allowCapacity = false, lateFailure = false) {
 const roots=[], owners=new WeakMap();let nextOwner=0,latest,handshake,opened=false,ended=false,endProducer;
 const producerClosed=new Promise(resolve=>{endProducer=resolve;});
 const end=()=>{if(!ended){ended=true;preparation.producerClosed=true;endProducer();}};
 const watch=(pending,kind,owner)=>{const outcome=Promise.resolve(pending).then(()=>({failed:false}),error=>({failed:true,error})).then(result=>{
  if(kind==='observation'){owner.pending=false;preparation.pending--;preparation.settled++;}
  if(kind==='background')preparation.background--;
  return {...result,kind};});roots.push(outcome);return outcome;};
 const context={waitUntil(p){preparation.background++;watch(p,'background');ctx.waitUntil(p);},
  fixtureProducerOpened(){opened=true;},
  fixtureProducerClosed(){
   // The real close method has stopped socket/timer producers and registered
   // its final task. Held parents may still register children during the join.
   if(lateFailure){
    const parent=(async()=>{preparation.phase='labelled-late-cleanup-held';
     const gate=await fetch('https://cadence-gate.example/observation');await gate.text();
     const child=Promise.reject(undefined);ctx.waitUntil(watch(child,'fixture-child'));
     throw undefined;
    })();ctx.waitUntil(watch(parent,'fixture-parent'));
   }
   end();
  },
  fixtureOwner(owner){if(owners.has(owner)||owner===handshake)preparation.reused++;const mark={id:++nextOwner,main:false,pending:true};owners.set(owner,mark);latest=mark;preparation.owners++;},
  fixturePreparation(selection,record,p){if(record)handshake=selection.preparation;const mark=owners.get(selection.preparation);
   if(!record){if(!mark)preparation.wrongOwner++;else if(selection.capability==='audio.realtime'){
     if(mark.main)preparation.reused++;mark.main=true;preparation.main++;
    }else {preparation.asr++;if(!mark.main)preparation.wrongOwner++;}}
   watch(p,'preparation');},
  fixtureObservation(p){preparation.observations++;preparation.pending++;preparation.peakPending=Math.max(preparation.peakPending,preparation.pending);watch(p,'observation',latest);preparation.registered++;}
 };
 // Register before invoking the public handler. This is the actual join, never
 // a Promise retrieved from another request or inferred from scalar counters.
 const completion=(async()=>{
  await producerClosed;const failures=[];let index=0;
  for(;;){while(index<roots.length){const outcome=await roots[index++];
    if(outcome.failed&&!(allowCapacity&&outcome.kind!=='background'&&isPreparationLimit(outcome.error)))failures.push(outcome.error);}
   await Promise.resolve();if(index===roots.length)break;
  }
  preparation.enrollmentClosed=true;preparation.drainRoots=roots.length;
  preparation.drainFailures=failures.length;preparation.drainUndefined=failures.filter(error=>error===undefined).length;
  return failures.length?{failed:true,error:new AggregateError(failures,'cadence originating-request failures')}:{failed:false};
 })().then(outcome=>{preparation.drainFailed=outcome.failed;preparation.drainComplete=true;return outcome;});
 ctx.waitUntil(completion); // Tagged outcome retains raw reasons locally; only fixed diagnostics leave.
 return {context,
  entry(p){const observed=watch(p,'entry');void observed.then(()=>{if(!opened)end();});return p;},
  async join(){const outcome=await completion;if(outcome.failed)throw outcome.error;}
 };
}

export class BudgetLedgerObject extends RealBudgetLedger {
  constructor(state) { super(state); this.fixtureSql = state.storage.sql; }
  async fetch(r) { if (new URL(r.url).pathname === '/fixture-rows') return Response.json([...this.fixtureSql.exec('SELECT settled, dispatch_started, reserved_micros FROM budget_reservations')]); return super.fetch(r); }
}
const pause = ms => new Promise(r => setTimeout(r, ms));
function delayed(ns, key) { return new Proxy(ns, { get(target, prop) {
  if (prop !== 'get') { const value = Reflect.get(target, prop); return typeof value === 'function' ? value.bind(target) : value; }
  return (...args) => { const stub = target.get(...args); return { async fetch(...input) {
    const url = new URL(typeof input[0] === 'string' || input[0] instanceof URL ? input[0] : input[0].url);
    if (key === 'ledger' && url.pathname === holdPath) { calls.held++; await new Promise(resolve => releases.push(resolve)); }
    const observed = key === 'authority' || url.pathname === '/status';
    const started = Date.now();
    if (observed) { calls[key]++; await pause(delay[key]); }
    const dispatched = Date.now(), response = await stub.fetch(...input);
    if(key==='authority'&&holdInspection&&!heldInspection){heldInspection=true;preparation.phase='held-completed-authority-reply';
      try{const gate=await fetch('https://cadence-gate.example/observation');await gate.text();}
      catch(primary){try{await response.body?.cancel();}catch(cleanup){throw new AggregateError([primary,cleanup],'cadence held-reply cleanup');}throw primary;}}
    if (observing && observed && observations.length < 64) observations.push({ key, started, dispatched, completed: Date.now(), status: response.status });
    return response;
  } }; };
} }); }
export default { async fetch(r, env, ctx) {
  const path = new URL(r.url).pathname;
  if (path === '/fixture-grant') { await putGrantCredentials(env, 'oauth/fixture/openai', { enabled: true, provider: 'openai', kind: 'api_key', credential: 'fixture-upstream-key' }); return new Response('ok'); }
  if (path === '/fixture-delay') { delay = await r.json(); return new Response('ok'); }
  if (path === '/fixture-observe') { observing = true; return new Response('ok'); }
  if (path === '/fixture-calls') return Response.json({ ...calls, observations, preparation });
  if (path === '/fixture-hold') { const mode = await r.text(); holdPath = mode === 'on' ? '/status' : mode === 'dispatch' ? '/dispatch' : ''; if (!holdPath) { for (const release of releases) release(); releases = []; } return new Response('ok'); }
  const current={...env,ACCESS_CONTROL:delayed(env.ACCESS_CONTROL,'authority'),BUDGET_LEDGER:delayed(env.BUDGET_LEDGER,'ledger')};
  if(path==='/fixture-owned-inspection'){
   const mode=await r.text(),probe=preparationProbe(ctx,mode==='overflow');let ws,hasPrimary=false,primary,errors=[];
   const events=[];let closed=false,hasEventFailure=false,eventFailure;
   const next=async type=>{for(let i=0;i<1500;i++){if(hasEventFailure)throw eventFailure;const at=events.findIndex(e=>e.type===type);if(at>=0)return events.splice(at,1)[0];
     if(closed)throw Error('fixture socket closed before expected event');await pause(5);}throw Error('fixture socket event missing');};
   try{
    const headers=new Headers(r.headers);headers.set('upgrade','websocket');
    const reply=await probe.entry(handler.fetch(new Request('https://router/v1/realtime?model=gpt-realtime-2.1',{headers,signal:r.signal}),current,probe.context));
    if(reply.status!==101){await reply.text();throw Error('fixture upgrade failed');}
    ws=reply.webSocket;ws.addEventListener('message',e=>{try{const value=JSON.parse(e.data);events.push(value);if(value.type==='error')errors.push(value.error.code);}catch(error){hasEventFailure=true;eventFailure=error;}});
    ws.addEventListener('close',()=>{closed=true;});ws.accept();
    if(mode==='overflow')ws.send(JSON.stringify({type:'session.update',session:__ASR_SESSION__}));
    else {ws.send(JSON.stringify({type:'session.update',session:__INITIAL_SESSION__}));await next('session.updated');
      holdInspection=true;ws.send(JSON.stringify({type:'input_audio_buffer.append',event_id:'cad_0',audio:btoa(String.fromCharCode(...new Uint8Array(160)))}));}
    const error=await next('error');
    if(error.error.code!==(mode==='overflow'?'provider_preparation_unavailable':'realtime_authority_timeout'))throw Error('unexpected fixture public error');
    if(mode==='hold'&&(!heldInspection||preparation.pending<1||preparation.registered<1||preparation.background<1))throw Error('timeout lost actual observation');
    preparation.phase=mode==='hold'?'timed-out-owner-still-pending':'capacity-denied';
   }catch(error){hasPrimary=true;primary=error;}
   finally{
    preparation.operationSettled=true;preparation.operationFailed=hasPrimary;
    const failures=hasEventFailure?[eventFailure]:[];try{ws?.close(1000);}catch(error){failures.push(error);}
    try{await probe.join();}catch(error){failures.push(error);}
    preparation.joined=true;
    if(failures.length)throw new AggregateError(hasPrimary?[primary,...failures]:failures,'cadence primary and cleanup failures');
    if(hasPrimary)throw primary;
   }
   return Response.json({fixture:'owned-realtime-inspection',errors,preparation});
  }
  if(r.headers.has('x-fixture-preparation-probe')){const probe=preparationProbe(ctx,false,r.headers.has('x-fixture-late-failure'));return probe.entry(handler.fetch(r,current,probe.context));}
  return handler.fetch(r,current,ctx);
}, queue: handler.queue };
`;
const upstream = String.raw`
let appends = [], outputs = 0, creates = 0, ticks = [], closedAt = null, connections = 0;
export default { async fetch(r) {
  if(new URL(r.url).origin==='https://cadence-gate.example')return fetch(__GATE_ORIGIN__+new URL(r.url).pathname,r);
  if (new URL(r.url).pathname === '/fixture-stats') return Response.json({ appends, outputs, creates, closedAt, connections, maxTickGapMs: Math.max(0, ...ticks.slice(1).map((at, i) => at - ticks[i])) });
  if (r.headers.get('authorization') !== __EXPECTED_AUTH__) throw Error('wrong route');
  connections++;
  const pair = new WebSocketPair(), ws = pair[1]; ws.accept(); let timer, active;
  const send = e => ws.send(JSON.stringify(e));
  ws.addEventListener('close', () => { closedAt = Date.now(); clearInterval(timer); });
  ws.addEventListener('error', () => clearInterval(timer));
  ws.addEventListener('message', event => { const e = JSON.parse(event.data);
    if (e.type === 'session.update') send({ type: 'session.updated', session: e.session });
    if (e.type === 'response.create') {
      creates++; active = 'response_cadence';
      send({ type: 'response.created', response: { id: active, metadata: e.response.metadata } });
      send({ type: 'response.output_item.added', response_id: active, item: { id: 'assistant_cadence', type: 'message', role: 'assistant' } });
      timer = setInterval(() => { outputs++; ticks.push(Date.now()); send({ type: 'response.output_audio.delta', response_id: active, item_id: 'assistant_cadence', delta: btoa(String.fromCharCode(...new Uint8Array(160))), fixture_at: Date.now() }); }, 20);
    }
    if (e.type === 'input_audio_buffer.append') {
      const index = Number(e.event_id.slice(4)); appends.push({ index, at: Date.now() });
      send({ type: 'rate_limits.updated', rate_limits: [{ name: 'append_ack', remaining: index }] });
    }
  });
  return new Response(null, { status: 101, webSocket: pair[0] });
} };
`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const session = asr => ({ type: 'realtime', model: 'gpt-realtime-2.1', output_modalities: ['audio'],
  audio: { input: { format: { type: 'audio/pcmu' }, transcription: asr ? { model: 'gpt-4o-mini-transcribe' } : null,
    turn_detection: { type: 'server_vad', create_response: false, interrupt_response: false } },
  output: { format: { type: 'audio/pcmu' }, voice: 'marin' } }, tools: [], tool_choice: 'none' });
function observe(ws) {
  const events = [], errors = [], outputDelay = [], acks = []; let closedAt = null, errorAt = null;
  ws.addEventListener('message', e => { const value = JSON.parse(e.data); events.push(value);
    if (value.type === 'error') { errorAt ??= Date.now(); errors.push(value.error.code); }
    if (value.type === 'rate_limits.updated') acks.push(value.rate_limits[0].remaining);
    if (value.type === 'response.output_audio.delta') outputDelay.push(Date.now() - value.fixture_at);
  });
  ws.addEventListener('close', () => { closedAt = Date.now(); });
  return { events, errors, outputDelay, acks, get closed() { return closedAt !== null; }, get closedAt() { return closedAt; }, get errorAt() { return errorAt; }, async next(type) {
    for (let i = 0; i < 1500; i++) { const found = events.findIndex(e => e.type === type); if (found >= 0) return events.splice(found, 1)[0]; if (closedAt !== null) throw Error('closed: ' + errors); await sleep(5); }
    throw Error('missing ' + type + ': ' + errors);
  } };
}
async function observedRuntime(temporary, upstreamSource, bindings) {
  const bundle = await build({ stdin: { contents: router.replace('__INITIAL_SESSION__', JSON.stringify(session(false))).replace('__ASR_SESSION__', JSON.stringify(session(true))),
    resolveDir: process.cwd(), sourcefile: 'cadence-fixture.ts', loader: 'ts' }, write: false, bundle: true, format: 'esm', platform: 'browser', target: 'es2022', logLevel: 'silent',
    plugins: [{ name: 'observe-original-realtime-preparation', setup(build) {
      build.onLoad({ filter: /[\\/]worker[\\/]realtime-websocket\.ts$/ }, async ({ path }) => {
        let source = await readFile(path, 'utf8');
        const entry = 'export async function proxyRealtimeWebSocket(request: Request, env: Env, context: ExecutionContext): Promise<Response> {';
        const owner = '    const preparation = new PreparationAdmission();';
        const observation = '    const observation = inspect(input);';
        const producer = '  const session = new RealtimeSession(pair[1], upstream, {';
        const options = '    waitUntil: promise => context.waitUntil(promise),';
        for (const anchor of [entry, owner, observation, producer, options]) assert.equal(source.split(anchor).length, 2, 'unique observation anchor');
        assert.equal(source.split('await prepareSelected(').length, 4, 'three original preparation calls');
        source = source.replaceAll('await prepareSelected(', 'await fixturePrepare(').replace(entry, entry + `
  const fixturePrepare=(...args)=>{const original=prepareSelected(...args);context.fixturePreparation?.(args[2],args[6],original);return original;};`)
          .replace(owner, owner + '\n    context.fixtureOwner?.(preparation);')
          .replace(observation, observation + '\n    context.fixtureObservation?.(observation);')
          .replace(producer, '  context.fixtureProducerOpened?.();\n' + producer)
          .replace(options, options + '\n    fixtureProducerClosed: () => context.fixtureProducerClosed?.(),');
        return { contents: source, loader: 'ts', resolveDir: dirname(path) };
      });
      build.onLoad({ filter: /[\\/]worker[\\/]realtime-session\.ts$/ }, async ({ path }) => {
        const source = await readFile(path, 'utf8'), closed = '    this.options.waitUntil(finish);';
        assert.equal(source.split(closed).length, 2, 'one actual producer-close notification');
        return { contents: source.replace(closed, closed + '\n    this.options.fixtureProducerClosed?.();'), loader: 'ts', resolveDir: dirname(path) };
      });
    } }] });
  return startBundledWorkerdFixture(temporary, bundle.outputFiles[0].text, upstreamSource, { preventEviction: true, bindings });
}
async function fixture(t, options = {}) {
  const temporary = await mkdtemp(join(tmpdir(), 'clawrouter-cadence-'));
  let mf, server, gate, drainProbe, released = false, hasPrimary = false, primary; const clients = [], sockets = [], serverFailures = [];
  const release = () => { released = true; gate?.end('released'); gate = undefined; };
  t.after(async () => {
    release(); const failures = [];
    for (const ws of sockets) try { ws.close(1000); } catch (error) { failures.push(error); }
    try { await drainProbe?.(); } catch (error) { failures.push(error); }
    for (const observed of clients) { const outcome = await observed; if (outcome.failed) failures.push(outcome.error); }
    try { await mf?.dispose(); } catch (error) { failures.push(error); }
    if (server) try { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); } catch (error) { failures.push(error); }
    try { await rm(temporary, { recursive: true, force: true }); } catch (error) { failures.push(error); }
    failures.push(...serverFailures);
    if (failures.length) throw new AggregateError(hasPrimary ? [primary, ...failures] : failures, 'cadence fixture cleanup');
  });
  try {
  server = createServer((request, response) => { request.resume(); if (request.url !== '/observation') { response.writeHead(404); response.end(); }
    else if (released) response.end('released'); else if (gate) { serverFailures.push(Error('unexpected second held observation')); response.writeHead(500); response.end(); } else gate = response; });
  server.on('error', error => serverFailures.push(error));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); }); });
  const expectedKey = options.large ? 's'.repeat(8185) : 'fixture-upstream-key';
  const upstreamSource = upstream.replace('__GATE_ORIGIN__', JSON.stringify('http://127.0.0.1:' + server.address().port)).replace('__EXPECTED_AUTH__', JSON.stringify('Bearer ' + expectedKey));
  // Idle Durable Object eviction is a local co-scheduling stall, not router latency.
  mf = await observedRuntime(temporary, upstreamSource, { OPENAI_API_KEY: expectedKey });
  const kv = await mf.getKVNamespace('POLICY_KV', 'router'), ns = await mf.getDurableObjectNamespace('ACCESS_CONTROL', 'router');
  const authority = ns.get(ns.idFromName('policy-bindings')), svc = await mf.getWorker('upstream');
  const secret = 'cadence-fixture-secret', headers = { authorization: 'Bearer clawrouter-live-fixture-' + secret, ...(options.probe ? { 'x-fixture-preparation-probe': 'on' } : {}), ...(options.lateFailure ? { 'x-fixture-late-failure': 'on' } : {}), ...(options.large ? { 'openai-organization': 'o'.repeat(8192), 'openai-project': 'p'.repeat(8192) } : {}) };
  const track = pending => { clients.push(Promise.resolve(pending).then(value => ({ failed: false, value }), error => ({ failed: true, error }))); return pending; };
  const policy = async (extra = {}) => {
    const r = await authority.fetch('https://authority/policies/put', { method: 'POST', body: JSON.stringify({ policyId: 'fixture', policy: { enabled: true, generation: 'g1', providers: ['openai'], budgetMode: 'soft', monthlyBudgetMicros: 100_000_000, retainRequestContent: false, ...extra } }) }); await r.text(); assert.equal(r.status, 200);
  };
  const credential = { enabled: true, secretSha256: createHash('sha256').update(secret).digest('hex'), policyId: 'fixture', policyGeneration: 'g1' };
  const setCredential = async extra => { const r = await authority.fetch('https://authority/credentials/mutate', { method: 'POST', body: JSON.stringify({ operation: 'put', credentialId: 'fixture', scope: 'admin', actor: { auth: 'admin_token', role: 'admin', email: 'fixture@example.invalid' }, credential: { ...credential, ...extra } }) }); assert.equal(r.status, 200, await r.text()); };
  await track(policy()); await kv.put('credentials/fixture', JSON.stringify(credential));
  await kv.put('connections/openai', JSON.stringify({ providerId: 'openai', enabled: true, monthlyBudgetMicros: 100_000_000 }));
  const call = (url, options) => track(mf.dispatchFetch(url, options).then(async response => ({ status: response.status, text: await response.text() })));
  const probeState = async () => { const response = await call('https://router/fixture-calls'); assert.equal(response.status, 200); return JSON.parse(response.text); };
  // Diagnostics are emitted only AFTER the original request actually joins its
  // tagged roots. This request never receives or awaits that request's I/O.
  drainProbe = options.probe ? async () => {
    const done = await until(async () => { const { preparation } = await probeState(); return preparation.drainComplete ? preparation : false; });
    assert.equal(done.producerClosed, true); assert.equal(done.enrollmentClosed, true); assert.ok(done.drainRoots > 0);
    assert.equal(done.drainFailed, !!options.lateFailure);
    assert.equal(done.drainFailures, options.lateFailure ? 2 : 0); assert.equal(done.drainUndefined, options.lateFailure ? 2 : 0);
    return done;
  } : undefined;
  return { mf, kv, authority, svc, headers, policy, setCredential, release, released: () => released, held: () => !!gate, primary(error) { hasPrimary = true; primary = error; },
    track, probeState, drain: drainProbe,
    owned(mode) { return call('https://router/fixture-owned-inspection', { method: 'POST', headers, body: mode }); },
    control(path, body) { return call('https://router' + path, { method: 'POST', body }); },
    stats() { return track(svc.fetch('https://upstream/fixture-stats').then(response => response.json())); },
    open(asr, response = true, authHeaders = headers) { return track((async () => {
      const r = await mf.dispatchFetch('https://router/v1/realtime?model=gpt-realtime-2.1', { headers: { ...authHeaders, upgrade: 'websocket' } }); assert.equal(r.status, 101, r.status === 101 ? '' : await r.text());
      const ws = r.webSocket, q = observe(ws); sockets.push(ws); ws.accept(); ws.send(JSON.stringify({ type: 'session.update', session: session(asr) })); await q.next('session.updated');
      if (response) { ws.send(JSON.stringify({ type: 'response.create' })); await q.next('response.output_item.added'); }
      return { ws, q };
    })()); }
  };
  } catch (error) { hasPrimary = true; primary = error; throw error; }
}

async function cadence(t, asr, frames, rpc) {
  const f = await fixture(t, { probe: true });
  try {
  if (rpc) assert.equal((await f.control('/fixture-delay', JSON.stringify(rpc))).status, 200);
  const c = await f.open(asr), offeredAt = [], scheduleLag = [], start = Date.now();
  for (let i = 0; i < frames; i++) {
    await sleep(Math.max(0, start + i * 20 - Date.now())); const now = Date.now(); scheduleLag.push(now - start - i * 20); offeredAt.push(now);
    if (!c.q.closed) c.ws.send(JSON.stringify({ type: 'input_audio_buffer.append', event_id: 'cad_' + i, audio: Buffer.alloc(160, 255).toString('base64') }));
  }
  await sleep(Math.max(0, start + frames * 20 - Date.now()));
  for (let i = 0; i < 100 && c.q.acks.length < frames && !c.q.closed; i++) await sleep(5);
  const stats = await f.stats(), calls = await f.probeState();
  const delay = stats.appends.map(x => x.at - offeredAt[x.index]);
  const result = { asr, durationMs: Date.now() - start, offered: frames, nativeChunkMs: 20, bytesPerChunk: 160, injectedAuthorityRpcMs: rpc?.authority ?? 15, injectedLedgerStatusRpcMs: rpc?.ledger ?? 30,
    egress: stats.appends.length, acknowledgments: c.q.acks.length, upstreamAudioFrames: stats.outputs, receivedAudioFrames: c.q.outputDelay.length, maxUpstreamTickGapMs: stats.maxTickGapMs,
    maxEgressMs: Math.max(-1, ...delay), maxDownstreamMs: Math.max(-1, ...c.q.outputDelay), maxSenderScheduleLagMs: Math.max(...scheduleLag), errors: c.q.errors, closed: c.q.closed, calls,
    limits: 'Production shared16-event/256KiB queue, aggregate/idle limits and4096 bidirectional event cap unchanged. Synthetic workerd/SQL only; no physical/provider acceptance.' };
  t.diagnostic(JSON.stringify(result));
  if (process.env.REALTIME_CADENCE_REPORT_PREFIX) await writeFile(process.env.REALTIME_CADENCE_REPORT_PREFIX + '-' + (asr ? 'asr' : 'no-asr') + (rpc ? '-a' + rpc.authority + '-l' + rpc.ledger : '') + '.json', JSON.stringify({ ...result, delayRows: stats.appends.map((x, i) => ({ index: x.index, at: x.at, offeredAt: offeredAt[x.index], delayMs: delay[i] })), downstreamDelays: c.q.outputDelay }, null, 2) + String.fromCharCode(10));
  if (!c.q.closed) c.ws.close(1000);
  assert.deepEqual(result.errors, []); assert.equal(result.closed, false); assert.equal(result.egress, frames); assert.equal(result.acknowledgments, frames);
  assert.ok(result.receivedAudioFrames >= frames * 0.9, JSON.stringify(result)); assert.ok(result.maxEgressMs <= 250, JSON.stringify(result)); assert.ok(result.maxDownstreamMs <= 250, JSON.stringify(result));
  assert.ok(result.maxSenderScheduleLagMs <= 100, 'host did not sustain native cadence: ' + JSON.stringify(result));
  const final = await f.drain();
  assert.equal(final.pending, 0); assert.equal(final.background, 0);
  assert.equal(final.reused, 0); assert.equal(final.wrongOwner, 0); assert.equal(final.main, final.owners);
  if (frames === 500) assert.ok(final.main > 86, 'healthy media continues beyond the old failure interval');
  if (asr) assert.ok(final.asr > 0, 'main and ASR use the same observed owner');
  } catch (error) { f.primary(error); throw error; }
}
for (const asr of [false, true]) test('native 20ms duplex cadence for 10s, ASR=' + asr, { timeout: 30_000 }, t => cadence(t, asr, 500));
// First ASR byte is serial authority -> funded soft admission -> authority. Its
// budget lease starts when the funding observation starts, so slower (40/30ms)
// RPCs neither re-observe immediately nor overflow the shared 16-event queue.
test('ASR first-byte admission keeps native cadence with 40ms authority / 30ms ledger RPCs', { timeout: 15_000 }, t => cadence(t, true, 100, { authority: 40, ledger: 30 }));

const append = (c, index) => c.ws.send(JSON.stringify({ type: 'input_audio_buffer.append', event_id: 'cad_' + index, audio: Buffer.alloc(160, 255).toString('base64') }));
async function until(check) { const end = Date.now() + 3000; for (;;) { const value = await check(); if (value) return value; if (Date.now() >= end) assert.fail('condition deadline exceeded'); await sleep(5); } }
for (const asr of [false, true]) for (const kind of ['revocation', 'principal', 'tenant', 'generation', 'route', 'asr-model', 'budget']) {
  if (!asr && ['asr-model', 'budget'].includes(kind)) continue;
  test('bounded media authority ' + kind + ', ASR=' + asr, { timeout: 15_000 }, async t => {
    const f = await fixture(t);
    const diagnostic = asr && ['revocation', 'generation', 'budget'].includes(kind);
    if (diagnostic) await f.control('/fixture-observe', 'on');
    if (kind === 'route') await f.control('/fixture-grant', 'put');
    const c = await f.open(asr, false);
    append(c, 0); await c.q.next('rate_limits.updated');
    const mutationStarted = Date.now();
    if (kind === 'revocation') await f.setCredential({ enabled: false });
    if (kind === 'principal') await f.setCredential({ principalId: 'reassigned@example.invalid' });
    if (kind === 'tenant') await f.policy({ tenantId: 'reassigned' });
    if (kind === 'generation') await f.policy({ generation: 'g2' });
    if (kind === 'route') await f.control('/fixture-grant', 'rotate');
    if (kind === 'asr-model') await f.policy({ models: ['openai/gpt-realtime-2.1'] });
    if (kind === 'budget') await f.policy({ monthlyBudgetMicros: 0 });
    // Measure enforcement after authority acknowledges the mutation. Its own
    // storage/RPC latency is outside the socket's media freshness window.
    const changed = Date.now(), mutationMs = changed - mutationStarted;
    let sent = 1; const sentAt = [];
    while (!c.q.closed && Date.now() - changed < 1000) { sentAt.push(Date.now()); append(c, sent++); await sleep(20); }
    const elapsed = Math.max(0, (c.q.closedAt ?? Date.now()) - changed), stats = await f.stats();
    if (diagnostic) {
      const calls = await (await f.mf.dispatchFetch('https://router/fixture-calls')).json();
      // A failed deadline must retain authority/RPC, sender and both socket
      // observations; diagnostics after the assertion lose the failing state.
      t.diagnostic(JSON.stringify({ kind, asr, mutationStarted, changed, mutationMs, closeMs: elapsed, errorAt: c.q.errorAt, clientClosedAt: c.q.closedAt, sentAt, errors: c.q.errors, stats, calls }));
    }
    assert.equal(c.q.closed, true, JSON.stringify({ kind, elapsed, stats }));
    assert.ok(elapsed <= 250, '100ms freshness plus observed RPC envelope: ' + elapsed);
    const code = { revocation: /authority_revoked/, principal: /caller_changed/, tenant: /caller_changed/, generation: /policy_changed|authority_revoked/, route: /grant|route/, 'asr-model': /model_not_allowed/, budget: /budget_exhausted/ }[kind];
    assert.equal(c.q.errors.length, 1); assert.match(c.q.errors[0], code);
    assert.ok(stats.appends.length <= 7, JSON.stringify({ kind, elapsed, stats }));
    await sleep(120); assert.equal((await f.stats()).appends.length, stats.appends.length, 'no egress after retirement');
    t.diagnostic(JSON.stringify({ kind, asr, mutationMs, closeMs: elapsed, egress: stats.appends.length, code: c.q.errors[0] }));
  });
}
for (const mode of ['response', 'ASR', 'hard-response']) test('authority changes across real ' + mode + ' funding await retire unsent unit once', { timeout: 15_000 }, async t => {
  const input = mode === 'ASR', f = await fixture(t);
  if (mode === 'hard-response') await f.policy({ budgetMode: 'hard' });
  const c = await f.open(input, false);
  await f.control('/fixture-hold', mode === 'hard-response' ? 'dispatch' : 'on');
  if (input) append(c, 0); else c.ws.send(JSON.stringify({ type: 'response.create' }));
  await until(async () => (await (await f.mf.dispatchFetch('https://router/fixture-calls')).json()).held > 0);
  await f.setCredential({ enabled: false }); await f.control('/fixture-hold', 'off');
  await sleep(150);
  const stats = await f.stats();
  t.diagnostic(JSON.stringify({ input, appends: stats.appends.length, creates: stats.creates, errors: c.q.errors }));
  assert.equal(stats.appends.length, 0, 'no ASR byte after revocation during admission');
  assert.equal(stats.creates, 0, 'no response after revocation during admission');
  assert.equal((await c.q.next('error')).error.code, 'realtime_authority_revoked');
  // Re-enable the SAME caller only to inspect its private durable reporting rows.
  await f.setCredential({});
  const rows = await until(async () => { const u = await (await f.mf.dispatchFetch('https://router/v1/usage', { headers: f.headers })).json(); return u.usage?.events.length ? u.usage.events : false; });
  assert.equal(rows.length, 1); assert.equal(rows[0].actual_cost_micros, 0); assert.equal(rows[0].cost_basis, 'none');
  assert.equal(rows[0].capability, input ? 'audio.transcription' : 'audio.realtime');
  await sleep(120);
  const final = await (await f.mf.dispatchFetch('https://router/v1/usage', { headers: f.headers })).json();
  assert.equal(final.usage.events.length, 1, 'exactly once even after late ledger/close completion');
  const ns = await f.mf.getDurableObjectNamespace('BUDGET_LEDGER', 'router');
  for (const name of ['default:fixture', 'provider:openai']) { const rows = await (await ns.get(ns.idFromName(name)).fetch('https://ledger/fixture-rows')).json(); assert.equal(rows.length, 1); assert.equal(rows[0].settled, 1); assert.equal(rows[0].dispatch_started, 1); assert.equal(rows[0].reserved_micros, 0); }
});

test('socket-local media authority cannot be refreshed by a different key', { timeout: 15_000 }, async t => {
  const f = await fixture(t), a = await f.open(false, false);
  append(a, 0); await a.q.next('rate_limits.updated');
  const secret = 'other-fixture-secret';
  await f.kv.put('credentials/other', JSON.stringify({ enabled: true, secretSha256: createHash('sha256').update(secret).digest('hex'), policyId: 'fixture', policyGeneration: 'g1' }));
  const b = await f.open(false, false, { authorization: 'Bearer clawrouter-live-other-' + secret });
  await f.setCredential({ enabled: false });
  await sleep(110);
  append(b, 1); await b.q.next('rate_limits.updated');
  const before = (await f.stats()).appends.length;
  append(a, 2); assert.equal((await a.q.next('error')).error.code, 'realtime_authority_revoked');
  assert.equal((await f.stats()).appends.length, before); assert.equal(b.q.closed, false);
  append(b, 3); await b.q.next('rate_limits.updated'); b.ws.close(1000);
});
test('slow authority completion does not renew media freshness', { timeout: 15_000 }, async t => {
  const f = await fixture(t), c = await f.open(false, false);
  await f.control('/fixture-delay', JSON.stringify({ authority: 150, ledger: 30 }));
  append(c, 0); await c.q.next('rate_limits.updated');
  await f.setCredential({ enabled: false });
  append(c, 1); assert.equal((await c.q.next('error')).error.code, 'realtime_authority_revoked');
  assert.equal((await f.stats()).appends.length, 1);
});


for (const mode of ['overflow', 'hold']) test('actual Realtime observation owner: ' + mode, { timeout: 25_000 }, async t => {
  const f = await fixture(t, { large: mode === 'overflow' });
  try {
    const pending = f.owned(mode);
    if (mode === 'hold') {
      let state, settled = false;
      const early = f.track(pending.then(() => { settled = true; if (!f.released()) throw Error('diagnostic completed before held observation release'); }, error => { settled = true; throw error; }));
      for (let n = 0; n < 1800; n++) {
        state = await Promise.race([early, f.probeState()]);
        if (state.preparation.operationFailed) { f.release(); await pending; assert.fail('failed originating operation unexpectedly fulfilled'); }
        if (state.preparation.phase === 'timed-out-owner-still-pending') break;
        await Promise.race([early, sleep(5)]);
      }
      assert.equal(state.preparation.phase, 'timed-out-owner-still-pending');
      assert.equal(f.held(), true); assert.equal(settled, false); assert.ok(state.preparation.pending >= 1); assert.ok(state.preparation.background >= 1);
      assert.equal(state.preparation.joined, false); assert.ok(state.preparation.peakPending >= 2, 'periodic and held media observations overlap without sharing owners');
      assert.equal((await f.stats()).connections, 1);
      f.release(); await early;
    }
    const response = await pending; assert.equal(response.status, 200);
    const result = JSON.parse(response.text);
    assert.equal(result.fixture, 'owned-realtime-inspection');
    assert.deepEqual(result.errors, [mode === 'overflow' ? 'provider_preparation_unavailable' : 'realtime_authority_timeout']);
    assert.equal(result.preparation.joined, true); assert.equal(result.preparation.pending, 0); assert.equal(result.preparation.background, 0);
    assert.equal(result.preparation.reused, 0); assert.equal(result.preparation.wrongOwner, 0);
    if (mode === 'overflow') assert.ok(result.preparation.asr >= 1, 'actual ASR stage shares the main allowance');
    assert.equal((await f.stats()).connections, 1, 'no replacement upstream connection');
  } catch (error) { f.primary(error); throw error; }
});

test('originating cadence drain retains late parent and child undefined failures after the snapshot', { timeout: 15_000 }, async t => {
  // Labelled fixture cleanup faults; actual preparation and public route stay healthy.
  const f = await fixture(t, { probe: true, lateFailure: true });
  try {
    const c = await f.open(false, false), snapshot = await f.probeState();
    assert.deepEqual(c.q.errors, []); assert.equal(snapshot.preparation.drainComplete, false);
    c.ws.close(1000);
    await until(async () => { const state = (await f.probeState()).preparation; assert.equal(state.drainComplete, false, 'originating drain completed before the held phase'); return state.phase === 'labelled-late-cleanup-held' && f.held(); });
    const held = await f.probeState(); assert.equal(f.held(), true); assert.equal(held.preparation.drainComplete, false);
    f.release(); const done = await f.drain();
    assert.equal(done.drainFailed, true); assert.equal(done.drainFailures, 2); assert.equal(done.drainUndefined, 2);
    assert.equal(done.pending, 0); assert.equal(done.background, 0); assert.equal((await f.stats()).connections, 1);
  } catch (error) { f.primary(error); throw error; }
});
