import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { inspect } from 'node:util';
import test from 'node:test';
import { createApi } from '../scripts/deploy-train-api.mjs';
import { isolatedNativeTarget } from '../scripts/deploy-native-target.mjs';

const version = '11111111-1111-1111-1111-111111111111';
const privateMarker = 'private-diagnostic-fixture';
const env = { CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), CLOUDFLARE_API_TOKEN: privateMarker, GH_TOKEN: privateMarker };
function safe(error) {
  assert.equal(error.cause, undefined, 'raw causes must not remain attached');
  for (const output of [error.message, JSON.stringify(error), inspect(error, { depth: 10 })]) {
    assert(!output.includes(privateMarker), output);
    assert(!output.includes('127.0.0.1'), output);
    assert(!output.includes('https://'), output);
  }
  return error.diagnostic;
}

test('actual HTTP failures identify the API operation and stage without request/response content or retries', async t => {
  for (const scenario of ['no-headers', 'body-cut', 'invalid-json', 'http', 'api-envelope', 'success']) await t.test(scenario, async t => {
    let calls = 0;
    const server = createServer((req, res) => {
      calls++;
      assert.equal(req.headers.authorization, 'Bearer ' + privateMarker);
      if (scenario === 'no-headers') { req.socket.destroy(); return; }
      res.setHeader('content-type', 'application/json');
      if (scenario === 'body-cut') {
        res.setHeader('content-length', '10000');
        res.write('{"success":true,"result":"' + privateMarker);
        setTimeout(() => res.destroy(), 25);
        return;
      }
      if (scenario === 'invalid-json') { res.end(privateMarker); return; }
      if (scenario === 'http') { res.statusCode = 403; res.end(privateMarker); return; }
      res.end(JSON.stringify(scenario === 'api-envelope' ? { success: false, errors: [{ message: privateMarker }] } : { success: true, result: { accepted: true } }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
    const origin = 'http://127.0.0.1:' + server.address().port;
    const api = createApi({ env, fetchImpl: (url, init) => fetch(origin + new URL(url).pathname, init) });
    if (scenario === 'success') assert.deepEqual(await api.version(version), { accepted: true });
    else await assert.rejects(api.version(version), error => {
      const d = safe(error);
      assert.deepEqual({ service: d.service, method: d.method, operation: d.operation, worker: d.worker, version: d.version },
        { service: 'cloudflare', method: 'GET', operation: 'worker-version', worker: 'selected', version });
      const stage = { 'no-headers': 'fetch', 'body-cut': 'response-body', 'invalid-json': 'response-body', http: 'http', 'api-envelope': 'api-envelope' }[scenario];
      assert.equal(d.stage, stage);
      assert.equal(d.status, scenario === 'no-headers' ? undefined : scenario === 'http' ? 403 : 200);
      assert.equal(error.status, d.status);
      assert(error.message.includes(JSON.stringify(d)), 'the controller persists error.message only');
      if (scenario === 'no-headers' || scenario === 'body-cut') assert(d.failures.some(x => ['UND_ERR_SOCKET', 'ECONNRESET'].includes(x.code)));
      if (scenario === 'invalid-json') assert.equal(d.failures[0].name, 'SyntaxError');
      return true;
    });
    assert.equal(calls, 1);
    t.diagnostic(JSON.stringify({ provider: 'controlled loopback HTTP with Node fetch', scenario, requests: calls, retry: false }));
  });
});

test('nested DNS/TLS/aggregate causes are bounded and allowlisted; arbitrary errors and routes stay private', async () => {
  const leaf = Object.assign(new Error(privateMarker), { code: 'ENOTFOUND', hostname: privateMarker, address: privateMarker });
  const tls = Object.assign(new Error(privateMarker), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
  const unknown = Object.assign(new Error(privateMarker), { name: privateMarker, code: privateMarker });
  const cause = new TypeError(privateMarker, { cause: new AggregateError([leaf, tls, unknown], privateMarker) });
  leaf.cause = cause; // A diagnostic must not loop through a cyclic cause chain.
  let calls = 0;
  const worker = 'clawrouter-native-qualification-012345abcdef';
  const target = isolatedNativeTarget({ worker, origin: 'https://' + worker + '.fixture.workers.dev', account: env.CLOUDFLARE_ACCOUNT_ID });
  const api = createApi({ env, target, fetchImpl: async () => { calls++; throw cause; } });
  await assert.rejects(api.cloudflare('/accounts/' + env.CLOUDFLARE_ACCOUNT_ID + '/workers/scripts/clawrouter-edge/versions/' + version + '?token=' + privateMarker), error => {
    const d = safe(error);
    assert.equal(d.worker, 'production');
    assert.equal(d.operation, 'worker-version');
    assert.deepEqual(d.failures, [{ name: 'TypeError' }, { name: 'AggregateError' }, { name: 'Error', code: 'ENOTFOUND' }, { name: 'Error', code: 'ERR_TLS_CERT_ALTNAME_INVALID' }, { name: 'unknown' }]);
    return true;
  });
  await assert.rejects(api.cloudflare('/' + privateMarker + '?q=' + privateMarker), error => {
    assert.equal(safe(error).operation, 'other');
    return true;
  });
  await assert.rejects(api.github('/' + privateMarker), error => {
    assert.equal(safe(error).service, 'github');
    return true;
  });
  const aggregate = new AggregateError(Array.from({ length: 20 }, () => leaf), privateMarker, { cause });
  const bounded = createApi({ env, fetchImpl: async () => { throw aggregate; } });
  await assert.rejects(bounded.latest(), error => { assert(safe(error).failures.length <= 8); return true; });
  assert.equal(calls, 3);
});

test('a transport failure does not replay a direct mutation and retains its method', async () => {
  let calls = 0;
  const api = createApi({ env, fetchImpl: async () => { calls++; throw new DOMException(privateMarker, 'TimeoutError'); } });
  await assert.rejects(api.cloudflare(api.workerPath + '/deployments', { method: 'POST', body: { private: privateMarker } }), error => {
    const d = safe(error);
    assert.equal(d.operation, 'worker-deployments');
    assert.equal(d.method, 'POST');
    assert.equal(d.stage, 'fetch');
    assert.deepEqual(d.failures, [{ name: 'TimeoutError' }]);
    return true;
  });
  assert.equal(calls, 1);
});

test('HTTP status remains available even if error-body cancellation fails', async () => {
  const api = createApi({ env, fetchImpl: async () => ({ ok: false, status: 403, body: { cancel: async () => { throw new Error(privateMarker); } } }) });
  await assert.rejects(api.latest(), error => {
    const d = safe(error);
    assert.equal(d.operation, 'worker-deployments');
    assert.equal(d.stage, 'http');
    assert.equal(error.status, 403);
    assert.equal(d.failures, undefined);
    return true;
  });
});
