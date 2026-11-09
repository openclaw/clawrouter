import assert from 'node:assert/strict';
import test from 'node:test';
import './typescript-setup.mjs';
import { accessBytesResponse } from './access-byte-fixture.mjs';
import { usageEnv } from './usage-budget-fixture.mjs';
import { fixture as credentialFixture } from './credential-fixture.mjs';

const { authenticateProxyKey, inspectKey } = await import('../proxy-auth.ts');
const { isIdentityFailure } = await import('../identity-admission.ts');
const { default: worker } = await import('../index.ts');
const names = ['authorization', 'x-api-key', 'x-goog-api-key', 'api-key'];
const key = 'clawrouter-live-fixture-abcdefgh';

function fixture(t, { wrong = false } = {}) {
  const counters = { hashes: [], lookups: [], provider: 0 };
  const originalDigest = crypto.subtle.digest;
  t.mock.method(crypto.subtle, 'digest', function (algorithm, bytes) {
    counters.hashes.push(bytes.byteLength);
    return Reflect.apply(originalDigest, this, [algorithm, bytes]);
  });
  const env = usageEnv([]);
  env.CLAWROUTER_HOT_CACHE_MAX_AGE_SECONDS = '0';
  env.ACCESS_CONTROL = {
    idFromName: name => name,
    get: () => ({ async fetch(url, init) {
      assert.equal(new URL(url).pathname, '/admission/resolve');
      const body = JSON.parse(init.body); counters.lookups.push(body.credentialId);
      return accessBytesResponse(JSON.stringify({
        credential: { credentialId: body.credentialId, credential: {
          enabled: true, secretSha256: wrong ? '00'.repeat(32) : body.secretSha256,
          policyId: 'fixture', policyGeneration: 'g1',
        } },
        policy: { policyId: 'fixture', policy: { enabled: true, generation: 'g1', providers: [], retainRequestContent: false } },
        owner: null, connections: [], pools: {},
      }), '');
    } }),
  };
  t.mock.method(globalThis, 'fetch', () => { counters.provider++; throw Error('unexpected provider dispatch'); });
  return { env, counters };
}

function observedHeaders(t, values) {
  const headers = new Headers(values), examined = [], original = headers.get;
  t.mock.method(headers, 'get', function (name) { examined.push(name); return Reflect.apply(original, this, [name]); });
  return { headers, examined };
}

// One finite public operation owns its original request, one body consumption,
// and every accepted background promise. Promise identity is origin identity.
async function withPublicResponse(t, dispatch, verify) {
  const roots = [], byOriginal = new Map();
  let requestRoot, bodyRoot, cleanup, closed = false, reported = false;
  let hasPrimary = false, primary, primaryOrigin;
  const observe = original => {
    const existing = byOriginal.get(original);
    if (existing) return existing;
    assert.equal(closed, false, 'background enrollment after all owned producers settled');
    const root = { result: undefined, outcome: undefined };
    byOriginal.set(original, root); roots.push(root);
    root.outcome = Promise.resolve(original).then(
      value => (root.result = { failed: false, value }),
      error => (root.result = { failed: true, error }));
    return root;
  };
  const start = invoke => {
    let original;
    try { original = invoke(); } catch (error) { original = Promise.reject(error); }
    return observe(original);
  };
  const consume = response => bodyRoot ??= start(() => response.json());
  const read = async root => {
    const result = await root.outcome;
    if (result.failed) {
      hasPrimary = true; primary = result.error; primaryOrigin = root;
      throw result.error;
    }
    return result.value;
  };
  const finish = () => cleanup ??= (async () => {
    for (let index = 0; index < roots.length; index++) {
      const root = roots[index], result = await root.outcome;
      // Teardown still consumes a fulfilled request if the driver never did.
      if (root === requestRoot && !result.failed) consume(result.value);
    }
    closed = true;
  })();
  const report = () => {
    if (reported) return;
    reported = true;
    const failures = roots.filter(root => root !== primaryOrigin && root.result.failed).map(root => root.result.error);
    if (failures.length) throw new AggregateError([...(hasPrimary ? [primary] : []), ...failures], 'public fixture roots failed');
    if (hasPrimary) throw primary;
  };
  // Register before invoking any request. The normal path joins before returning,
  // keeping test mocks installed; teardown joins the same cleanup, never replays it.
  t.after(async () => { await finish(); report(); });
  try {
    requestRoot = start(() => dispatch({ waitUntil(original) { observe(original); } }));
    const response = await read(requestRoot), body = await read(consume(response));
    await finish();
    const failed = roots.find(root => root.result.failed);
    if (failed) await read(failed);
    await verify(response, body);
  } catch (error) { if (!hasPrimary) { hasPrimary = true; primary = error; } }
  finally { await finish(); }
  report();
}

for (const prefix of ['clawrouter-live-', 'clawrouter-test-', 'ocpk_live_', 'ocpk_test_']) {
  test(`exact raw 4096 admits unchanged ${prefix} grammar`, async t => {
    const f = fixture(t), delimiter = prefix.startsWith('ocpk') ? '_' : '-';
    const stem = `${prefix}fixture${delimiter}`, secret = 'a'.repeat(4096 - stem.length);
    const { headers, examined } = observedHeaders(t, { 'x-api-key': stem + secret, 'api-key': 'x'.repeat(4097) });
    const auth = await authenticateProxyKey(headers, f.env);
    assert.ok(!(auth instanceof Response)); assert.equal(auth.credentialId, 'fixture');
    assert.deepEqual(examined, names.slice(0, 2));
    assert.deepEqual(f.counters, { hashes: [secret.length], lookups: ['fixture'], provider: 0 });
  });
}

for (const index of [0, 1, 2, 3]) {
  test(`raw +1 at candidate ${index + 1} denies before normalization, parser, hash or lookup`, async t => {
    const f = fixture(t), values = Object.fromEntries(names.slice(0, index).map(name => [name, '!'.repeat(4096)]));
    const oversized = index === 0 ? `Bearer ${key}${'a'.repeat(4097 - 7 - key.length)}` : 'x'.repeat(4097);
    values[names[index]] = oversized;
    if (index < 3) values[names[index + 1]] = key;
    const { headers, examined } = observedHeaders(t, values);
    let replacements = 0, parserEntries = 0;
    const replace = String.prototype.replace, startsWith = String.prototype.startsWith;
    t.mock.method(String.prototype, 'replace', function (...args) { if (this === oversized) replacements++; return Reflect.apply(replace, this, args); });
    t.mock.method(String.prototype, 'startsWith', function (...args) { if (this === oversized) parserEntries++; return Reflect.apply(startsWith, this, args); });
    await assert.rejects(authenticateProxyKey(headers, f.env), error => {
      assert.ok(isIdentityFailure(error)); assert.equal(error.status, 503); assert.equal(error.code, 'identity_admission_unavailable');
      return true;
    });
    assert.deepEqual(examined, names.slice(0, index + 1));
    assert.equal(replacements, 0); assert.equal(parserEntries, 0);
    assert.deepEqual(f.counters, { hashes: [], lookups: [], provider: 0 });
  });
}

test('Bearer spelling and internal whitespace count toward the raw limit before removal', async t => {
  const f = fixture(t), prefix = 'bEaReR \t  ', raw = prefix + key + 'a'.repeat(4096 - prefix.length - key.length);
  assert.equal(raw.length, 4096);
  const auth = await authenticateProxyKey(new Headers({ authorization: raw }), f.env);
  assert.ok(!(auth instanceof Response)); assert.equal(f.counters.hashes.length, 1);
  assert.equal(f.counters.hashes[0], 4096 - prefix.length - 'clawrouter-live-fixture-'.length);
  const before = structuredClone(f.counters);
  await assert.rejects(authenticateProxyKey(new Headers({ authorization: raw + 'a' }), f.env), isIdentityFailure);
  assert.deepEqual(f.counters, before);
});

test('four exact-limit malformed raw values examine at most 16384 units and remain 401', async t => {
  const f = fixture(t), { headers, examined } = observedHeaders(t, Object.fromEntries(names.map(name => [name, '!'.repeat(4096)])));
  const response = await authenticateProxyKey(headers, f.env);
  assert.equal(response.status, 401); assert.equal((await response.json()).error.code, 'invalid_proxy_key');
  assert.deepEqual(examined, names); assert.deepEqual(f.counters, { hashes: [], lookups: [], provider: 0 });
});

for (const index of [0, 1, 2, 3]) test(`candidate ${index + 1} selection stops all lower header reads`, async t => {
  const f = fixture(t), values = Object.fromEntries(names.map((name, i) => [name, i < index ? 'invalid' : i === index ? key : 'x'.repeat(4097)]));
  const { headers, examined } = observedHeaders(t, values);
  const auth = await authenticateProxyKey(headers, f.env);
  assert.ok(!(auth instanceof Response)); assert.deepEqual(examined, names.slice(0, index + 1));
  assert.deepEqual(f.counters.lookups, ['fixture']); assert.equal(f.counters.hashes.length, 1);
});

test('wrong selected secret never authenticates a lower syntactically valid key', async t => {
  const f = fixture(t, { wrong: true });
  const { headers, examined } = observedHeaders(t, { authorization: `Bearer ${key}`, 'x-api-key': 'ocpk_test_lower_abcdefgh' });
  const response = await authenticateProxyKey(headers, f.env);
  assert.equal(response.status, 401); assert.equal((await response.json()).error.code, 'invalid_proxy_key');
  assert.deepEqual(examined, ['authorization']); assert.deepEqual(f.counters.lookups, ['fixture']);
  assert.equal(f.counters.hashes.length, 1); assert.equal(f.counters.provider, 0);
});

test('inspect uses one sequential selection and the selected legacy mode', async t => {
  const f = fixture(t), { headers, examined } = observedHeaders(t, { 'api-key': 'ocpk_test_fixture_abcdefgh' });
  const response = await inspectKey(headers, f.env), body = await response.json();
  assert.equal(response.status, 200); assert.equal(body.kid, 'fixture'); assert.equal(body.mode, 'test');
  assert.deepEqual(examined, names); assert.equal(f.counters.hashes.length, 1); assert.deepEqual(f.counters.lookups, ['fixture']);
});

for (const [path, model, anthropic] of [['/v1/messages', 'anthropic/claude-haiku-4-5', true], ['/v1/chat/completions', 'openai/gpt-6-astra', false]]) {
  for (const oversized of [false, true]) test(`actual public ${path} preserves native ${oversized ? 503 : 401} classification`, async t => {
    const f = fixture(t), header = oversized ? 'x'.repeat(4097) : 'fixture-malformed-input';
    await withPublicResponse(t, context => worker.fetch(new Request(`https://router.example${path}`, { method: 'POST',
      headers: { authorization: header, 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'fixture' }], max_tokens: 8 }),
    }), f.env, context), async (response, body) => {
      assert.equal(response.status, oversized ? 503 : 401);
      const code = oversized ? 'identity_admission_unavailable' : 'invalid_proxy_key';
      assert.equal(response.headers.get('x-clawrouter-error-code'), code);
      if (anthropic) { assert.equal(body.type, 'error'); assert.equal(body.error.type, oversized ? 'api_error' : 'authentication_error'); assert.ok(!Object.hasOwn(body.error, 'code')); }
      else assert.equal(body.error.code, code);
      assert.ok(body.error.message.length > 0); assert.ok(!JSON.stringify(body).includes(header));
      assert.deepEqual(f.counters, { hashes: [], lookups: [], provider: 0 });
    });
  });
}

for (const size of [4096, 4097]) test(`raw Latin-1 ${size} is measured in UTF-16 units, not encoded bytes`, async t => {
  const f = fixture(t), headers = new Headers({ 'x-api-key': 'é'.repeat(size) });
  if (size === 4097) await assert.rejects(authenticateProxyKey(headers, f.env), isIdentityFailure);
  else await withPublicResponse(t, () => authenticateProxyKey(headers, f.env), async response => {
    assert.equal(response.status, 401);
  });
  assert.deepEqual(f.counters, { hashes: [], lookups: [], provider: 0 });
});

for (const path of ['/v1/catalog', '/v1/models', '/v1/pool']) {
  for (const scenario of ['missing', 'ordinary', 'malformed-marker', 'oversized', 'selected']) {
    test(`${path} bounded intent preserves ${scenario} Access precedence`, async t => {
      const env = await credentialFixture(t, [], { held: false });
      env.CLAWROUTER_HOT_CACHE_MAX_AGE_SECONDS = '0';
      const cookie = await env.cookie();
      const counts = { access: 0, admission: 0, hashes: 0, provider: 0 };
      const kvGet = env.POLICY_KV.get;
      t.mock.method(env.POLICY_KV, 'get', function (key, ...args) {
        if (typeof key === 'string' && key.startsWith('local/sessions/')) counts.access++;
        return Reflect.apply(kvGet, this, [key, ...args]);
      });
      const authorityGet = env.ACCESS_CONTROL.get;
      t.mock.method(env.ACCESS_CONTROL, 'get', function (...args) {
        const stub = Reflect.apply(authorityGet, this, args), fetch = stub.fetch;
        return { fetch(url, init) {
          if (new URL(url).pathname === '/admission/resolve') counts.admission++;
          return Reflect.apply(fetch, stub, [url, init]);
        } };
      });
      const digest = crypto.subtle.digest;
      t.mock.method(crypto.subtle, 'digest', function (...args) { counts.hashes++; return Reflect.apply(digest, this, args); });
      t.mock.method(globalThis, 'fetch', () => { counts.provider++; throw Error('unexpected provider dispatch'); });
      const headers = new Headers({ cookie });
      if (scenario === 'ordinary') headers.set('authorization', 'Bearer ordinary-non-proxy-token');
      if (scenario === 'malformed-marker') headers.set('authorization', 'clawrouter-malformed');
      if (scenario === 'oversized') { headers.set('authorization', 'x'.repeat(4097)); headers.set('x-api-key', key); }
      if (scenario === 'selected') { headers.set('authorization', `Bearer ${key}`); headers.set('x-api-key', 'x'.repeat(4097)); }
      await withPublicResponse(t, context => worker.fetch(new Request(`https://router.example${path}`, { headers }), env, context), async (response, body) => {
        assert.equal(counts.provider, 0);
        if (scenario === 'missing' || scenario === 'ordinary') {
          assert.equal(counts.access, 1); assert.equal(counts.admission, 0);
          assert.equal(response.status, path === '/v1/pool' ? 403 : 200);
          if (path === '/v1/pool') assert.equal(body.error.code, 'access_policy_required');
          else if (path === '/v1/catalog') assert.equal(body.scope.authType, 'access');
          else assert.deepEqual(body.data, []);
        } else {
          assert.equal(counts.access, 0);
          assert.equal(response.status, scenario === 'oversized' ? 503 : 401);
          assert.equal(body.error.code, scenario === 'oversized' ? 'identity_admission_unavailable'
            : scenario === 'selected' ? 'unknown_proxy_key' : 'invalid_proxy_key');
          assert.equal(counts.admission, scenario === 'selected' ? 1 : 0);
          assert.equal(counts.hashes, scenario === 'selected' ? 1 : 0);
        }
      });
    });
  }
}

for (const failure of ['throw', 'reject']) test(`finite public cleanup preserves ${failure} undefined and every independent late root`, async t => {
  const shared = new Error('synthetic independent root failure');
  let lateJoined = false, verified = false;
  await assert.rejects(withPublicResponse(t, context => {
    const first = Promise.reject(shared);
    context.waitUntil(first); context.waitUntil(first); // One origin, accepted twice.
    context.waitUntil(Promise.reject(shared)); // Same reason, independent origin.
    context.waitUntil(Promise.resolve().then(async () => {
      await Promise.resolve();
      context.waitUntil(Promise.resolve().then(() => { lateJoined = true; throw undefined; }));
    }));
    if (failure === 'throw') throw undefined;
    return Promise.reject(undefined);
  }, () => { verified = true; }), error => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [undefined, shared, shared, undefined]);
    assert.equal(error.errors[1], shared); assert.equal(error.errors[2], shared);
    return true;
  });
  assert.equal(lateJoined, true); assert.equal(verified, false);
});

test('memoized original body rejection is counted once when also accepted by waitUntil', async t => {
  let consumed = 0;
  await assert.rejects(withPublicResponse(t, context => {
    context.waitUntil(Promise.reject(undefined));
    const response = new Response(null);
    t.mock.method(response, 'json', () => {
      consumed++;
      const original = Promise.reject(undefined);
      context.waitUntil(original); return original;
    });
    return Promise.resolve(response);
  }, () => assert.fail('rejected body cannot reach assertions')), error => {
    assert.ok(error instanceof AggregateError); assert.deepEqual(error.errors, [undefined, undefined]);
    return true;
  });
  assert.equal(consumed, 1);
});

test('assertion failure including undefined follows complete request/body/child joins with mocks active', async t => {
  let consumed = 0, childJoined = false, caught = false;
  const response = Response.json({ fixture: true }), json = response.json;
  t.mock.method(response, 'json', function (...args) { consumed++; return Reflect.apply(json, this, args); });
  try {
    await withPublicResponse(t, context => {
      context.waitUntil(Promise.resolve().then(() => {
        context.waitUntil(Promise.resolve().then(() => { childJoined = true; }));
      }));
      return Promise.resolve(response);
    }, (_response, body) => {
      assert.deepEqual(body, { fixture: true }); assert.equal(childJoined, true); assert.equal(consumed, 1);
      throw undefined;
    });
  } catch (error) { caught = true; assert.equal(error, undefined); }
  assert.equal(caught, true); assert.equal(consumed, 1); assert.equal(response.bodyUsed, true);
});
