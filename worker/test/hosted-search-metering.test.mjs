import './typescript-setup.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { proxyKey, sse, usageEnv } from './usage-budget-fixture.mjs';
import { sqlBudgetNamespace } from './sql-budget-namespace.mjs';
import { continuationAuthority } from './continuation-authority.mjs';
const { default: handler } = await import('../index.ts');
const { budgetStatus, providerBudgetStatus, queue } = await import('../ledgers.ts');

const usage = { input_tokens: 100, output_tokens: 10, total_tokens: 110 };
const search = (id = 'ws_fixture', action = 'search', status = 'completed') => ({ type: 'web_search_call', id, status, ...(action === null ? {} : { action: { type: action, queries: ['synthetic private query'], results: 'synthetic private result' } }) });
const terminal = (output, extra = {}) => ({ object: 'response', id: 'resp_fixture', status: 'completed', service_tier: 'default', output, usage, ...extra });
const frame = value => ({ type: 'response.completed', response: value });
const added = item => ({ type: 'response.output_item.added', output_index: 0, item });
const done = item => ({ type: 'response.output_item.done', output_index: 0, item });
const streamed = output => sse({ type: 'response.created', response: { id: 'resp_fixture', status: 'in_progress' } }, added(search('ws_fixture', null, 'in_progress')), done(output[0]), done(output[0]), frame(terminal(output)), '[DONE]');

function setup(t, { mode = 'soft', limit = 1_000_000, fixedCost = null, tool = 'web_search', model = 'openai/gpt-4.1-mini' } = {}) {
  const env = usageEnv([], { limit, providerLimit: limit, fixedCost, retainContent: false });
  env.OPENAI_API_KEY = 'fixture-openai-key';
  const authority = env.ACCESS_CONTROL.get(), continuation = continuationAuthority(t, env);
  env.ACCESS_CONTROL.get = name => name.startsWith('http-continuations:') ? continuation.get(name) : ({ fetch: async (...args) => {
    const value = await (await authority.fetch(...args)).json();
    if (value.policy) value.policy.policy.budgetMode = mode;
    return Response.json(value);
  } });
  const ledger = sqlBudgetNamespace(t), calls = [], events = [], pending = [];
  env.BUDGET_LEDGER = { ...ledger, get: name => ({ fetch: (url, init) => { calls.push({ path: new URL(url).pathname, name, body: init?.body && JSON.parse(init.body) }); return ledger.get(name).fetch(url, init); } }) };
  env.USAGE_QUEUE = { send: async event => events.push(event) };
  env.CONTENT_ARCHIVE = { put: async () => assert.fail('content retention is forbidden for this fixture') };
  return { env, ledger, calls, events, pending,
    request: (extra = {}, signal, headers = {}) => handler.fetch(new Request('https://clawrouter.example/v1/responses', { method: 'POST', signal, headers: { authorization: `Bearer ${proxyKey()}`, 'content-type': 'application/json', 'x-request-id': 'fixture-search-metering', ...headers }, body: JSON.stringify({ model, input: 'synthetic private input', tools: [{ type: tool }], max_output_tokens: 32, ...extra }) }), env, { waitUntil: p => pending.push(p) }),
    drain: () => Promise.all(pending),
  };
}
function upstream(t, body, stream = false, status = 200) {
  return t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(new URL(url).origin, 'https://api.openai.com');
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer fixture-openai-key');
    assert.equal(JSON.parse(init.body).model.startsWith('openai/'), false);
    const bytes = new TextEncoder().encode(body); let offset = 0;
    return new Response(new ReadableStream({ pull(c) { if (offset < bytes.length) { c.enqueue(bytes.slice(offset, offset + 7)); offset += 7; } else c.close(); } }, { highWaterMark: 0 }), { status, headers: { 'content-type': stream ? 'text/event-stream' : 'application/json' } });
  });
}
async function spent(f) {
  return (await budgetStatus(f.env, 'maintainer_access', { tenantId: 'tenant', budgetScope: 'principal', monthlyBudgetMicros: 1_000_000 }, 'owner@example.com')).spentMicros;
}
function assertAudit(event, count, complete, cost) {
  assert.deepEqual(event.hosted_tool_calls, { web_search: count });
  assert.equal(event.hosted_tool_calls_complete, complete);
  assert.equal(event.actual_cost_micros, cost);
  assert.equal(event.cost_basis, 'unpriced_usage');
  assert.equal(event.request_id, 'fixture-search-metering');
  assert.equal(event.auth_type, 'proxy_key');
  assert.equal(event.credential_id, 'maintainer_key');
  assert.equal(event.principal_id, 'owner@example.com');
  assert.equal(event.content_retained, false);
  assert.equal(event.content_ref, null);
  assert.doesNotMatch(JSON.stringify(event), /synthetic private|fixture-openai-key/);
}

for (const stream of [false, true]) test(`hosted search ${stream ? 'fragmented SSE' : 'JSON'} charges one call via production SQL, never a second billing sink`, async t => {
  const f = setup(t), body = stream ? streamed([search()]) : JSON.stringify(terminal([search()]));
  const mock = upstream(t, body, stream);
  const response = await f.request({ stream }); assert.equal(response.status, 200);
  assert.equal(await response.text(), body); await f.drain();
  assert.equal(mock.mock.callCount(), 1); assert.equal(f.events.length, 1);
  assertAudit(f.events[0], 1, true, 10_056);
  assert.equal(f.events[0].hosted_tool_cost_micros, 10_000);
  assert.equal(f.events[0].hosted_tool_pricing_ref, 'openai-web-search-2026-10-20');
  assert.equal(await spent(f), 10_056);
  assert.equal((await providerBudgetStatus(f.env, 'openai', 1_000_000)).spentMicros, 10_056);
  assert.equal(f.calls.filter(c => c.path === '/charge').length, 2);
  assert.ok(!f.calls.some(c => ['/reserve', '/settle', '/dispatch'].includes(c.path)));
  // Replay the actual charge message: existing SQL chargeId owner is idempotent.
  const charge = f.calls.find(c => c.path === '/charge');
  for (let n = 0; n < 2; n++) await queue({ messages: [{ body: { kind: 'budget_charge', ledger: { objectName: charge.name }, request: charge.body }, ack() {}, retry() { assert.fail('replay must succeed'); } }] }, f.env);
  assert.equal(await spent(f), 10_056);
});

for (const withReasoning of [false, true]) test('realistic mixed-item SSE search + message' + (withReasoning ? ' + reasoning summary' : '') + ' retains one component through production SQL', async t => {
  const f = setup(t, { model: 'openai/gpt-5.4' });
  // Responses streaming-event schema: content selectors belong to the message;
  // reasoning-summary selectors belong to a separate reasoning output item.
  // https://developers.openai.com/api/reference/resources/responses/streaming-events
  const summary = { type: 'summary_text', text: 'synthetic private summary' };
  const reasoning = { type: 'reasoning', id: 'rs_fixture', summary: [summary] };
  const item = { type: 'web_search_call', id: 'ws_fixture', status: 'completed', action: { type: 'search', query: 'synthetic private query' } };
  const annotation = { type: 'url_citation', start_index: 0, end_index: 23, title: 'synthetic private source', url: 'https://example.com/fixture' };
  const part = { type: 'output_text', text: 'synthetic private answer', annotations: [annotation], logprobs: [] };
  const message = { type: 'message', id: 'msg_fixture', status: 'completed', role: 'assistant', content: [part] };
  const output = [...(withReasoning ? [reasoning] : []), item, message], searchIndex = withReasoning ? 1 : 0, messageIndex = searchIndex + 1;
  const final = terminal(output, { model: 'gpt-5.4', reasoning: { effort: 'high', summary: 'auto' } });
  const events = [{ type: 'response.created', response: { ...final, status: 'in_progress', output: [], usage: null } }];
  if (withReasoning) events.push(
    { type: 'response.output_item.added', output_index: 0, item: { ...reasoning, summary: [] } },
    { type: 'response.reasoning_summary_part.added', output_index: 0, item_id: reasoning.id, summary_index: 0, part: { type: 'summary_text', text: '' } },
    { type: 'response.reasoning_summary_text.delta', output_index: 0, item_id: reasoning.id, summary_index: 0, delta: summary.text },
    { type: 'response.reasoning_summary_text.done', output_index: 0, item_id: reasoning.id, summary_index: 0, text: summary.text },
    { type: 'response.reasoning_summary_part.done', output_index: 0, item_id: reasoning.id, summary_index: 0, part: summary },
    { type: 'response.output_item.done', output_index: 0, item: reasoning });
  events.push(
    { type: 'response.output_item.added', output_index: searchIndex, item: { ...item, status: 'in_progress' } },
    ...['in_progress', 'searching', 'completed'].map(status => ({ type: 'response.web_search_call.' + status, output_index: searchIndex, item_id: item.id })),
    { type: 'response.output_item.done', output_index: searchIndex, item },
    { type: 'response.output_item.added', output_index: messageIndex, item: { ...message, status: 'in_progress', content: [] } },
    { type: 'response.content_part.added', output_index: messageIndex, item_id: message.id, content_index: 0, part: { ...part, text: '', annotations: [] } },
    { type: 'response.output_text.delta', output_index: messageIndex, item_id: message.id, content_index: 0, delta: part.text, logprobs: [] },
    { type: 'response.output_text.annotation.added', output_index: messageIndex, item_id: message.id, content_index: 0, annotation_index: 0, annotation },
    { type: 'response.output_text.done', output_index: messageIndex, item_id: message.id, content_index: 0, text: part.text, logprobs: [] },
    { type: 'response.content_part.done', output_index: messageIndex, item_id: message.id, content_index: 0, part },
    { type: 'response.output_item.done', output_index: messageIndex, item: message }, frame(final));
  const body = sse(...events.map((event, sequence_number) => ({ ...event, sequence_number })));
  const mock = upstream(t, body, true), r = await f.request({ stream: true, reasoning: { effort: 'high', summary: 'auto' } });
  assert.equal(r.status, 200); assert.equal(await r.text(), body); await f.drain();
  assert.equal(mock.mock.callCount(), 1); assert.equal(f.events.length, 1);
  assertAudit(f.events[0], 1, true, 10_400); assert.equal(f.events[0].status, 'success');
  assert.equal(f.events[0].hosted_tool_cost_micros, 10_000);
  assert.equal(f.events[0].hosted_tool_pricing_ref, 'openai-web-search-2026-10-20');
  assert.equal(await spent(f), 10_400); assert.equal((await providerBudgetStatus(f.env, 'openai', 1_000_000)).spentMicros, 10_400);
  const charges = f.calls.filter(c => c.path === '/charge');
  assert.deepEqual(charges.map(c => ({ name: c.name, amount: c.body.amountMicros })).sort((a, b) => a.name.localeCompare(b.name)), [
    { name: 'provider:openai', amount: 10_400 }, { name: 'tenant:maintainer_access:owner@example.com', amount: 10_400 },
  ]);
  // The existing owner allocates one replay-stable ID per budget leg.
  assert.equal(new Set(charges.map(c => c.body.chargeId)).size, 2);
  for (const charge of charges) assert.deepEqual(f.ledger.get(charge.name).reservations().map(row => ({ id: row.reservation_id, amount: row.reserved_micros })), [{ id: charge.body.chargeId, amount: 10_400 }]);
  assert.ok(!f.calls.some(c => ['/reserve', '/settle', '/dispatch'].includes(c.path)));
});

for (const [action, count] of [['search', 1], [null, 1], ['future_action', 1], ['open_page', 0], ['find_in_page', 0]]) test(`final action ${action} is counted conservatively without retaining its content`, async t => {
  const f = setup(t); upstream(t, JSON.stringify(terminal([search('ws_fixture', action)])));
  const r = await f.request(); await r.text(); await f.drain();
  assertAudit(f.events[0], count, true, count * 10_000 + 56);
});

for (const [tool, model, fee] of [['web_search_preview', 'openai/gpt-4.1-mini', 25_000], ['web_search_preview_2025_03_11', 'openai/gpt-5.4', 10_000], ['web_search_preview', 'openai/future-model', 0]]) test(`versioned fee selection ${tool} / ${model} does not infer unknown preview model classes`, async t => {
  const f = setup(t, { tool, model }); upstream(t, JSON.stringify(terminal([search()])));
  const r = await f.request(); assert.equal(r.status, 200); await r.text(); await f.drain();
  assert.equal(f.events[0].hosted_tool_cost_micros, fee || null);
  assert.equal(f.events[0].actual_cost_micros, fee + (model.endsWith('4.1-mini') ? 56 : model.endsWith('5.4') ? 400 : 0));
  assert.equal(f.events[0].cost_basis, 'unpriced_usage');
});

for (const [name, options, cost] of [['unmetered', { mode: 'reserve', limit: null }, 0], ['soft without caps', { limit: null }, 56], ['fixed', { fixedCost: 123 }, 123]]) test(`${name} records counts without changing its established tariff`, async t => {
  const f = setup(t, options); upstream(t, JSON.stringify(terminal([search()])));
  const r = await f.request(); await r.text(); await f.drain();
  assert.deepEqual(f.events[0].hosted_tool_calls, { web_search: 1 });
  assert.equal(f.events[0].actual_cost_micros, cost);
  assert.equal(f.events[0].cost_basis, name === 'fixed' ? 'policy_fixed' : 'unpriced_usage');
});

test('#282 catalog admission composes with one hosted fee and two durable charge legs', async t => {
  for (const mode of ['reserve', 'soft']) {
    const f = setup(t, { mode, model: 'openai/gpt-6.1-sol' });
    const catalog = await handler.fetch(new Request('https://clawrouter.example/v1/catalog', { headers: { authorization: 'Bearer ' + proxyKey() } }), f.env, { waitUntil: p => f.pending.push(p) });
    assert.equal(catalog.status, 200);
    const provider = (await catalog.json()).providers.find(p => p.id === 'openai');
    const offer = provider.offers.find(o => o.modelId === 'openai/gpt-6.1-sol' && o.endpoint === 'responses' && o.transport === 'http' && o.route === '/v1/responses');
    assert.deepEqual(offer.hostedToolAdmission, { version: 'clawrouter.hosted-tool-admission.v1', web_search: mode === 'reserve' ? 'pricing_required' : 'admitted' });
    const mock = upstream(t, JSON.stringify(terminal([search()], { usage: { ...usage, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } } })));
    const r = await f.request(); assert.equal(r.status, mode === 'reserve' ? 400 : 200);
    if (mode === 'reserve') assert.equal((await r.json()).error.code, 'pricing_required');
    else await r.text();
    await f.drain();
    assert.equal(mock.mock.callCount(), mode === 'reserve' ? 0 : 1); assert.equal(f.events.length, 1);
    const charges = f.calls.filter(c => c.path === '/charge');
    assert.equal(charges.length, mode === 'reserve' ? 0 : 2);
    assert.ok(!f.calls.some(c => ['/reserve', '/settle', '/dispatch'].includes(c.path)));
    if (mode === 'soft') {
      assertAudit(f.events[0], 1, true, 10_300); assert.equal(f.events[0].hosted_tool_cost_micros, 10_000);
      assert.deepEqual(charges.map(c => ({ name: c.name, amount: c.body.amountMicros })).sort((a, b) => a.name.localeCompare(b.name)), [
        { name: 'provider:openai', amount: 10_300 }, { name: 'tenant:maintainer_access:owner@example.com', amount: 10_300 },
      ]);
      for (const charge of charges) {
        assert.deepEqual(f.ledger.get(charge.name).reservations().map(row => ({ id: row.reservation_id, amount: row.reserved_micros })), [{ id: charge.body.chargeId, amount: 10_300 }]);
        await queue({ messages: [{ body: { kind: 'budget_charge', ledger: { objectName: charge.name }, request: charge.body }, ack() {}, retry() { assert.fail('charge replay must succeed'); } }] }, f.env);
      }
    } else assert.equal(f.events[0].actual_cost_micros, 0);
    assert.equal(await spent(f), mode === 'reserve' ? 0 : 10_300);
    assert.equal((await providerBudgetStatus(f.env, 'openai', 1_000_000)).spentMicros, mode === 'reserve' ? 0 : 10_300);
    mock.mock.restore();
  }
});

test('reserve budgets retain pricing_required and zero upstream egress', async t => {
  const f = setup(t, { mode: 'reserve' }), mock = upstream(t, '{}');
  const r = await f.request(); assert.equal(r.status, 400); assert.equal((await r.json()).error.code, 'pricing_required');
  await f.drain(); assert.equal(mock.mock.callCount(), 0);
  assert.equal(await spent(f), 0); assert.equal(f.events[0].actual_cost_micros, 0);
});

for (const [name, body, expectedCount, complete, tokens, status] of [
  ['no terminal', sse(done(search())), 1, false, false, 'provider_error'],
  ['missing usage', sse(done(search()), frame(terminal([search()], { usage: null }))), 1, true, false, 'success'],
  ['oversized selected item', sse(done(search()), frame(terminal([search('x'.repeat(300))]))), 1, false, true, 'success'],
  ['failed response', sse(done(search()), { type: 'response.failed', response: terminal([search()], { status: 'failed' }) }), 1, false, true, 'provider_error'],
  ['failed search item', sse(frame(terminal([search('ws_fixture', 'search', 'failed')]))), 1, true, true, 'success'],
  ['many queries one item', sse(frame(terminal([{ ...search(), action: { type: 'search', queries: ['one', 'two', 'three'] } }]))), 1, true, true, 'success'],
  ['duplicate terminal id', sse(frame(terminal([search(), search()]))), 1, false, true, 'success'],
]) test(`${name} reports observed evidence without inventing a complete bill`, async t => {
  const f = setup(t); upstream(t, body, true);
  const r = await f.request({ stream: true }); await r.text(); await f.drain();
  assertAudit(f.events[0], expectedCount, complete, (tokens ? 56 : 0) + (tokens && complete ? 10_000 : 0));
  assert.equal(f.events[0].status, status);
});

test('consumer cancellation preserves partial counts, aborts upstream, and charges no invented tool fee', async t => {
  const f = setup(t); let canceled = false, pulls = 0;
  const prefix = sse({ type: 'response.created', response: { id: 'resp_fixture' } }, done(search()));
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({ pull(c) { pulls++; if (pulls === 1) c.enqueue(new TextEncoder().encode(prefix)); else return new Promise(() => {}); }, cancel() { canceled = true; } }, { highWaterMark: 0 }), { headers: { 'content-type': 'text/event-stream' } }));
  const r = await f.request({ stream: true }); const reader = r.body.getReader(); await reader.read(); await reader.cancel('synthetic cancellation');
  await f.drain(); assert.equal(canceled, true); assertAudit(f.events[0], 1, false, 0);
});


for (const [name, value, count, complete] of [
  ['missing terminal identity', terminal([search()], { id: undefined }), 1, false],
  ['missing terminal output', terminal(undefined), 0, false],
  ['multiple distinct items', terminal([search('one'), search('two')]), 2, true],
]) test(name + ' never becomes a stronger price claim than the selected evidence', async t => {
  const f = setup(t); upstream(t, JSON.stringify(value));
  const r = await f.request(); await r.text(); await f.drain();
  if (count) assertAudit(f.events[0], count, complete, 56 + (complete ? count * 10_000 : 0));
  else { assert.equal(f.events[0].actual_cost_micros, 56); assert.equal(f.events[0].hosted_tool_calls, undefined); assert.equal(f.events[0].cost_basis, 'unpriced_usage'); }
});

test('mixed preview and non-preview tariffs retain counts without guessing a unit price', async t => {
  const f = setup(t); upstream(t, JSON.stringify(terminal([search()])));
  const r = await f.request({ tools: [{ type: 'web_search' }, { type: 'web_search_preview' }] }); await r.text(); await f.drain();
  assertAudit(f.events[0], 1, true, 56); assert.equal(f.events[0].hosted_tool_cost_micros, null);
});

for (const [name, extra] of [['saved prompt', { prompt: { id: 'pmpt_fixture' } }], ['conversation', { conversation: 'conv_fixture' }], ['multi-agent', { multi_agent: { enabled: true } }]]) test(name + ' cannot qualify a visible search tariff over opaque inventory', async t => {
  const f = setup(t); upstream(t, JSON.stringify(terminal([search()])));
  const r = await f.request(extra); assert.equal(r.status, 200); await r.text(); await f.drain();
  assertAudit(f.events[0], 1, true, 56); assert.equal(f.events[0].hosted_tool_cost_micros, null); assert.equal(await spent(f), 56);
});

for (const carrier of ['previous_response_id', 'x-codex-turn-state']) test(carrier + ' preserves owner binding without inventing the inherited search tariff', async t => {
  const f = setup(t); let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(new URL(url).origin, 'https://api.openai.com'); assert.equal(new Headers(init.headers).get('authorization'), 'Bearer fixture-openai-key');
    calls++; const first = calls === 1;
    return Response.json(terminal(first ? [{ type: 'message', id: 'msg_parent', role: 'assistant', content: [] }] : [search()], { id: first ? 'resp_parent' : 'resp_child' }), { headers: { 'x-codex-turn-state': first ? 'turn_parent' : 'turn_child' } });
  });
  const parent = await f.request({ input: [{ type: 'additional_tools', role: 'developer', tools: [{ type: 'web_search_preview' }] }, { role: 'user', content: 'synthetic private input' }] }); assert.equal(parent.status, 200); await parent.text(); await f.drain();
  const child = await f.request(carrier === 'previous_response_id' ? { previous_response_id: 'resp_parent' } : {}, undefined, carrier === 'x-codex-turn-state' ? { [carrier]: 'turn_parent' } : {});
  assert.equal(child.status, 200); await child.text(); await f.drain(); assert.equal(calls, 2);
  assertAudit(f.events[1], 1, true, 56); assert.equal(f.events[1].hosted_tool_cost_micros, null); assert.equal(await spent(f), 112);
});

for (const anonymousSearch of [false, true]) test('complete terminal resolves done-only anonymous ' + (anonymousSearch ? 'search' : 'message') + ' without duplicate fees', async t => {
  const f = setup(t), anonymous = anonymousSearch ? { ...search(), id: undefined } : { type: 'message' };
  const body = sse({ type: 'response.output_item.done', item: anonymous }, { type: 'response.output_item.done', item: anonymous }, frame(terminal([search()])));
  upstream(t, body, true); const r = await f.request({ stream: true }); assert.equal(await r.text(), body); await f.drain();
  assertAudit(f.events[0], 1, true, 10_056); assert.equal(await spent(f), 10_056);
});

for (const [tool, fee] of [[{ type: 'tool_search' }, null], [{ type: 'mcp' }, null], [{ type: 'programmatic_tool_calling' }, null], [{ type: 'tool_search', execution: 'client' }, 10_000]]) test('dynamic inventory ' + JSON.stringify(tool) + ' qualifies only a fully current client declaration', async t => {
  const f = setup(t); upstream(t, JSON.stringify(terminal([search()])));
  const r = await f.request({ tools: [{ type: 'web_search' }, tool] }); await r.text(); await f.drain();
  assertAudit(f.events[0], 1, true, 56 + (fee ?? 0)); assert.equal(f.events[0].hosted_tool_cost_micros, fee);
});

test('anonymous search without a corroborating terminal cannot assert a complete zero count', async t => {
  const f = setup(t), body = sse({ type: 'response.output_item.done', item: { ...search(), id: undefined } }, frame(terminal([])));
  upstream(t, body, true); const r = await f.request({ stream: true }); await r.text(); await f.drain();
  assertAudit(f.events[0], 0, false, 56); assert.equal(f.events[0].hosted_tool_cost_micros, null);
});

for (const bridge of [false, true]) for (const [name, firstAction, secondAction, finalAction] of [
  ['ID-only search masked by indexed open_page', 'search', 'open_page', 'open_page'],
  ['indexed search masks ID-only open_page', 'open_page', 'search', 'search'],
]) test(name + (bridge ? ' with a bridging done event' : '') + ' cannot qualify contradictory identity evidence', async t => {
  const f = setup(t), indexed = { ...search('ws_fixture', secondAction), id: undefined };
  const body = sse({ type: 'response.output_item.done', item: search('ws_fixture', firstAction) },
    { type: 'response.output_item.done', output_index: 0, item: indexed }, ...(bridge ? [done(search('ws_fixture', finalAction))] : []), frame(terminal([search('ws_fixture', finalAction)])));
  upstream(t, body, true); const r = await f.request({ stream: true }); assert.equal(await r.text(), body); await f.drain();
  assertAudit(f.events[0], 1, false, 56); assert.equal(f.events[0].hosted_tool_cost_micros, null);
  assert.equal(await spent(f), 56); assert.equal((await providerBudgetStatus(f.env, 'openai', 1_000_000)).spentMicros, 56);
});

for (const [name, later] of [
  ['conflicting same-ID done action', done(search('ws_fixture', 'open_page'))],
  ['conflicting repeated terminal output', frame(terminal([search('ws_fixture', 'open_page')]))],
  ['conflicting repeated terminal status', { type: 'response.failed', response: terminal([search()], { status: 'failed' }) }],
  ['post-terminal error payload', { type: 'error', code: 'synthetic_upstream_error', message: 'synthetic failure' }],
  ['new post-terminal item', { type: 'response.output_item.done', output_index: 1, item: search('ws_late') }],
  ['unresolvable anonymous post-terminal search', { type: 'response.output_item.done', item: { ...search(), id: undefined } }],
]) test(name + ' invalidates only call completeness, never mints a fee', async t => {
  const f = setup(t), body = sse(done(search()), frame(terminal([search()])), later, '[DONE]');
  upstream(t, body, true); const r = await f.request({ stream: true }); assert.equal(await r.text(), body); await f.drain();
  assertAudit(f.events[0], 1, false, 56); assert.equal(f.events[0].hosted_tool_cost_micros, null);
  assert.equal(await spent(f), 56); assert.equal((await providerBudgetStatus(f.env, 'openai', 1_000_000)).spentMicros, 56);
});

test('exact named post-terminal repeats retain one qualified component and idempotent charge owner', async t => {
  const f = setup(t), body = sse(done(search()), frame(terminal([search()])), done(search()), frame(terminal([search()])), '[DONE]');
  upstream(t, body, true); const r = await f.request({ stream: true }); assert.equal(await r.text(), body); await f.drain();
  assertAudit(f.events[0], 1, true, 10_056); assert.equal(f.events[0].hosted_tool_cost_micros, 10_000);
  assert.equal(await spent(f), 10_056); assert.equal(f.calls.filter(c => c.path === '/charge').length, 2);
});

for (const phase of ['before', 'after']) for (const [name, selectors] of [
  ['unknown index', { output_index: 1 }],
  ['unknown ID', { item_id: 'ws_late' }],
  ['conflicting selectors', { output_index: 0, item_id: 'ws_second' }],
]) test(phase + '-terminal status selector ' + name + ' cannot qualify an incomplete enumeration', async t => {
  const f = setup(t), event = { type: 'response.web_search_call.completed', ...selectors };
  const final = frame(terminal([search(), search('ws_second', 'open_page')]));
  // Index 1 exists only for the conflicting-ID case; unknown index is outside output.
  if (name === 'unknown index') event.output_index = 2;
  const body = sse(done(search()), ...(phase === 'before' ? [event, final] : [final, event]), '[DONE]');
  upstream(t, body, true); const r = await f.request({ stream: true }); assert.equal(await r.text(), body); await f.drain();
  assertAudit(f.events[0], 1, false, 56); assert.equal(f.events[0].hosted_tool_cost_micros, null);
  assert.equal(await spent(f), 56); assert.equal((await providerBudgetStatus(f.env, 'openai', 1_000_000)).spentMicros, 56);
});

for (const phase of ['before', 'after']) for (const selectors of [{ output_index: 0 }, { item_id: 'ws_fixture' }, { output_index: 0, item_id: 'ws_fixture' }]) test(phase + '-terminal matching status selectors ' + JSON.stringify(selectors) + ' retain one component', async t => {
  const f = setup(t), event = { type: 'response.web_search_call.completed', ...selectors }, final = frame(terminal([search()]));
  const body = sse(done(search()), ...(phase === 'before' ? [event, final] : [final, event]), '[DONE]');
  upstream(t, body, true); const r = await f.request({ stream: true }); assert.equal(await r.text(), body); await f.drain();
  assertAudit(f.events[0], 1, true, 10_056); assert.equal(f.events[0].hosted_tool_cost_micros, 10_000);
  assert.equal(await spent(f), 10_056); assert.equal(f.calls.filter(c => c.path === '/charge').length, 2);
});

for (const bridge of [false, true]) for (const action of ['search', 'open_page']) test('compatible ID-only and index-only ' + action + ' observations reconcile at ' + (bridge ? 'bridging done event' : 'terminal'), async t => {
  const f = setup(t), item = search('ws_fixture', action), count = action === 'search' ? 1 : 0;
  const body = sse({ type: 'response.output_item.done', item }, { type: 'response.output_item.done', output_index: 0, item: { ...item, id: undefined } },
    ...(bridge ? [done(item)] : []), frame(terminal([item])));
  upstream(t, body, true); const r = await f.request({ stream: true }); assert.equal(await r.text(), body); await f.drain();
  assertAudit(f.events[0], count, true, count * 10_000 + 56); assert.equal(f.events[0].hosted_tool_cost_micros, count * 10_000);
  assert.equal(await spent(f), count * 10_000 + 56); assert.equal((await providerBudgetStatus(f.env, 'openai', 1_000_000)).spentMicros, count * 10_000 + 56);
});

test('large ignored search content does not invalidate the bounded action count or enter accounting', async t => {
  const f = setup(t), item = { ...search(), action: { type: 'search', query: 'synthetic private content'.repeat(100_000) } };
  const body = JSON.stringify(terminal([item, { type: 'message', content: [{ type: 'output_text', text: 'synthetic private answer'.repeat(100_000) }] }]));
  t.mock.method(globalThis, 'fetch', async () => new Response(body, { headers: { 'content-type': 'application/json' } }));
  const r = await f.request(); assert.equal(await r.text(), body); await f.drain(); assertAudit(f.events[0], 1, true, 10_056);
});

test('an untrusted credential cannot use soft call metering to dispatch', async t => {
  const f = setup(t), mock = upstream(t, '{}');
  const r = await handler.fetch(new Request('https://clawrouter.example/v1/responses', { method: 'POST', headers: { authorization: 'Bearer synthetic-invalid', 'content-type': 'application/json' }, body: JSON.stringify({ model: 'openai/gpt-4.1-mini', input: 'fixture', tools: [{ type: 'web_search' }] }) }), f.env, { waitUntil: p => f.pending.push(p) });
  assert.equal(r.status, 401); await f.drain(); assert.equal(mock.mock.callCount(), 0); assert.equal(await spent(f), 0);
});

test('upstream authorization rejection stays a rejection, not invented hosted spend', async t => {
  const f = setup(t), mock = upstream(t, JSON.stringify({ error: { message: 'synthetic denied', type: 'authentication_error' } }), false, 401);
  const r = await f.request(); assert.equal(r.status, 401); assert.equal((await r.json()).error.type, 'authentication_error'); await f.drain();
  assert.equal(mock.mock.callCount(), 1); assert.equal(f.events[0].actual_cost_micros, 0); assert.equal(f.events[0].status, 'client_error');
  assert.equal(f.events[0].hosted_tool_calls, undefined); assert.equal(await spent(f), 0);
});

test('compiler preserves the versioned price card and rejects malformed or incompatible cards', t => {
  const root = mkdtempSync(join(tmpdir(), 'clawrouter-search-prices-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const manifest = parse(readFileSync('providers/openai.provider.yaml', 'utf8')), path = join(root, 'provider.json');
  const compile = value => { writeFileSync(path, JSON.stringify(value)); return JSON.parse(execFileSync(process.execPath, ['scripts/compile-providers.mjs', path], { encoding: 'utf8', stdio: 'pipe' })); };
  const price = manifest.endpoints.responses.toolPricing;
  assert.equal(price.version, 'openai-web-search-2026-10-20');
  assert.deepEqual(compile(manifest).providers[0].endpoints.find(e => e.id === 'responses').toolPricing, price);
  for (const mutate of [
    m => { delete m.endpoints.responses.toolPricing.source; },
    m => { m.endpoints.responses.toolPricing.webSearchMicrosPerCall = -1; },
    m => { m.endpoints.responses.toolPricing.previewMicrosPerCallByModel.unknown = 10_000; },
    m => { m.endpoints.chat_completions.toolPricing = m.endpoints.responses.toolPricing; },
  ]) { const invalid = structuredClone(manifest); mutate(invalid); assert.throws(() => compile(invalid), /toolPricing|manifest/); }
});
