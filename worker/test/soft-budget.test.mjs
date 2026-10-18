import './typescript-setup.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { sqlBudgetNamespace } from './sql-budget-namespace.mjs';
import { usageEnv, proxyKey } from './usage-budget-fixture.mjs';
import { fixture, session, policy } from './credential-fixture.mjs';
const { default: handler } = await import('../index.ts');
const { softBudget } = await import('../soft-budget.ts');
const { effectiveBudgetPolicy } = await import('../budget-overrides.ts');
const { budgetStatus, queue } = await import('../ledgers.ts');
const { reserveBudget } = await import('../accounting.ts');
const { normalizePolicy } = await import('../admin.ts');

function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
async function setup(t, options = {}) {
  const env = usageEnv([], { provider: 'local-openai', retainContent: false, ...options });
  env.LOCAL_OPENAI_BASE_URL = 'https://upstream.example.invalid';
  const authority = env.ACCESS_CONTROL.get();
  env.ACCESS_CONTROL.get = () => ({ fetch: async (...args) => {
    const response = await authority.fetch(...args);
    const value = await response.json();
    if (value.policy) value.policy.policy.budgetMode = 'soft';
    return Response.json(value);
  } });
  const ledger = sqlBudgetNamespace(t), calls = [], events = [], pending = [];
  env.BUDGET_LEDGER = { ...ledger, get: name => ({ fetch: (url, init) => { calls.push(new URL(url).pathname); return ledger.get(name).fetch(url, init); } }) };
  env.USAGE_QUEUE = { send: async event => events.push(event) };
  const request = (extra = {}) => handler.fetch(new Request('https://clawrouter.example/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${proxyKey()}`, 'content-type': 'application/json', 'x-request-id': 'fixture-soft-request' }, body: JSON.stringify({ model: 'local/default', messages: [{ role: 'user', content: 'synthetic input' }], ...extra }) }), env, { waitUntil: promise => pending.push(promise) });
  return { env, ledger, calls, events, pending, request, drain: () => Promise.all(pending) };
}

test('soft dispatch precedes concurrent checks, never reserves/dispatches, charges once at EOF and exposes timing', async t => {
  const f = await setup(t, { dailyLimit: 100, weeklyLimit: 100 });
  const bodyGate = deferred();
  t.mock.method(globalThis, 'fetch', async () => {
    assert.deepEqual(f.calls, []);
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{}')); bodyGate.promise.then(() => controller.close()); } }), { headers: { 'content-type': 'application/json' } });
  });
  const response = await f.request();
  assert.equal(response.status, 200);
  assert.match(response.headers.get('server-timing'), /cr-admission;dur=[\d.]+, cr-budget;dur=[\d.]+, cr-upstream-ttfb;dur=[\d.]+/);
  assert.equal(f.calls.filter(call => call === '/status').length, 4);
  assert.ok(!f.calls.includes('/reserve') && !f.calls.includes('/dispatch') && !f.calls.includes('/charge'));
  const consumed = response.text(); bodyGate.resolve(); await consumed; await f.drain();
  assert.equal(f.calls.filter(call => call === '/charge').length, 4);
  const name = 'tenant:maintainer_access:owner@example.com';
  assert.equal(f.ledger.get(name).reservations().length, 3);
  const stored = f.ledger.get(name).reservations()[0];
  const charge = { chargeId: stored.reservation_id, policyId: stored.policy_id, windowKey: stored.window_key, scopeKey: stored.budget_scope_key, amountMicros: 1, capability: 'llm.chat' };
  for (let n = 0; n < 2; n++) assert.equal((await f.ledger.get(name).fetch('https://fixture/charge', { method: 'POST', body: JSON.stringify(charge) })).status, 200);
  assert.equal(f.ledger.get(name).reservations().length, 3);
  assert.equal((await budgetStatus(f.env, 'maintainer_access', { tenantId: 'tenant', budgetScope: 'principal', monthlyBudgetMicros: 100 }, 'owner@example.com')).spentMicros, 1);
  assert.equal((await f.ledger.get(name).fetch('https://fixture/charge', { method: 'POST', body: JSON.stringify({ ...charge, amountMicros: 2 }) })).status, 409);
});

for (const [option, code] of [['dailyLimit', 'daily_budget_exhausted'], ['weeklyLimit', 'weekly_budget_exhausted'], ['limit', 'budget_exhausted'], ['providerLimit', 'provider_budget_exhausted']]) test(`${code} aborts dispatched upstream without exposing headers or charging`, async t => {
  const f = await setup(t, { [option]: 0 }); let aborted = false;
  t.mock.method(globalThis, 'fetch', async (_url, init) => new Promise((_resolve, reject) => { init.signal.addEventListener('abort', () => { aborted = true; reject(init.signal.reason); }); }));
  const response = await f.request();
  assert.equal(response.status, 402); assert.equal((await response.json()).error.code, code); assert.ok(aborted);
  await f.drain(); assert.equal(f.events[0].actual_cost_micros, 0); assert.equal(f.events[0].status, 'denied'); assert.ok(!f.calls.includes('/charge'));
});

test('nonzero spent at limit aborts before upstream headers and includes hint/reset', async t => {
  const auth = { policyId: 'member', principalId: 'one@example.com', policy: { tenantId: 't', budgetScope: 'principal', weeklyBudgetMicros: 10, limitHint: 'Use team.' } };
  const env = { BUDGET_LEDGER: { idFromName: name => name, get: () => ({ fetch: async () => Response.json({ spentMicros: 10 }) }) } };
  let error; const budget = softBudget(env, auth, 'llm.chat', { providerId: 'openai' }, 'request', e => { error = e; });
  await budget.check; assert.equal(error.code, 'weekly_budget_exhausted'); assert.match(error.message, /resets at.*Use team/);
});

test('soft denial preserves the retained-content audit reference without a charge', async t => {
  const f = await setup(t, { dailyLimit: 0, retainContent: true });
  let retained;
  f.env.CONTENT_ARCHIVE = { put: async (_key, value) => { retained = JSON.parse(value); } };
  t.mock.method(globalThis, 'fetch', async (_url, init) => new Promise((_resolve, reject) => { init.signal.addEventListener('abort', () => reject(init.signal.reason)); }));
  assert.equal((await f.request()).status, 402);
  await f.drain();
  assert.equal(f.events[0].content_retained, true);
  assert.equal(f.events[0].content_ref, retained.contentRef);
  assert.equal(f.events[0].actual_cost_micros, 0);
  assert.ok(!f.calls.includes('/charge'));
});

for (const mode of ['failure', 'slow']) test(`ledger ${mode} fails open, with at most the grace wait after headers`, async t => {
  const f = await setup(t); const gate = deferred();
  f.env.BUDGET_LEDGER.get = () => ({ fetch: async url => {
    if (new URL(url).pathname === '/status') { if (mode === 'slow') { await gate.promise; return Response.json({ spentMicros: 99999 }); } throw new Error('synthetic outage'); }
    return new Response('unavailable', { status: 503 });
  } });
  let signal; t.mock.method(globalThis, 'fetch', async (_url, init) => { signal = init.signal; return Response.json({}); });
  const response = await f.request(); assert.equal(response.status, 200);
  if (mode === 'slow') { const wait = Number(response.headers.get('server-timing').match(/cr-budget;dur=([\d.]+)/)[1]); assert.ok(wait >= 40 && wait < 200); }
  await response.text(); gate.resolve(); await f.drain(); assert.equal(signal.aborted, false);
  assert.ok(f.events.some(event => event.kind === 'budget_charge'));
  const job = f.events.find(event => event.kind === 'budget_charge'); let ack = 0, retry = 0;
  await queue({ messages: [{ body: job, ack() { ack++; }, retry() { retry++; } }] }, f.env);
  assert.equal(ack, 0); assert.equal(retry, 1);
  f.env.BUDGET_LEDGER = f.ledger;
  for (let n = 0; n < 2; n++) await queue({ messages: [{ body: job, ack() { ack++; }, retry() { retry++; } }] }, f.env);
  assert.equal(ack, 2); assert.equal(retry, 1);
  assert.equal(f.ledger.get(job.ledger.objectName).reservations().length, 1);
});

test('soft unknown pricing forwards and records unpriced usage without invented charge', async t => {
  const f = await setup(t, { fixedCost: null });
  t.mock.method(globalThis, 'fetch', async () => Response.json({ usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } }));
  const response = await f.request({ web_search_options: {} }); assert.equal(response.status, 200); await response.text(); await f.drain();
  assert.equal(f.events[0].cost_basis, 'unpriced_usage'); assert.equal(f.events[0].actual_cost_micros, 0);
});

test('budget mode defaults and validation preserve existing records', () => {
  const base = { providers: ['openai'] };
  assert.equal(normalizePolicy(base, undefined, false).budgetMode, undefined);
  assert.equal(normalizePolicy({ ...base, budgetMode: 'soft' }, undefined, false).budgetMode, 'soft');
  for (const value of [null, '', 'fast', 1]) assert.throws(() => normalizePolicy({ ...base, budgetMode: value }, undefined, false));
});

test('admin-only overrides are audited, survive profile writes, preserve other policies, and apply without a new read', async t => {
  const env = await fixture(t); env.BUDGET_LEDGER = sqlBudgetNamespace(t);
  const path = `/v1/admin/access-users/${session.email}/budget-overrides/maintainer_access`;
  assert.equal((await env.http(path, 'PUT', { weeklyBudgetMicros: 10 }, { auth: 'user' })).status, 403);
  for (const amount of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1']) assert.equal((await env.http(path, 'PUT', { weeklyBudgetMicros: amount })).status, 400);
  const response = await env.http(path, 'PUT', { dailyBudgetMicros: null, weeklyBudgetMicros: 10 }); assert.equal(response.status, 200);
  const user = await response.json(), override = user.budgetOverrides.maintainer_access;
  assert.equal(override.updatedBy, 'token-admin'); assert.ok(Number.isFinite(Date.parse(override.updatedAt)));
  await env.http(`/v1/admin/access-users/${session.email}`, 'PUT', { enabled: true, tenantId: 'default', groups: ['maintainers'] });
  const saved = (await env.call('/users/resolve', { emails: [session.email] })).users[0];
  assert.deepEqual(saved.record.budgetOverrides.maintainer_access, override);
  const base = { ...policy, dailyBudgetMicros: 5, weeklyBudgetMicros: 100 };
  const effective = effectiveBudgetPolicy('maintainer_access', base, saved.record.budgetOverrides);
  assert.equal(effective.dailyBudgetMicros, null); assert.equal(effective.weeklyBudgetMicros, 10); assert.equal(effective.monthlyBudgetMicros, base.monthlyBudgetMicros);
  assert.equal(effectiveBudgetPolicy('other', base, saved.record.budgetOverrides), base);
  assert.equal(effectiveBudgetPolicy('maintainer_access', { ...base, budgetScope: 'policy' }, saved.record.budgetOverrides).weeklyBudgetMicros, 100);
  const auth = { principalId: session.email, policyId: 'maintainer_access', policy: effective };
  const held = await reserveBudget(env, auth, 'llm.chat', { reserveMicros: 8, basis: 'policy_fixed' });
  assert.equal(held.reservedMicros, 8);
  const lowered = effectiveBudgetPolicy('maintainer_access', base, { maintainer_access: { ...override, weeklyBudgetMicros: 7 } });
  await assert.rejects(reserveBudget(env, { ...auth, policy: lowered }, 'llm.chat', { reserveMicros: 1, basis: 'policy_fixed' }), { code: 'weekly_budget_exhausted' });
  let softDenial;
  await softBudget(env, { ...auth, policy: lowered }, 'llm.chat', { providerId: 'openai' }, 'lowered-limit', error => { softDenial = error; }).check;
  assert.equal(softDenial.code, 'weekly_budget_exhausted');
  const status = await budgetStatus(env, auth.policyId, lowered, auth.principalId);
  assert.equal(status.weekly.limitMicros, 7); assert.equal(status.weekly.override, true); assert.equal(status.daily.override, true);
  await env.http(path, 'PUT', {});
  const inherited = (await env.call('/users/resolve', { emails: [session.email] })).users[0];
  assert.equal(effectiveBudgetPolicy('maintainer_access', base, inherited.record.budgetOverrides).weeklyBudgetMicros, 100);
  await env.http('/v1/admin/policies/maintainer_access/budget-limits', 'PUT', { weeklyBudgetMicros: 0 });
  const caps = await (await env.http('/v1/admin/caps')).json();
  const member = caps.rows.find(row => row.policy.policyId === 'maintainer_access').members.find(row => row.email === session.email);
  assert.equal(member.budget.weekly.limitMicros, 0);
  assert.equal(member.budget.weekly.spentMicros, 8);
  assert.equal((await env.http('/v1/admin/caps', 'GET', undefined, { auth: 'user' })).status, 403);
});

test('soft partial pricing charges known tokens and keeps unpriced basis', async () => {
  const { accountingReceipt } = await import('../proxy-accounting.ts');
  const { snapshot } = await import('../providers.ts');
  const model = snapshot.providers.find(p => p.id === 'openai').models.find(m => m.id === 'openai/gpt-6.1-sol');
  const event = accountingReceipt({ model, fixed: null, cost: { reserveMicros: 0, basis: 'unpriced_request', pricingGap: 'hosted_tool_fee' }, requestFormat: 'openai.responses', event: {}, startedAtMs: 0 }, { occurredAtMs: 1, statusCode: 200, status: 'success', billable: true, tokens: { input: 100, output: 20, total: 120, cached: 0, cacheWrite: 0, serviceTier: 'default' }, reservation: { reservations: [], reservedMicros: 0, charges: [] }, contentRef: null });
  assert.ok(event.actual_cost_micros > 0); assert.equal(event.cost_basis, 'unpriced_usage');
});

test('stale override updates conflict; independent policy cap patches preserve unrelated fields', async t => {
  const env = await fixture(t);
  const path = `/v1/admin/access-users/${session.email}/budget-overrides/maintainer_access`;
  const first = await (await env.http(path, 'PUT', { weeklyBudgetMicros: 100 }, { headers: { 'if-match': 'absent' } })).json();
  assert.equal((await env.http(path, 'PUT', { weeklyBudgetMicros: 200 }, { headers: { 'if-match': 'absent' } })).status, 409);
  const second = await (await env.http(path, 'PUT', { weeklyBudgetMicros: 200 }, { headers: { 'if-match': first.budgetOverrides.maintainer_access.updatedAt } })).json();
  assert.notEqual(second.budgetOverrides.maintainer_access.updatedAt, first.budgetOverrides.maintainer_access.updatedAt);
  const changed = await env.http('/v1/admin/policies/maintainer_access/budget-limits', 'PUT', { weeklyBudgetMicros: 700 });
  assert.equal(changed.status, 200); const body = await changed.json();
  assert.equal(body.monthlyBudgetMicros, policy.monthlyBudgetMicros); assert.equal(body.weeklyBudgetMicros, 700); assert.deepEqual(body.providers, policy.providers);
});

test('soft charges preserve distinct logical scopes on a physically aliased monthly ledger', async t => {
  const env = { BUDGET_LEDGER: sqlBudgetNamespace(t), USAGE_QUEUE: { send: async () => {} } };
  const auth = { policyId: 'openai', policy: { tenantId: 'provider', monthlyBudgetMicros: 100, budgetScope: 'policy' } };
  const budget = softBudget(env, auth, 'llm.chat', { providerId: 'openai', monthlyBudgetMicros: 100 }, 'request', () => {});
  await budget.check; await budget.beforeDelivery();
  const { finalizeAccounting } = await import('../accounting.ts');
  await finalizeAccounting(env, budget.reservation, 5, { request_id: 'request' });
  const rows = env.BUDGET_LEDGER.get('provider:openai').reservations();
  assert.equal(rows.length, 2); assert.equal(new Set(rows.map(row => row.reservation_id)).size, 2);
  assert.equal((await budgetStatus(env, 'openai', auth.policy)).spentMicros, 5);
});

test('admission consumes owner overrides in its existing single authority read', async t => {
  const { credential, sha256 } = await import('./credential-fixture.mjs');
  const { authenticateProxyKey } = await import('../proxy-auth.ts');
  const env = await fixture(t, [['owned', { ...credential(), secretSha256: await sha256('synthetic-owned') }]]);
  const path = `/v1/admin/access-users/${session.email}/budget-overrides/maintainer_access`;
  await env.http(path, 'PUT', { weeklyBudgetMicros: 77, monthlyBudgetMicros: null });
  const original = env.ACCESS_CONTROL.get(), calls = [];
  env.ACCESS_CONTROL.get = () => ({ fetch: (...args) => { calls.push(new URL(args[0]).pathname); return original.fetch(...args); } });
  const auth = await authenticateProxyKey(new Headers({ authorization: 'Bearer clawrouter-live-owned-synthetic-owned' }), env);
  assert.equal(auth.policy.weeklyBudgetMicros, 77); assert.equal(auth.policy.monthlyBudgetMicros, null);
  assert.deepEqual(calls, ['/admission/resolve']);
});
