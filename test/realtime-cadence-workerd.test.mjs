import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startWorkerdFixture } from './helpers/workerd.mjs';

// Fixed 15ms authority RPC / 30ms status RPC delays wrap real production
// authority and SQLite ledgers. Neither authorization nor accounting is mocked.
const router = String.raw`
import handler, { BudgetLedgerObject as RealBudgetLedger } from './worker/index.ts';
import { putGrantCredentials } from './worker/grant-credentials.ts';
export * from './worker/index.ts';
let delay = { authority: 15, ledger: 30 }, calls = { authority: 0, ledger: 0, held: 0 };
let holdPath = '', releases = [];
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
    if (key === 'authority' || url.pathname === '/status') { calls[key]++; await pause(delay[key]); }
    return stub.fetch(...input);
  } }; };
} }); }
export default { async fetch(r, env, ctx) {
  const path = new URL(r.url).pathname;
  if (path === '/fixture-grant') { await putGrantCredentials(env, 'oauth/fixture/openai', { enabled: true, provider: 'openai', kind: 'api_key', credential: 'fixture-upstream-key' }); return new Response('ok'); }
  if (path === '/fixture-delay') { delay = await r.json(); return new Response('ok'); }
  if (path === '/fixture-calls') return Response.json(calls);
  if (path === '/fixture-hold') { const mode = await r.text(); holdPath = mode === 'on' ? '/status' : mode === 'dispatch' ? '/dispatch' : ''; if (!holdPath) { for (const release of releases) release(); releases = []; } return new Response('ok'); }
  return handler.fetch(r, { ...env, ACCESS_CONTROL: delayed(env.ACCESS_CONTROL, 'authority'), BUDGET_LEDGER: delayed(env.BUDGET_LEDGER, 'ledger') }, ctx);
}, queue: handler.queue };
`;
const upstream = String.raw`
let appends = [], outputs = 0, creates = 0, ticks = [];
export default { async fetch(r) {
  if (new URL(r.url).pathname === '/fixture-stats') return Response.json({ appends, outputs, creates, maxTickGapMs: Math.max(0, ...ticks.slice(1).map((at, i) => at - ticks[i])) });
  if (r.headers.get('authorization') !== 'Bearer fixture-upstream-key') throw Error('wrong route');
  const pair = new WebSocketPair(), ws = pair[1]; ws.accept(); let timer, active;
  const send = e => ws.send(JSON.stringify(e));
  ws.addEventListener('close', () => clearInterval(timer));
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
  const events = [], errors = [], outputDelay = [], acks = []; let closed = false;
  ws.addEventListener('message', e => { const value = JSON.parse(e.data); events.push(value);
    if (value.type === 'error') errors.push(value.error.code);
    if (value.type === 'rate_limits.updated') acks.push(value.rate_limits[0].remaining);
    if (value.type === 'response.output_audio.delta') outputDelay.push(Date.now() - value.fixture_at);
  });
  ws.addEventListener('close', () => { closed = true; });
  return { events, errors, outputDelay, acks, get closed() { return closed; }, async next(type) {
    for (let i = 0; i < 1500; i++) { const found = events.findIndex(e => e.type === type); if (found >= 0) return events.splice(found, 1)[0]; if (closed) throw Error('closed: ' + errors); await sleep(5); }
    throw Error('missing ' + type + ': ' + errors);
  } };
}
async function fixture(t) {
  const temporary = await mkdtemp(join(tmpdir(), 'clawrouter-cadence-'));
  let mf;
  t.after(async () => { try { await mf?.dispose(); } finally { await rm(temporary, { recursive: true, force: true }); } });
  // Idle Durable Object eviction is a local co-scheduling stall, not router latency.
  mf = await startWorkerdFixture(temporary, router, upstream, { preventEviction: true });
  const kv = await mf.getKVNamespace('POLICY_KV', 'router'), ns = await mf.getDurableObjectNamespace('ACCESS_CONTROL', 'router');
  const authority = ns.get(ns.idFromName('policy-bindings')), svc = await mf.getWorker('upstream');
  const secret = 'cadence-fixture-secret', headers = { authorization: 'Bearer clawrouter-live-fixture-' + secret };
  const policy = async (extra = {}) => {
    const r = await authority.fetch('https://authority/policies/put', { method: 'POST', body: JSON.stringify({ policyId: 'fixture', policy: { enabled: true, generation: 'g1', providers: ['openai'], budgetMode: 'soft', monthlyBudgetMicros: 100_000_000, retainRequestContent: false, ...extra } }) }); assert.equal(r.status, 200);
  };
  const credential = { enabled: true, secretSha256: createHash('sha256').update(secret).digest('hex'), policyId: 'fixture', policyGeneration: 'g1' };
  const setCredential = async extra => { const r = await authority.fetch('https://authority/credentials/mutate', { method: 'POST', body: JSON.stringify({ operation: 'put', credentialId: 'fixture', scope: 'admin', actor: { auth: 'admin_token', role: 'admin', email: 'fixture@example.invalid' }, credential: { ...credential, ...extra } }) }); assert.equal(r.status, 200, await r.text()); };
  await policy(); await kv.put('credentials/fixture', JSON.stringify(credential));
  await kv.put('connections/openai', JSON.stringify({ providerId: 'openai', enabled: true, monthlyBudgetMicros: 100_000_000 }));
  return { mf, kv, authority, svc, headers, policy, setCredential, async control(path, body) { return mf.dispatchFetch('https://router' + path, { method: 'POST', body }); }, async stats() { return (await svc.fetch('https://upstream/fixture-stats')).json(); }, async open(asr, response = true, authHeaders = headers) {
    const r = await mf.dispatchFetch('https://router/v1/realtime?model=gpt-realtime-2.1', { headers: { ...authHeaders, upgrade: 'websocket' } }); assert.equal(r.status, 101, r.status === 101 ? '' : await r.text());
    const ws = r.webSocket, q = observe(ws); ws.accept(); ws.send(JSON.stringify({ type: 'session.update', session: session(asr) })); await q.next('session.updated');
    if (response) { ws.send(JSON.stringify({ type: 'response.create' })); await q.next('response.output_item.added'); }
    return { ws, q };
  } };
}
async function cadence(t, asr, frames, rpc) {
  const f = await fixture(t);
  if (rpc) assert.equal((await f.control('/fixture-delay', JSON.stringify(rpc))).status, 200);
  const c = await f.open(asr), offeredAt = [], scheduleLag = [], start = Date.now();
  for (let i = 0; i < frames; i++) {
    await sleep(Math.max(0, start + i * 20 - Date.now())); const now = Date.now(); scheduleLag.push(now - start - i * 20); offeredAt.push(now);
    if (!c.q.closed) c.ws.send(JSON.stringify({ type: 'input_audio_buffer.append', event_id: 'cad_' + i, audio: Buffer.alloc(160, 255).toString('base64') }));
  }
  await sleep(Math.max(0, start + frames * 20 - Date.now()));
  for (let i = 0; i < 100 && c.q.acks.length < frames && !c.q.closed; i++) await sleep(5);
  const stats = await (await f.svc.fetch('https://upstream/fixture-stats')).json(), calls = await (await f.mf.dispatchFetch('https://router/fixture-calls')).json();
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
    if (kind === 'route') await f.control('/fixture-grant', 'put');
    const c = await f.open(asr, false);
    append(c, 0); await c.q.next('rate_limits.updated');
    const changed = Date.now();
    if (kind === 'revocation') await f.setCredential({ enabled: false });
    if (kind === 'principal') await f.setCredential({ principalId: 'reassigned@example.invalid' });
    if (kind === 'tenant') await f.policy({ tenantId: 'reassigned' });
    if (kind === 'generation') await f.policy({ generation: 'g2' });
    if (kind === 'route') await f.control('/fixture-grant', 'rotate');
    if (kind === 'asr-model') await f.policy({ models: ['openai/gpt-realtime-2.1'] });
    if (kind === 'budget') await f.policy({ monthlyBudgetMicros: 0 });
    let sent = 1;
    while (!c.q.closed && Date.now() - changed < 1000) { append(c, sent++); await sleep(20); }
    const elapsed = Date.now() - changed, stats = await f.stats();
    assert.equal(c.q.closed, true, JSON.stringify({ kind, elapsed, stats }));
    assert.ok(elapsed <= 250, '100ms freshness plus observed RPC envelope: ' + elapsed);
    const code = { revocation: /authority_revoked/, principal: /caller_changed/, tenant: /caller_changed/, generation: /policy_changed|authority_revoked/, route: /grant|route/, 'asr-model': /model_not_allowed/, budget: /budget_exhausted/ }[kind];
    assert.equal(c.q.errors.length, 1); assert.match(c.q.errors[0], code);
    assert.ok(stats.appends.length <= 7, JSON.stringify({ kind, elapsed, stats }));
    await sleep(120); assert.equal((await f.stats()).appends.length, stats.appends.length, 'no egress after retirement');
    t.diagnostic(JSON.stringify({ kind, asr, closeMs: elapsed, egress: stats.appends.length, code: c.q.errors[0] }));
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
