import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';
import { authSourceAccepted, observeNativeAuthentication, createAuthenticationProbe, main } from '../scripts/preflight-native-auth.mjs';
import { isolatedNativeTarget } from '../scripts/deploy-native-target.mjs';
import { createApi } from '../scripts/deploy-train-api.mjs';
import { nativeVersion } from './helpers/deploy-native-fixture.mjs';

const account = 'a'.repeat(32), worker = 'clawrouter-native-qualification-012345abcdef';
const origin = 'https://' + worker + '.fixture.workers.dev', source = 'c'.repeat(40);
const target = isolatedNativeTarget({ worker, origin, account }), selected = '11111111-1111-1111-1111-111111111111';
const token = 'synthetic-auth-preflight', hash = createHash('sha256').update(token).digest('hex');
function fixture({ wrongToken = false, denied = false, drift = false, shareOwner = false, disabled = false, uppercase = false, wrongVersion = false, anonymousAccepted = false, remoteActor = false, missingOwner = false, service = false, missingVersion = false } = {}) {
  const production = nativeVersion('99999999-9999-9999-9999-999999999999', source);
  const version = structuredClone(nativeVersion(selected, source));
  for (const binding of version.resources.bindings) {
    if (binding.name === 'LARGE_HTTP_ORIGIN') binding.text = origin;
    for (const key of ['namespace_id', 'queue_name', 'bucket_name']) if (binding[key]) binding[key] = 'isolated-' + binding[key];
  }
  if (shareOwner) version.resources.bindings.find(b => b.name === 'POLICY_KV').namespace_id = 'a'.repeat(32);
  version.resources.bindings.push({ name: 'CLAWROUTER_ADMIN_TOKEN_SHA256', type: 'plain_text', text: hash });
  if (disabled) { version.annotations = {}; for (const b of version.resources.bindings) if (['LARGE_HTTP_ENABLED', 'LARGE_HTTP_INGRESS_ENABLED'].includes(b.name)) b.text = '0'; }
  if (uppercase) version.resources.bindings.find(b => b.name === 'CLAWROUTER_ADMIN_TOKEN_SHA256').text = hash.toUpperCase();
  if (remoteActor) version.resources.bindings.find(b => b.name === 'LARGE_HTTP_POOL').script_name = 'elsewhere';
  if (missingOwner) version.resources.bindings = version.resources.bindings.filter(b => b.name !== 'CONTENT_ARCHIVE');
  if (service) version.resources.bindings.push({ name: 'REMOTE', type: 'service', service: 'elsewhere' });
  const env = { CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_API_TOKEN: 'synthetic-management', CLAWROUTER_NATIVE_ADMIN_TOKEN: wrongToken ? hash : token };
  const calls = [], receipts = [];
  let latestReads = 0;
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, redirect: init.redirect });
    const path = new URL(url).pathname;
    if (url.startsWith(origin)) {
      assert.equal(init.method, 'HEAD');
      const bearer = new Headers(init.headers).get('authorization');
      if (bearer) assert.equal(bearer, 'Bearer ' + token);
      return new Response(null, { status: !bearer && !anonymousAccepted || denied ? 401 : 404,
        headers: missingVersion ? {} : { 'x-clawrouter-version-id': wrongVersion ? production.id : selected } });
    }
    assert.equal(init.method, 'GET');
    let result;
    if (path.includes('/workers/scripts/clawrouter-edge/')) result = path.endsWith('/deployments') ? { deployments: [{ versions: [{ version_id: production.id, percentage: 100 }] }] } : production;
    else if (path.endsWith('/deployments')) result = { deployments: [{ id: drift && ++latestReads > 1 ? 'changed' : 'initial', versions: [{ version_id: selected, percentage: 100 }] }] };
    else result = version;
    return Response.json({ success: true, result });
  };
  const api = createApi({ env, target, fetchImpl }), probe = createAuthenticationProbe({ env, target, fetchImpl });
  const run = () => observeNativeAuthentication({ api, probe, target, token: env.CLAWROUTER_NATIVE_ADMIN_TOKEN, source, save: value => receipts.push(structuredClone(value)) });
  return { run, calls, receipts };
}
for (const options of [{}, { disabled: true }, { uppercase: true }, { disabled: true, uppercase: true }]) test('actual clients authenticate isolated metadata ' + JSON.stringify(options), async () => {
  const f = fixture(options), receipt = await f.run();
  assert.equal(receipt.result, 'authenticated'); assert.equal(receipt.qualified, false); assert.equal(receipt.readOnly, true);
  assert.equal(receipt.version, selected); assert.ok(receipt.finishedAt);
  assert.equal(f.calls.filter(call => call.url.startsWith(origin)).length, 2);
  assert.ok(f.calls.every(call => ['GET', 'HEAD'].includes(call.method) && call.redirect === 'error'));
  assert.equal(f.receipts[0].result, 'blocked'); assert.equal(f.receipts.at(-1).result, 'authenticated');
});
test('a hash used as bearer is rejected before sending it to the Worker', async () => {
  const f = fixture({ wrongToken: true }); await assert.rejects(f.run(), /credential-identity/);
  assert.equal(f.calls.some(call => call.url.startsWith(origin)), false);
  assert.equal(f.receipts.at(-1).result, 'failed');
});
for (const [options, stage] of [[{ denied: true }, 'admin-head'], [{ drift: true }, 'deployment-stability'],
  [{ shareOwner: true }, 'isolated-owners'], [{ anonymousAccepted: true }, 'admin-head'], [{ wrongVersion: true }, 'admin-head'], [{ missingVersion: true }, 'admin-head'], [{ remoteActor: true }, 'isolated-owners'], [{ missingOwner: true }, 'isolated-owners'], [{ service: true }, 'isolated-owners']]) {
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

test('real expired rehearsal entry authenticates enabled/disabled fresh targets without lifecycle effects', async () => {
  const { authenticationRuntime } = await import('./helpers/preflight-native-auth-runtime.mjs');
  for (const enabled of [false, true]) for (const uppercase of [false, true]) {
    const runtime = authenticationRuntime({ origin, worker, selected, hash: uppercase ? hash.toUpperCase() : hash, enabled });
    const probe = createAuthenticationProbe({ env: { CLAWROUTER_NATIVE_ADMIN_TOKEN: token }, target,
      fetchImpl: (url, init) => runtime.fetch(new Request(url, init)) });
    await probe(selected); runtime.assertUntouched();
    const wrong = createAuthenticationProbe({ env: { CLAWROUTER_NATIVE_ADMIN_TOKEN: 'synthetic-wrong' }, target,
      fetchImpl: (url, init) => runtime.fetch(new Request(url, init)) });
    await assert.rejects(wrong(selected), error => error.status === 401); runtime.assertUntouched();
  }
  // Positive control: the actual GET path reaches pool writes and alarms.
  const runtime = authenticationRuntime({ origin, worker, selected, hash });
  const response = await runtime.fetch(new Request(origin + '/v1/admin/large-http', { headers: { authorization: 'Bearer ' + token } }));
  assert.equal(response.status, 200);
  assert.ok(runtime.effects.poolAccesses > 0); assert.ok(runtime.effects.stateWrites > 0); assert.ok(runtime.effects.alarms > 0);
  await runtime.tick(); assert.ok(runtime.effects.nativeStarts > 0);
});
