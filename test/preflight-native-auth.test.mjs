import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';
import { authSourceAccepted, observeNativeAuthentication, main } from '../scripts/preflight-native-auth.mjs';
import { isolatedNativeTarget } from '../scripts/deploy-native-target.mjs';
import { createApi } from '../scripts/deploy-train-api.mjs';
import { createNativeControl } from '../scripts/deploy-native-cutover.mjs';
import { nativeVersion, runtimeSha } from './helpers/deploy-native-fixture.mjs';

const account = 'a'.repeat(32), worker = 'clawrouter-native-qualification-012345abcdef';
const origin = 'https://' + worker + '.fixture.workers.dev', source = 'c'.repeat(40);
const target = isolatedNativeTarget({ worker, origin, account }), selected = '11111111-1111-1111-1111-111111111111';
const token = 'synthetic-auth-preflight', hash = createHash('sha256').update(token).digest('hex');
const fingerprint = 'b'.repeat(64);
function fixture({ wrongToken = false, denied = false, drift = false, shareOwner = false, wrongRuntime = false, wrongVersion = false } = {}) {
  const production = nativeVersion('99999999-9999-9999-9999-999999999999', source);
  const version = structuredClone(nativeVersion(selected, source));
  for (const binding of version.resources.bindings) {
    if (binding.name === 'LARGE_HTTP_ORIGIN') binding.text = origin;
    for (const key of ['namespace_id', 'queue_name', 'bucket_name']) if (binding[key]) binding[key] = 'isolated-' + binding[key];
  }
  if (shareOwner) version.resources.bindings.find(b => b.name === 'POLICY_KV').namespace_id = 'a'.repeat(32);
  version.resources.bindings.push({ name: 'CLAWROUTER_ADMIN_TOKEN_SHA256', type: 'plain_text', text: hash });
  const env = { CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_API_TOKEN: 'synthetic-management', CLAWROUTER_NATIVE_ADMIN_TOKEN: wrongToken ? hash : token };
  const calls = [], receipts = [];
  let latestReads = 0;
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, redirect: init.redirect });
    assert.equal(init.method, 'GET', 'all actual API/control client calls must be read-only');
    const path = new URL(url).pathname;
    if (url.startsWith(origin)) {
      assert.equal(new Headers(init.headers).get('authorization'), 'Bearer ' + token);
      if (denied) return new Response('PRIVATE_RESPONSE_' + token, { status: 401, headers: { 'x-clawrouter-version-id': selected } });
      const state = { schema: 2, accepting: false, phase: 'closed', slots: Array.from({ length: 8 }, () =>
        ({ generation: 0, phase: 'idle', fingerprint, ids: [] })), pool: { grants: [], members: Array(8).fill(null), issued: 0, seen: {} } };
      return Response.json({ status: 200, state, control: { runtimeSha: wrongRuntime ? 'f'.repeat(64) : runtimeSha } },
        { headers: { 'x-clawrouter-version-id': wrongVersion ? production.id : selected } });
    }
    let result;
    if (path.includes('/workers/scripts/clawrouter-edge/')) result = path.endsWith('/deployments') ? { deployments: [{ versions: [{ version_id: production.id, percentage: 100 }] }] } : production;
    else if (path.endsWith('/deployments')) result = { deployments: [{ id: drift && ++latestReads > 1 ? 'changed' : 'initial', versions: [{ version_id: selected, percentage: 100 }] }] };
    else result = version;
    return Response.json({ success: true, result });
  };
  const api = createApi({ env, target, fetchImpl }), control = createNativeControl({ env, target, fetchImpl });
  const run = () => observeNativeAuthentication({ api, control, target, token: env.CLAWROUTER_NATIVE_ADMIN_TOKEN, source, save: value => receipts.push(structuredClone(value)) });
  return { run, calls, receipts };
}
test('actual API/control clients authenticate a closed isolated Worker with GETs only', async () => {
  const f = fixture(), receipt = await f.run();
  assert.equal(receipt.result, 'authenticated'); assert.equal(receipt.qualified, false); assert.equal(receipt.readOnly, true);
  assert.equal(receipt.version, selected); assert.ok(receipt.finishedAt);
  assert.equal(f.calls.filter(call => call.url.startsWith(origin)).length, 1);
  assert.ok(f.calls.every(call => call.method === 'GET' && call.redirect === 'error'));
  assert.equal(f.receipts[0].result, 'blocked'); assert.equal(f.receipts.at(-1).result, 'authenticated');
});
test('a hash used as bearer is rejected before sending it to the Worker', async () => {
  const f = fixture({ wrongToken: true }); await assert.rejects(f.run(), /credential-identity/);
  assert.equal(f.calls.some(call => call.url.startsWith(origin)), false);
  assert.equal(f.receipts.at(-1).result, 'failed');
});
for (const [options, stage] of [[{ denied: true }, 'admin-get'], [{ drift: true }, 'deployment-stability'],
  [{ shareOwner: true }, 'isolated-owners'], [{ wrongRuntime: true }, 'admin-get'], [{ wrongVersion: true }, 'admin-get']]) {
  test('refuses ' + JSON.stringify(options) + ' and preserves only a safe failure receipt', async () => {
    const f = fixture(options); await assert.rejects(f.run(), new RegExp(stage));
    const receipt = f.receipts.at(-1); assert.equal(receipt.result, 'failed'); assert.equal(receipt.stage, stage);
    assert.equal(receipt.qualified, false); assert.ok(receipt.finishedAt);
    assert.equal(JSON.stringify(f.receipts).includes(token), false); assert.equal(JSON.stringify(f.receipts).includes(hash), false);
    if (options.denied) assert.equal(receipt.httpStatus, 401);
    if (options.shareOwner) assert.equal(f.calls.some(call => call.url.startsWith(origin)), false);
  });
}
test('exact-main guard and hosted workflow use only the qualification environment secrets', async () => {
  const env = { GITHUB_REPOSITORY: 'openclaw/clawrouter', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main', EXPECTED_SHA: source, GITHUB_SHA: source };
  assert.equal(authSourceAccepted(env), true);
  for (const override of [{ GITHUB_REPOSITORY: 'fork/clawrouter' }, { GITHUB_EVENT_NAME: 'pull_request' }, { GITHUB_REF: 'refs/heads/topic' }, { EXPECTED_SHA: 'd'.repeat(40) }])
    assert.equal(authSourceAccepted({ ...env, ...override }), false);
  await assert.rejects(main({}), /exact reviewed main/);
  const workflow = parse(readFileSync(new URL('../.github/workflows/preflight-native-auth.yml', import.meta.url), 'utf8'));
  const jobs = Object.values(workflow.jobs); assert.equal(jobs.length, 1);
  const job = jobs[0]; assert.equal(job.environment, 'native-qualification'); assert.equal(job['timeout-minutes'], 5);
  const execution = job.steps.find(step => step.run === 'node scripts/preflight-native-auth.mjs');
  assert.equal(execution.env.CLAWROUTER_NATIVE_ADMIN_TOKEN, '${{ secrets.NATIVE_QUALIFICATION_ADMIN_TOKEN }}');
  for (const value of Object.values(execution.env).filter(value => value.includes('secrets.'))) assert.match(value, /secrets.NATIVE_QUALIFICATION_/);
  assert.equal(job.steps.some(step => step.run?.includes('qualify-native-cutover.mjs')), false);
  assert.equal(workflow.concurrency.group, 'clawrouter-native-qualification');
});
