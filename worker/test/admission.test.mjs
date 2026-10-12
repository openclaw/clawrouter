import './typescript-setup.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveCredentials, resolvePolicies, resolveUsers, resolveConnections } from '../authority.ts';
import { authenticateProxyKey, proxyCredentialFailure } from '../proxy-auth.ts';
const { default: worker } = await import('../index.ts');

import { admissionFixture as fixture, admissionHeaders as headers, admissionProvider as provider } from "./admission-fixture.mjs";

for (const [name, change, expected] of [
  ['valid owner', () => {}, null],
  ['revoked key', f => { f.credential.enabled = false; }, [403, 'proxy_key_revoked']],
  ['disabled policy', f => { f.policy.enabled = false; }, [403, 'policy_revoked']],
  ['stale generation', f => { f.credential.policyGeneration = 'old'; }, [403, 'credential_policy_stale']],
  ['missing policy', f => { f.credential.policyId = 'missing'; }, [403, 'credential_policy_missing']],
  ['disabled owner', async f => f.call('/users/put', { email: f.credential.principalId, record: { enabled: false } }), [403, 'principal_disabled']],
  ['missing owner', f => { f.credential.principalId = 'absent@example.com'; }, null],
  ['unowned service key', f => { f.credential.principalId = null; }, null],
]) test(`combined admission matches canonical reads: ${name}`, async () => {
  const f = await fixture(); await change(f);
  await f.call('/policies/put', { policyId: 'fixture', policy: f.policy });
  // Seed the exact row, including a deliberately stale generation.
  f.authority.sql.exec('UPDATE proxy_credentials SET credential_json = ? WHERE credential_id = ?', JSON.stringify(f.credential), 'fixture');
  const entry = (await resolveCredentials(f.env, ['fixture']))[0];
  const policy = (await resolvePolicies(f.env, [entry.credential.policyId]))[0];
  const owner = entry.credential.principalId ? (await resolveUsers(f.env, [entry.credential.principalId]))[0] : null;
  const canonical = proxyCredentialFailure(entry.credential, policy, owner?.record.enabled);
  f.calls.length = 0;
  const result = await authenticateProxyKey(new Headers(headers), f.env, [provider]);
  if (expected) { assert.equal(result.status, expected[0]); assert.equal((await result.json()).error.code, expected[1]); assert.equal(canonical.code, expected[1]); }
  else { assert.equal(canonical, null); assert.equal(result.policyId, 'fixture'); }
  assert.deepEqual(f.calls, ['/admission/resolve']);
});

for (const [authorization, code] of [['Bearer nonsense', 'invalid_proxy_key'], ['Bearer clawrouter-live-unknown-synthetic-secret', 'unknown_proxy_key'], ['Bearer clawrouter-live-fixture-wrong-secret', 'invalid_proxy_key']]) test(`combined admission preserves ${code}: ${authorization.split('-').at(-1)}`, async () => {
  const f = await fixture();
  const result = await authenticateProxyKey(new Headers({ authorization }), f.env, [provider]);
  assert.equal(result.status, 401); assert.equal((await result.json()).error.code, code);
});

for (const family of ['credentials', 'policies', 'users', 'connections']) for (const close of [false, true]) test(`admission ${family} import respects concurrent ${close ? 'migration closure' : 'canonical disable'}`, async () => {
  const f = await fixture();
  const tables = { credentials: 'proxy_credentials', policies: 'access_policies', users: 'access_users', connections: 'provider_connections' };
  f.authority.sql.exec(`DELETE FROM ${tables[family]}`);
  f.authority.sql.exec('DELETE FROM policy_binding_meta WHERE meta_key = ?', `${family}_global_initialized`);
  const entry = family === 'credentials' ? { credentialId: 'fixture', credential: f.credential } : family === 'policies' ? { policyId: 'fixture', policy: f.policy } : family === 'users' ? { email: f.credential.principalId, record: { enabled: true } } : { providerId: provider.id, enabled: true };
  const key = family === 'users' ? 'access/users/owner@example.com' : `${family}/${family === 'connections' ? provider.id : 'fixture'}`;
  f.records.set(key, family === 'credentials' ? f.credential : family === 'policies' ? f.policy : family === 'users' ? entry.record : entry);
  f.beforeRead(async readKey => {
    assert.equal(readKey, key);
    const disabled = structuredClone(entry);
    if (family === 'credentials') disabled.credential.enabled = false;
    else if (family === 'policies') disabled.policy.enabled = false;
    else if (family === 'users') disabled.record.enabled = false;
    else disabled.enabled = false;
    if (close) await f.call(`/${family}/initialize-all`, []);
    else await f.call(`/${family}/initialize`, [disabled]);
  });
  const result = await f.call('/admission/resolve', { credentialId: 'fixture', providers: [provider] });
  const row = family === 'credentials' ? result.credential?.credential : family === 'policies' ? result.policy?.policy : family === 'users' ? result.owner?.record : result.connections[0];
  assert.equal(row?.enabled, close ? undefined : false);
  if (family === 'connections') assert.deepEqual(await resolveConnections(f.env, [provider.id]), result.connections);
});

for (const [name, setup, expected] of [
  ['model not allowed', f => { f.policy.models = []; }, [403, 'model_not_allowed']],
  ['disabled connection', f => f.call('/connections/put', { providerId: provider.id, enabled: false }), [503, 'provider_disabled']],
  ['missing connection uses environment', f => f.authority.sql.exec('DELETE FROM provider_connections'), [200]],
  ['unavailable configured pool', f => { f.policy.grantRouting = { eligibleGrants: { anthropic: ['absent'] } }; }, [503, 'upstream_grant_pool_unavailable']],
  ['explicit environment fallback', f => { f.policy.grantRouting = { eligibleGrants: { anthropic: ['absent'] }, environmentFallback: true }; }, [200]],
]) test(`HTTP combined admission: ${name}`, async t => {
  const f = await fixture(); await setup(f); await f.call('/policies/put', { policyId: 'fixture', policy: f.policy }); f.calls.length = 0;
  t.mock.method(globalThis, 'fetch', async () => Response.json({ usage: { input_tokens: 1, output_tokens: 1 } }));
  const result = await worker.fetch(new Request('https://fixture/v1/messages', { method: 'POST', headers, body: JSON.stringify({ model: 'anthropic/claude-sonnet-5', max_tokens: 16, messages: [] }) }), f.env, f.context);
  assert.equal(result.status, expected[0]);
  if (expected[1]) assert.equal((await result.json()).error.code, expected[1]); else await result.text();
  await Promise.all(f.pending);
  assert.deepEqual(f.calls, ['/admission/resolve']);
});

test('legacy subscription inference retains two authority RPCs and streams JSON before EOF/accounting', async t => {
  const f = await fixture(), key = 'oauth/fixture/anthropic';
  f.records.set(key, { provider: provider.id, kind: 'subscription', enabled: true, credentialStore: 'durable_object', hasAccessToken: true, credentialStatus: 'active', updatedAt: '2026-01-01T00:00:00Z' });
  f.env.GRANT_CREDENTIALS = { idFromName: name => name, get: () => ({ fetch: async () => Response.json({ grant: { ...f.records.get(key), accessToken: 'synthetic-subscription' }, changed: false, migrated: false }) }) };
  const eof = Promise.withResolvers(), settlement = Promise.withResolvers();
  f.env.USAGE_QUEUE.send = () => settlement.promise;
  const prefix = '{"content":[{"type":"text","text":"hello"}],';
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({ async start(controller) { controller.enqueue(new TextEncoder().encode(prefix)); await eof.promise; controller.enqueue(new TextEncoder().encode('"usage":{"input_tokens":1,"output_tokens":1}}')); controller.close(); } }), { headers: { 'content-type': 'application/json' } }));
  const response = await worker.fetch(new Request('https://fixture/v1/messages', { method: 'POST', headers, body: JSON.stringify({ model: 'anthropic/claude-sonnet-5', max_tokens: 16, messages: [] }) }), f.env, f.context);
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), prefix, 'first bytes arrive while upstream EOF is gated');
  assert.deepEqual(f.calls, ['/admission/resolve', '/grant-pools/select']);
  eof.resolve();
  assert.ok((await reader.read()).value); assert.equal((await reader.read()).done, true, 'complete delivery does not await accounting');
  settlement.resolve(); await Promise.all(f.pending);
});

test('provider read failures preserve secret and model error precedence', async t => {
  const f = await fixture();
  t.mock.method(globalThis, 'fetch', () => { throw new Error('unexpected upstream dispatch'); });
  f.policy.tenantId = 'invalid\nscope';
  await f.call('/policies/put', { policyId: 'fixture', policy: f.policy });
  for (const [authorization, models, status, code] of [
    ['Bearer clawrouter-live-fixture-invalid-secret', null, 401, 'invalid_proxy_key'],
    [headers.authorization, [], 403, 'model_not_allowed'],
    [headers.authorization, ['anthropic/claude-sonnet-5'], 503, 'provider_not_configured'],
  ]) {
    f.policy.models = models; await f.call('/policies/put', { policyId: 'fixture', policy: f.policy });
    const result = await worker.fetch(new Request('https://fixture/v1/messages', { method: 'POST', headers: { ...headers, authorization }, body: JSON.stringify({ model: 'anthropic/claude-sonnet-5', messages: [], max_tokens: 16 }) }), f.env, f.context);
    assert.equal(result.status, status, await result.clone().text()); assert.equal((await result.json()).error.code, code);
  }
  await Promise.all(f.pending);
});

test('parsing provider selection first preserves authentication precedence for malformed JSON', async () => {
  const f = await fixture();
  for (const [authorization, expected] of [['Bearer invalid', 401], [headers.authorization, 400]]) {
    const response = await worker.fetch(new Request('https://fixture/v1/chat/completions', { method: 'POST', headers: { ...headers, authorization }, body: '{' }), f.env, f.context);
    assert.equal(response.status, expected);
  }
});

for (const family of ['policies', 'users']) test(`failed ${family} imports cannot mask an incorrect secret`, async t => {
  const f = await fixture();
  t.mock.method(globalThis, 'fetch', () => { throw new Error('unexpected upstream dispatch'); });
  f.authority.sql.exec(`DELETE FROM ${family === 'policies' ? 'access_policies' : 'access_users'}`);
  f.authority.sql.exec('DELETE FROM policy_binding_meta WHERE meta_key = ?', `${family}_global_initialized`);
  f.env.POLICY_KV.get = async () => { throw new Error('synthetic unavailable KV'); };
  for (const [authorization, expected, code] of [
    ['Bearer clawrouter-live-fixture-incorrect-secret', 401, 'invalid_proxy_key'],
    [headers.authorization, 500, 'internal_error'],
  ]) {
    const response = await worker.fetch(new Request('https://fixture/v1/messages', { method: 'POST', headers: { ...headers, authorization }, body: JSON.stringify({ model: 'anthropic/claude-sonnet-5', messages: [], max_tokens: 16 }) }), f.env, f.context);
    assert.equal(response.status, expected); assert.equal((await response.json()).error.code, code);
  }
});

test("admission stops before pool reads when the supplied secret digest does not match", async () => {
  const { resolveAdmission } = await import("../authority-admission.ts");
  const credential = { credentialId: "kid_one", credential: { enabled: true, secretSha256: "a".repeat(64), policyId: "pool", policyGeneration: "g1", principalId: null } };
  let poolReads = 0, policyReads = 0;
  const store = {
    getCredential: () => credential, getPolicy: () => { policyReads++; return { policyId: "pool", policy: { enabled: true, generation: "g1", providers: ["anthropic"], tenantId: "default" } }; },
    getUser: () => null, hasMeta: () => true, putMeta() {}, seedCredential() {}, seedPolicy() {}, initializeUsers() {}, initializeConnections() {},
    resolveConnections: () => ({ initialized: true, connections: [], missingProviderIds: [] }),
    resolveGrantPool: () => { poolReads++; return { keys: [], states: {}, hasAttachment: false }; },
  };
  const wrong = await resolveAdmission({}, { credentialId: "kid_one", secretSha256: "b".repeat(64), providers: [{ id: "anthropic", tokenRef: "anthropic" }] }, store);
  assert.equal(wrong.policy, null); assert.equal(policyReads, 0); assert.equal(poolReads, 0);
  const right = await resolveAdmission({}, { credentialId: "kid_one", secretSha256: "A".repeat(64), providers: [{ id: "anthropic", tokenRef: "anthropic" }] }, store);
  assert.ok(right.policy); assert.equal(poolReads, 1);
});
