#!/usr/bin/env node
// Synthetic-only workerd fixture; outboundService captures every upstream fetch.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir, cpus, platform, arch } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { startWorkerdFixture } from '../test/helpers/workerd.mjs';
import { parseOptions, runLoad } from './loadtest.mjs';

const { values } = parseArgs({ options: { out: { type: 'string' }, concurrency: { type: 'string', default: '10,50,100,200' }, requests: { type: 'string', default: '400' }, 'delay-ms': { type: 'string', default: '20' }, 'max-tokens': { type: 'string', default: '32' }, scenarios: { type: 'string', default: 'catalog,count,messages,stream,abort' }, label: { type: 'string', default: 'local' } } });
const concurrency = values.concurrency.split(',').map(Number), requests = Number(values.requests), delay = Number(values['delay-ms']);
const scenarios = values.scenarios.split(',');
assert.ok(concurrency.every(value => Number.isSafeInteger(value) && value > 0));
assert.ok(Number.isSafeInteger(requests) && requests > 0 && Number.isFinite(delay) && delay >= 0);
assert.ok(scenarios.every(value => ['catalog', 'pool', 'count', 'messages', 'stream', 'abort'].includes(value)));
const temporary = await mkdtemp(join(tmpdir(), 'clawrouter-load-'));
const keyFile = join(temporary, 'key');
const secret = 'synthetic-load-fixture', key = `clawrouter-live-load-${secret}`, admin = 'synthetic-admin';
const sha = value => createHash('sha256').update(value).digest('hex');
await writeFile(keyFile, key, { mode: 0o600 });
let mf;
const memory = [];
function sampleProcesses() {
  try {
    const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,rss=,%cpu=,comm='], { encoding: 'utf8' }).trim().split('\n').map(line => line.trim().split(/\s+/, 5));
    const descendants = new Set([String(process.pid)]);
    for (let pass = 0; pass < 5; pass++) for (const row of rows) if (descendants.has(row[1])) descendants.add(row[0]);
    const workers = rows.filter(row => descendants.has(row[0]) && row[4]?.includes('workerd'));
    memory.push({ at: Date.now(), rssMiB: workers.reduce((sum, row) => sum + Number(row[2]) / 1024, 0), cpuPercent: workers.reduce((sum, row) => sum + Number(row[3]), 0) });
  } catch { /* OS diagnostics are advisory */ }
}
try {
  const router = `import handler, { PolicyBindingIndexObject, BudgetLedgerObject, UsageLedgerObject, GrantCredentialObject } from './worker/index.ts';
export { PolicyBindingIndexObject, BudgetLedgerObject, UsageLedgerObject, GrantCredentialObject };
const authorityCalls = {};
export default { ...handler, fetch(request, env, ctx) {
 if (new URL(request.url).pathname === '/__load/stats') return fetch('https://synthetic.invalid/__stats');
 if (new URL(request.url).pathname === '/__load/authority') return Response.json(authorityCalls);
 const ACCESS_CONTROL = { idFromName: name => env.ACCESS_CONTROL.idFromName(name), get(id) {
  const stub = env.ACCESS_CONTROL.get(id);
  return { fetch(url, init) { const path = new URL(url).pathname; authorityCalls[path] = (authorityCalls[path] ?? 0) + 1; return stub.fetch(url, init); } };
 } };
 return handler.fetch(request, { ...env, ACCESS_CONTROL, CLAWROUTER_ADMIN_TOKEN_SHA256: '${sha(admin)}', ANTHROPIC_API_KEY: 'synthetic-environment' }, ctx);
}};`;
  const upstream = `const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const counts = { requests: 0, streams: 0, count: 0, messages: 0, canceled: 0, completed: 0 };
export default { async fetch(request) {
 if (new URL(request.url).pathname === '/__stats') return Response.json(counts);
 const body = await request.json(); counts.requests++;
 const headers = { 'content-type': 'application/json', 'anthropic-ratelimit-unified-5h-utilization': '0.1', 'anthropic-ratelimit-unified-5h-reset': String(Math.floor(Date.now()/1000)+18000) };
 if (new URL(request.url).pathname.endsWith('count_tokens')) { counts.count++; await sleep(${delay}); counts.completed++; return Response.json({ input_tokens: 12 }, { headers }); }
 if (!body.stream) { counts.messages++; await sleep(${delay}); counts.completed++; return Response.json({ id: 'msg_fixture', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: 'hello' }], stop_reason: 'end_turn', usage: { input_tokens: 12, output_tokens: 4 } }, { headers }); }
 counts.streams++; let canceled = false;
 const encoder = new TextEncoder();
 const stream = new ReadableStream({ async start(controller) {
  const send = (event, data) => { if (!canceled) controller.enqueue(encoder.encode('event: '+event+'\\ndata: '+JSON.stringify(data)+'\\n\\n')); };
  try {
   send('message_start', { type: 'message_start', message: { id: 'msg_fixture', type: 'message', usage: { input_tokens: 12, output_tokens: 0 } } });
   await sleep(${delay}); send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } });
   await sleep(40); send('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } });
   send('message_stop', { type: 'message_stop' }); if (!canceled) { counts.completed++; controller.close(); }
  } catch { /* canceled transport */ }
 }, cancel() { canceled = true; counts.canceled++; } });
 return new Response(stream, { headers: { ...headers, 'content-type': 'text/event-stream' } });
}};`;
  mf = await startWorkerdFixture(temporary, router, upstream, { queueConsumer: { maxBatchSize: 50, maxBatchTimeout: 5 } });
  const baseUrl = String(await mf.ready).replace(/\/$/, '');
  const bindings = await mf.getBindings('router');
  const authority = bindings.ACCESS_CONTROL.get(bindings.ACCESS_CONTROL.idFromName('policy-bindings'));
  const init = async (path, body) => { const response = await authority.fetch(`https://fixture${path}`, { method: 'POST', body: JSON.stringify(body) }); assert.ok(response.ok, path); };
  await init('/policies/initialize-all', [{ policyId: 'load', policy: { enabled: true, generation: 'load-v1', providers: ['anthropic'], models: ['anthropic/claude-sonnet-5'], tenantId: 'synthetic', tokenRole: 'service', monthlyBudgetMicros: 1000000000, requestCostMicros: 1, retainRequestContent: false, poolStatus: 'visible', grantRouting: { strategy: 'most_remaining', stickiness: 'session', failover: true, environmentFallback: true, includedQuotaReservePercent: 10, staleState: 'allow', staleAfterSeconds: 300, eligibleGrants: {} } } }]);
  await init('/credentials/initialize-all', [{ credentialId: 'load', credential: { enabled: true, secretSha256: sha(secret), policyId: 'load', policyGeneration: 'load-v1' } }]);
  await init('/connections/initialize-all', [{ providerId: 'anthropic', enabled: true }]);
  const adminHeaders = { authorization: `Bearer ${admin}`, 'content-type': 'application/json' };
  for (let index = 0; index < 7; index++) {
    const response = await fetch(`${baseUrl}/v1/admin/upstream-grants/policies/load/grant-${index}`, { method: 'PUT', headers: adminHeaders, body: JSON.stringify({ provider: 'anthropic', kind: 'subscription', accessToken: `synthetic-grant-${index}`, maintenance: { keepWarm: false } }) });
    assert.equal(response.status, 200, `grant setup failed: ${await response.text()}`);
  }
  const headers = { authorization: `Bearer ${key}` };
  const json = async path => { const response = await fetch(`${baseUrl}${path}`, { headers }); assert.ok(response.ok, `${path}: ${response.status}`); return response.json(); };
  const usageCount = async () => (await json('/v1/usage')).usage.summary.requestCount;
  const selectedCount = async () => (await json('/v1/pool')).grants.reduce((sum, grant) => sum + grant.selectedCount, 0);
  const output = { label: values.label, environment: { node: process.version, platform: platform(), arch: arch(), cpus: cpus().length }, delayMs: delay, maxTokens: Number(values['max-tokens']), cells: [] };
  for (const scenario of scenarios) for (const clients of concurrency) {
    const options = parseOptions(['--base-url', baseUrl, '--key-file', keyFile, '--scenario', scenario === 'abort' ? 'stream' : scenario, '--requests', String(requests), '--concurrency', String(clients), '--session-spread', '70', '--abort-fraction', scenario === 'abort' ? '0.5' : '0', '--timeout-ms', '30000', '--max-tokens', values['max-tokens']]);
    // Warm canonical reads and isolate each cell's bookkeeping deltas.
    const beforeWarm = await usageCount();
    await runLoad({ ...options, requests: 7, concurrency: 1, abortFraction: 0 });
    const warmDeadline = performance.now() + 60000;
    if (!['catalog', 'pool'].includes(scenario)) {
      while (await usageCount() < beforeWarm + 7 && performance.now() < warmDeadline) await sleep(250);
      assert.equal(await usageCount(), beforeWarm + 7, 'warmup usage drained');
    }
    const expectedBefore = await selectedCount(), usageBefore = await usageCount(), upstreamBefore = await json('/__load/stats');
    const authorityBefore = await json('/__load/authority');
    const sampleStart = memory.length;
    sampleProcesses(); const sampler = setInterval(sampleProcesses, 1000);
    let report;
    try { report = await runLoad(options); } finally { clearInterval(sampler); sampleProcesses(); }
    // Requests reset before ingress have no accounting obligation. Compare with
    // observed synthetic egress, and retain transport failures in the load report.
    const deliveredUpstream = await json('/__load/stats');
    const authorityAfter = await json('/__load/authority');
    const deliveryDone = performance.now(), expectedUsage = deliveredUpstream.requests - upstreamBefore.requests;
    let usageAfter = await usageCount();
    const initialBacklog = usageBefore + expectedUsage - usageAfter;
    while (usageAfter < usageBefore + expectedUsage && performance.now() - deliveryDone < 60000) { await sleep(250); usageAfter = await usageCount(); }
    const drainMs = performance.now() - deliveryDone, selectedAfter = await selectedCount(), upstreamAfter = await json('/__load/stats');
    const usageSnapshot = await json('/v1/usage'), poolSnapshot = await json('/v1/pool');
    const requestIds = new Set(report.requests.map(row => row.requestId));
    const observedSessions = new Map();
    const events = usageSnapshot.usage.events.filter(event => requestIds.has(event.request_id));
    for (const event of events) {
      const grants = observedSessions.get(event.session_id) ?? new Set();
      grants.add(event.grant_key); observedSessions.set(event.session_id, grants);
    }
    const samples = memory.slice(sampleStart);
    const cell = { scenario, concurrency: clients, ...report.summary,
      authorityRpc: Object.fromEntries(Object.entries(authorityAfter).map(([path, count]) => [path, count - (authorityBefore[path] ?? 0)]).filter(([, count]) => count)),
      routerAddedP50Ms: ['catalog','pool','abort'].includes(scenario) ? null : report.summary.ttfbMs.p50 - delay,
      bookkeeping: { expected: expectedUsage, selected: selectedAfter - expectedBefore, usage: usageAfter - usageBefore, initialBacklog, drainMs, upstream: Object.fromEntries(Object.keys(upstreamAfter).map(key => [key, upstreamAfter[key] - upstreamBefore[key]])),
        recentEventsChecked: events.length, recentEventStatuses: events.reduce((counts, event) => { counts[event.status] = (counts[event.status] ?? 0) + 1; return counts; }, {}),
        recentTokenTotals: events.reduce((totals, event) => ({ input: totals.input + (event.input_tokens ?? 0), output: totals.output + (event.output_tokens ?? 0) }), { input: 0, output: 0 }),
        sessionsChecked: observedSessions.size, sessionsWithMultipleGrants: [...observedSessions.values()].filter(grants => grants.size > 1).length,
        quotaUpdatedGrants: poolSnapshot.grants.filter(grant => grant.windows.length > 0).length },
      workerd: { peakRssMiB: Math.max(...samples.map(row => row.rssMiB)), peakCpuPercent: Math.max(...samples.map(row => row.cpuPercent)) },
    };
    output.cells.push(cell);
    console.log(JSON.stringify(cell));
    // Export after every cell so partial diagnostics survive a later failure.
    if (values.out) await writeFile(values.out, `${JSON.stringify(output, null, 2)}\n`, { mode: 0o600 });
  }
  assert.ok(output.cells.every(cell => cell.bookkeeping.selected === cell.bookkeeping.upstream.requests && cell.bookkeeping.usage === cell.bookkeeping.upstream.requests), 'inspect report: bookkeeping mismatch');
  if (output.cells.some(cell => cell.errors > 0)) process.exitCode = 1;
} finally { await mf?.dispose(); await rm(temporary, { recursive: true, force: true }); }
