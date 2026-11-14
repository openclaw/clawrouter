import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';
import { preflight, serializeReceipt, sourceAccepted, MAPPINGS } from '../scripts/preflight-native-rehearsal.mjs';
import { nativeVersion } from './helpers/deploy-native-fixture.mjs';

const ACCOUNT = '0123456789abcdef0123456789abcdef', TOKEN = 'SENTINEL-private-bearer-do-not-print';
const PRIVATE = 'SENTINEL-private-server-data', FOREIGN = 'unrelated-customer-resource';
const SHA = 'b'.repeat(40), VERSION = '11111111-1111-1111-1111-111111111111', DEPLOY = '22222222-2222-2222-2222-222222222222';
const ID = 'd'.repeat(32), OWN = 'clawrouter-native-qualification-123456abcdef';
const hash = s => createHash('sha256').update(s).digest('hex');
const env = { GITHUB_REPOSITORY: 'openclaw/clawrouter', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main',
  GITHUB_SHA: SHA, EXPECTED_SHA: SHA, CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
  PRESENT_NATIVE_QUALIFICATION_CF_API_TOKEN: 'true', PRESENT_CLAWROUTER_NATIVE_ADMIN_TOKEN: 'true' };
const limits = { pages: 3, items: 100, bodyBytes: 100_000, requestMs: 1000, totalMs: 5000 };
const ok = (result, result_info) => Response.json({ success: true, result, ...(result_info ? { result_info } : {}), messages: [{ message: PRIVATE }] });
function fixture(override = () => undefined) {
  const calls = [], version = nativeVersion(VERSION, SHA);
  version.resources.bindings.push({ name: 'PRIVATE_SECRET_NAME', type: 'secret_text', text: TOKEN },
    { name: 'PRIVATE_SETTINGS', type: 'plain_text', text: PRIVATE });
  const deployment = { id: DEPLOY, versions: [{ version_id: VERSION, percentage: 100 }], author_email: PRIVATE };
  const fetchImpl = async (url, init) => {
    const u = new URL(url), path = u.pathname.replace('/client/v4/accounts/' + ACCOUNT, '');
    calls.push({ url, path, query: u.searchParams, init });
    assert.equal(u.origin, 'https://api.cloudflare.com');
    assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'error'); assert.equal(init.body, undefined);
    assert.equal(init.headers.authorization, 'Bearer ' + TOKEN);
    const replacement = await override({ path, query: u.searchParams, init, calls });
    if (replacement !== undefined) return replacement;
    if (!path) return ok({ id: ACCOUNT, name: PRIVATE });
    if (path.endsWith('/deployments')) return ok({ deployments: [deployment] });
    if (path.endsWith('/versions/' + VERSION)) return ok(version);
    if (path === '/workers/scripts') return ok([{ id: OWN, logpush: PRIVATE }, { id: FOREIGN }]);
    if (path === '/workers/durable_objects/namespaces') return ok([{ id: ID, script: OWN, name: PRIVATE }], { page: 1, total_pages: 1, total_count: 1 });
    if (path === '/storage/kv/namespaces') return ok([{ id: ID, title: OWN + '-policy' }], { page: 1, total_count: 1 });
    if (path === '/queues') return ok([{ queue_id: ID, queue_name: OWN + '-queue', consumers: [{ secret: PRIVATE }] }], { page: 1, total_pages: 1, total_count: 1 });
    if (path === '/r2/buckets') return ok({ buckets: [{ name: OWN + '-content' }, { name: FOREIGN }] }, { total_count: 2 });
    if (path === '/containers/applications') return ok([
      { id: ID, name: OWN + '-large-http', account_id: ACCOUNT, max_instances: 8, durable_objects: { namespace_id: ID }, configuration: { environment_variables: [TOKEN] } },
      { id: VERSION, name: 'clawrouter-edge-large-http', account_id: ACCOUNT, durable_objects: { namespace_id: 'fixture-LARGE_HTTP_SLOTS' }, health: { instances: { active: 8, assigned: 8 }, errors: [PRIVATE] } },
      { id: PRIVATE, name: FOREIGN, account_id: PRIVATE },
    ], {});
    if (path === '/containers/usage') return ok({ maximum: { vcpus: 64, disk_mb: 100_000, memory_mib: 16000 }, usage: { vcpus: 4, disk_mb: 8000, memory_mib: 1024, instances: 8 }, secret: PRIVATE });
    if (path === '/subscriptions') return ok([{ rate_plan: { id: 'workers_paid', public_name: PRIVATE }, price: 5, frequency: 'monthly', state: 'Paid' }, { rate_plan: { id: FOREIGN } }]);
    if (path === '/billable/usage') return ok([{ BillingAccountId: ACCOUNT, x_ProductFamilyId: 'workers', x_BillableMetricId: 'workers_requests', ConsumedQuantity: 42,
      ConsumedUnit: 'Requests', ChargePeriodStart: '2026-11-01T00:00:00Z', ChargePeriodEnd: '2026-11-02T00:00:00Z', BillingAccountName: PRIVATE, Tags: { private: TOKEN } }]);
    throw new Error('Unexpected API path');
  };
  return { calls, version, deployment, run: options => preflight({ env, fetchImpl, limits, ...options }) };
}
const safe = r => {
  const output = serializeReceipt(r, [ACCOUNT, TOKEN]);
  for (const secret of [ACCOUNT, TOKEN, PRIVATE, FOREIGN, 'PRIVATE_SECRET_NAME', 'PRIVATE_SETTINGS']) assert.equal(output.includes(secret), false);
  assert.equal(JSON.parse(output).qualified, false); assert.equal(JSON.parse(output).provisioningAllowed, false);
  return JSON.parse(output);
};

test('real projections retain only useful identities, counts, capacity and metered usage over GET', async () => {
  const f = fixture(), r = safe(await f.run());
  assert.equal(r.status, 'observed'); assert.deepEqual(r.blockers, []);
  assert.equal(r.accountFingerprint, hash(ACCOUNT));
  assert.equal(r.observations.production.versions[0].nativeSource, SHA);
  assert.equal(r.observations.production.versions[0].runtimeSha256, 'e'.repeat(64));
  assert.equal(r.observations.production.versions[0].owners.POLICY_KV, hash('a'.repeat(32)));
  assert.deepEqual(r.observations.workers.matches, [{ name: OWN, id: OWN }]);
  assert.equal(r.observations.workers.omittedCount, 1);
  assert.equal(r.observations.durableObjects.matches[0].namespaceFingerprint, hash(ID));
  assert.equal(r.observations.kv.matches[0].id, ID);
  assert.equal(r.observations.queues.matches[0].id, ID);
  assert.equal(r.observations.bucketsDefaultJurisdiction.matches[0].name, OWN + '-content');
  assert.equal(r.observations.containers.matches[1].activeInstances, 8);
  assert.equal(r.observations.productionContainer.namespaceConsistent, true);
  assert.equal(r.observations.capacity.maximum.vcpus, 64);
  assert.equal(r.observations.capacity.usage.instances, 8);
  assert.equal(r.observations.subscriptions.matches[0].state, 'Paid');
  assert.equal(r.observations.billableUsage.matches[0].quantity, 42);
  assert.equal(r.observations.billableUsage.cost, 'unknown_get_does_not_return_rated_costs');
  assert.deepEqual(Object.keys(r.mappings), [...MAPPINGS]);
  assert.equal(r.mappings.NATIVE_QUALIFICATION_CF_API_TOKEN, true);
  assert.equal(r.mappings.NATIVE_QUALIFICATION_ADMIN_TOKEN, false);
  assert.equal(f.calls.length, 13);
  assert.equal(f.calls.some(v => /settings|secrets|tail|values|messages/.test(v.path)), false);
});

test('source and credential guards fail closed with zero API calls', async () => {
  for (const change of [{ EXPECTED_SHA: SHA.slice(0, 8) }, { EXPECTED_SHA: 'C'.repeat(40) }, { GITHUB_SHA: 'c'.repeat(40) },
    { GITHUB_REF: 'refs/heads/topic' }, { GITHUB_EVENT_NAME: 'pull_request' }, { GITHUB_REPOSITORY: 'someone/clawrouter' },
    { CLOUDFLARE_API_TOKEN: '' }, { CLOUDFLARE_ACCOUNT_ID: 'invalid' }]) {
    const f = fixture(), r = safe(await f.run({ env: { ...env, ...change } }));
    assert.equal(r.status, 'blocked'); assert.equal(f.calls.length, 0);
  }
});

test('denial is not absence or invalid credentials; independent reads still provide evidence', async () => {
  for (const code of [401, 403, 404, 429, 500]) {
    const f = fixture(({ path }) => path === '/containers/usage' || !path ? new Response(TOKEN + PRIVATE + ACCOUNT, { status: code }) : undefined);
    const r = safe(await f.run());
    assert.equal(r.status, 'blocked');
    assert.equal(r.observations.capacity.status, code === 403 ? 'forbidden' : code === 401 ? 'unauthorized' : 'unavailable');
    assert.equal(r.observations.capacity.reason, 'http_' + code);
    assert.equal(r.observations.production.status, 'ok');
    assert.equal('usage' in r.observations.capacity, false);
  }
});

test('transport errors, malformed JSON, unsuccessful API and oversized bodies produce safe receipts', async () => {
  for (const response of [() => { throw new Error(TOKEN + PRIVATE + ACCOUNT); }, () => new Response(PRIVATE),
    () => Response.json({ success: false, errors: [{ message: TOKEN }] }), () => new Response(PRIVATE.repeat(10000))]) {
    const f = fixture(({ path }) => path === '/workers/scripts' ? response() : undefined);
    const r = safe(await f.run());
    assert.equal(r.status, 'blocked'); assert.equal(r.observations.workers.complete, false);
    assert.notEqual(r.observations.workers.status, 'ok');
  }
});

test('page, cursor and token pagination collect bounded projections without leaking opaque cursors', async () => {
  const f = fixture(({ path, query }) => {
    if (path === '/storage/kv/namespaces') {
      const page = Number(query.get('page'));
      return ok([{ id: String(page).repeat(32), title: OWN + '-kv-' + page }], { page, total_pages: 2, total_count: 2 });
    }
    if (path === '/r2/buckets') return query.has('cursor')
      ? ok({ buckets: [] }, { total_count: 1 }) : ok({ buckets: [{ name: OWN + '-bucket' }] }, { cursor: TOKEN, total_count: 1 });
    if (path === '/containers/applications' && !query.has('page_token')) return ok([{ id: 'e'.repeat(32), name: FOREIGN }], { next_page_token: PRIVATE });
  });
  const r = safe(await f.run());
  assert.equal(r.status, 'observed'); assert.equal(r.observations.kv.observedCount, 2);
  assert.equal(r.observations.bucketsDefaultJurisdiction.complete, true);
  assert.ok(f.calls.some(c => c.query.get('cursor') === TOKEN));
  assert.ok(f.calls.some(c => c.query.get('page_token') === PRIVATE));
});

test('truncation, missing metadata, duplicate pages and late denial cannot claim complete or absent', async () => {
  const variants = [
    ({ query }) => ok([{ id: query.get('page').repeat(32), title: OWN + '-' + query.get('page') }], { page: Number(query.get('page')), total_pages: 99, total_count: 99 }),
    () => ok([], undefined),
    ({ query }) => ok([{ id: ID, title: OWN }], { page: Number(query.get('page')), total_pages: 2 }),
    ({ query }) => query.get('page') === '1' ? ok([{ id: ID, title: OWN }], { page: 1, total_pages: 2 }) : new Response(PRIVATE, { status: 403 }),
    () => ok([], { page: 1, total_pages: 1, total_count: 10 }),
  ];
  for (const variant of variants) {
    const f = fixture(args => args.path === '/storage/kv/namespaces' ? variant(args) : undefined), r = safe(await f.run());
    assert.equal(r.observations.kv.status, 'partial'); assert.equal(r.observations.kv.complete, false);
    assert.ok(r.blockers.includes('kv')); assert.ok(f.calls.length <= 16);
  }
  const r = safe(await fixture().run({ limits: { ...limits, items: 1 } }));
  assert.equal(r.observations.workers.reason, 'item_limit'); assert.equal(r.observations.workers.complete, false);
});

test('empty complete inventory is distinct from unavailable; missing capacity metric remains null', async () => {
  const f = fixture(({ path }) => path === '/queues' ? ok([], { page: 1, total_count: 0, total_pages: 0 })
    : path === '/containers/usage' ? ok({ maximum: { vcpus: 0 }, usage: { instances: 0 } }) : undefined);
  const r = safe(await f.run());
  assert.equal(r.observations.queues.complete, true); assert.equal(r.observations.queues.observedCount, 0);
  assert.equal(r.observations.capacity.status, 'partial'); assert.equal(r.observations.capacity.maximum.vcpus, 0);
  assert.equal(r.observations.capacity.maximum.memory_mib, null);
});

test('native lineage, deployment drift and namespace mismatch are prerequisite failures', async () => {
  for (const mutate of [f => { f.version.annotations['workers/message'] = PRIVATE; },
    f => { f.version.resources.bindings.find(b => b.name === 'LARGE_HTTP_SLOTS').namespace_id = ID; }]) {
    const f = fixture(); mutate(f); const r = safe(await f.run()); assert.equal(r.status, 'blocked');
  }
  const f = fixture(({ path, calls }) => path.endsWith('/deployments') && calls.filter(c => c.path === path).length > 1
    ? ok({ deployments: [{ id: VERSION, versions: [{ version_id: VERSION, percentage: 100 }] }] }) : undefined);
  assert.equal(safe(await f.run()).observations.production.status, 'unavailable');
});

test('malformed matching metadata never becomes an unsafe output string', async () => {
  const f = fixture(({ path }) => path === '/workers/scripts' ? ok([{ id: OWN + '\n' + TOKEN }]) : undefined);
  const r = safe(await f.run()); assert.equal(r.observations.workers.complete, false);
  for (const secret of [TOKEN, ACCOUNT, 'quote"\nsecret']) {
    const output = serializeReceipt({ status: 'observed', source: secret }, [secret]);
    assert.deepEqual(JSON.parse(output).blockers, ['output_secret_collision']);
  }
});

test('timeout is bounded and never echoes a transport exception', async () => {
  const keepAlive = setTimeout(() => {}, 2000);
  try {
    const f = fixture(({ init }) => new Promise((resolve, reject) => {
      if (init.signal.aborted) reject(new Error(PRIVATE));
      else init.signal.addEventListener('abort', () => reject(new Error(PRIVATE)), { once: true });
    }));
    const started = Date.now(), r = safe(await f.run({ limits: { ...limits, requestMs: 5, totalMs: 15 } }));
    assert.equal(r.status, 'blocked'); assert.ok(Date.now() - started < 1000);
    assert.equal(r.observations.billableUsage.reason, 'total_deadline');
  } finally { clearTimeout(keepAlive); }
});

test('actual workflow guard executes before checkout, writes failure receipt, and accepts only exact main', () => {
  const workflow = parse(readFileSync(new URL('../.github/workflows/preflight-native-rehearsal.yml', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']);
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  const steps = workflow.jobs.observe.steps, guard = steps[0];
  assert.equal(guard.env, undefined); assert.equal(workflow.jobs.observe.env, undefined);
  assert.match(steps[1].uses, /^actions\/checkout@[a-f0-9]{40}$/);
  assert.equal(steps[1].with.ref, '$' + '{{ inputs.expected_sha }}');
  assert.equal(steps[1].with['persist-credentials'], false);
  const dir = mkdtempSync(join(tmpdir(), 'native-preflight-test-'));
  try {
    for (const change of [{}, { EXPECTED_SHA: 'bad\n$(false)' }, { GITHUB_REF: 'refs/heads/topic' }, { GITHUB_REPOSITORY: 'fork/clawrouter' },
      { GITHUB_EVENT_NAME: 'pull_request' }, { GITHUB_SHA: 'c'.repeat(40) }, { EXPECTED_SHA: 'b'.repeat(39) }]) {
      const e = { ...env, ...change }, path = join(dir, 'receipt.json');
      const result = spawnSync('bash', ['-e', '-c', guard.run], { env: { PATH: process.env.PATH, ...e, PREFLIGHT_RECEIPT: path }, encoding: 'utf8' });
      assert.equal(result.status, sourceAccepted(e) ? 0 : 1, result.stderr);
      const receipt = JSON.parse(readFileSync(path, 'utf8'));
      assert.equal(receipt.status, 'blocked'); assert.equal(receipt.provisioningAllowed, false);
      assert.deepEqual(receipt.blockers, [sourceAccepted(e) ? 'preflight_not_completed' : 'source_guard']);
    }
    const path = join(dir, 'cli.json'), result = spawnSync(process.execPath, ['scripts/preflight-native-rehearsal.mjs'],
      { env: { PATH: process.env.PATH, PREFLIGHT_RECEIPT: path }, encoding: 'utf8' });
    assert.equal(result.status, 1); assert.deepEqual(JSON.parse(result.stdout).blockers, ['source_guard']);
    assert.equal(readFileSync(path, 'utf8'), result.stdout);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test('unavailable Alpha billing and unsupported meters never become zero cost or usage', async () => {
  for (const response of [() => new Response(PRIVATE, { status: 403 }), () => ok([{ x_ProductFamilyId: 'workers', BillingAccountId: ACCOUNT,
    x_BillableMetricId: 'synthetic', ConsumedQuantity: 42, ConsumedUnit: 'unsupported', ChargePeriodStart: '2026-11-01T00:00:00Z', ChargePeriodEnd: '2026-11-02T00:00:00Z' }])]) {
    const r = safe(await fixture(({ path }) => path === '/billable/usage' ? response() : undefined).run());
    assert.ok(r.blockers.includes('billableUsage')); assert.equal(r.observations.billableUsage.complete, false);
    assert.equal(r.observations.billableUsage.cost, 'unknown_get_does_not_return_rated_costs');
    assert.deepEqual(r.observations.billableUsage.matches, []);
  }
});

test('account mismatch and repeated resource IDs with changed metadata remain blocked', async () => {
  const f = fixture(({ path, query }) => !path ? ok({ id: ID }) : path === '/storage/kv/namespaces'
    ? ok([{ id: ID, title: OWN + '-' + query.get('page') }], { page: Number(query.get('page')), total_pages: 2, total_count: 2 }) : undefined);
  const r = safe(await f.run());
  assert.equal(r.observations.account.reason, 'account_identity_mismatch');
  assert.equal(r.observations.kv.complete, false); assert.equal(r.observations.kv.observedCount, 1);
});
