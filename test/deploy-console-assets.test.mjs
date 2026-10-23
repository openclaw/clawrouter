import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:http';
import test from 'node:test';
import { assertAssetBootstrap, publishConsoleAssets, verifyConsoleAssets } from '../scripts/deploy-console-assets.mjs';

test('publish both colors as immutable shared bytes; retry readback, never overwrite a collision', async (t) => {
  mkdirSync('.artifacts', { recursive: true });
  const directory = mkdtempSync(join(process.cwd(), '.artifacts/console-assets-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, 'index-Green123.js'), 'green JavaScript');
  const objects = new Map(), writes = [];
  let loseReply = true;
  const options = { directory, log() {}, env: { CLOUDFLARE_ACCOUNT_ID: 'fixture', CLOUDFLARE_API_TOKEN: 'fixture' }, fetchImpl: async (url, init) => {
    assert.equal(init.redirect, 'error');
    const key = new URL(url).pathname;
    assert.match(key, /objects\/console-assets\/v1\/assets\/index-Green123.js$/);
    if (init.method === 'PUT') {
      writes.push(key); objects.set(key, Buffer.from(init.body));
      assert.equal(init.headers['content-type'], 'text/javascript');
      if (loseReply) { loseReply = false; throw new Error('lost reply'); }
      return new Response(null);
    }
    return objects.has(key) ? new Response(objects.get(key)) : new Response(null, { status: 404 });
  } };
  const first = await publishConsoleAssets(options);
  assert.equal(first[0].bytes, 16);
  assert.equal(writes.length, 1);
  assert.deepEqual(await publishConsoleAssets(options), first);
  assert.equal(writes.length, 1, 'existing exact bytes are reused');
  writeFileSync(join(directory, 'index-Green123.js'), 'different content');
  await assert.rejects(publishConsoleAssets(options), /collision/);
  assert.equal(writes.length, 1);
  writeFileSync(join(directory, 'index-Green123.js'), 'green JavaScript');
  writeFileSync(join(directory, 'secrets.json'), 'not public');
  await assert.rejects(publishConsoleAssets(options), /unsupported/);
});


test('asset smoke validates actual version and bytes, including the R2-only probe', async () => {
  const bytes = Buffer.from('shared probe'), version = 'green';
  const assets = [{ path: '/assets/train-probe-12345678.js', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), probe: true }];
  const options = { assets, baseUrl: 'https://router.example', version, fetchImpl: async (_url, init) => {
    assert.equal(init.headers['Cloudflare-Workers-Version-Overrides'], 'clawrouter-edge="green"');
    return new Response(bytes, { headers: { 'x-clawrouter-version-id': 'green' } });
  } };
  await verifyConsoleAssets(options);
  await assert.rejects(verifyConsoleAssets({ ...options, fetchImpl: async () => new Response(bytes, { headers: { 'x-clawrouter-version-id': 'blue' } }) }), /response failed/);
  await assert.rejects(verifyConsoleAssets({ ...options, fetchImpl: async () => new Response('wrong bytes', { headers: { 'x-clawrouter-version-id': 'green' } }) }), /bytes differ/);
  await assert.rejects(verifyConsoleAssets({ ...options, fetchImpl: async () => new Response(null, { status: 404 }) }), /response failed/);
});

const blue = '11111111-1111-1111-1111-111111111111';
const green = '22222222-2222-2222-2222-222222222222';
function assetFixture() {
  const bytes = Buffer.from('shared console asset');
  const asset = { path: '/assets/index-Fixture123.js', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  let time = 0;
  const waits = [], logs = [];
  return { bytes, asset, waits, logs, options: {
    assets: [asset], baseUrl: 'https://router.example', version: green,
    readinessTimeoutMs: 2_000, now: () => time,
    wait: async ms => { waits.push(ms); time += ms; }, log: message => logs.push(message),
  } };
}

test('an asset override can converge after health; only exact-version bytes pass', async () => {
  const f = assetFixture();
  const responses = [
    new Response(f.bytes, { headers: { 'x-clawrouter-version-id': blue } }),
    new Response(f.bytes, { headers: { 'x-clawrouter-version-id': green } }),
  ];
  let calls = 0;
  await verifyConsoleAssets({ ...f.options, fetchImpl: async (url, init) => {
    assert.equal(url, 'https://router.example' + f.asset.path);
    assert.equal(init.method ?? 'GET', 'GET');
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers['Cloudflare-Workers-Version-Overrides'], `clawrouter-edge="${green}"`);
    return responses[calls++];
  } });
  assert.equal(calls, 2);
  assert.equal(responses[0].bodyUsed, true, 'discard the unselected response');
  assert.deepEqual(f.waits, [1_000]);
  assert.match(f.logs[0], /version_mismatch/);
});

test('persistent fallback fails within the readiness budget with actionable metadata', async () => {
  const f = assetFixture();
  let calls = 0;
  await assert.rejects(verifyConsoleAssets({ ...f.options, fetchImpl: async () => {
    calls++;
    return new Response(f.bytes, { headers: { 'x-clawrouter-version-id': blue } });
  } }), error => {
    assert.match(error.message, /response failed/);
    assert.match(error.message, /version_mismatch/);
    assert.match(error.message, /readiness_timeout/);
    assert.match(error.message, /index-Fixture123.js/);
    assert.match(error.message, new RegExp(green));
    assert.match(error.message, new RegExp(blue));
    assert.match(error.message, /"status":200/);
    return true;
  });
  assert.equal(calls, 2);
  assert.deepEqual(f.waits, [1_000, 1_000]);
});

test('selected-version HTTP and byte failures stay fatal and never log response bodies', async () => {
  for (const status of [404, 503]) {
    const f = assetFixture();
    let calls = 0;
    await assert.rejects(verifyConsoleAssets({ ...f.options, fetchImpl: async () => {
      calls++;
      return new Response('fixture private error body', { status, headers: { 'x-clawrouter-version-id': green } });
    } }), error => {
      assert.match(error.message, new RegExp(`"status":${status}`));
      assert.match(error.message, /http_status/);
      assert.match(error.message, /index-Fixture123.js/);
      assert.doesNotMatch(error.message, /fixture private error body/);
      return true;
    });
    assert.equal(calls, 1);
    assert.deepEqual(f.waits, []);
  }
  const f = assetFixture();
  await assert.rejects(verifyConsoleAssets({ ...f.options, fetchImpl: async () => new Response('fixture private bytes', { headers: { 'x-clawrouter-version-id': green } }) }), error => {
    assert.match(error.message, /bytes differ/);
    assert.match(error.message, /index-Fixture123.js/);
    assert.match(error.message, /expectedSha256/);
    assert.doesNotMatch(error.message, /fixture private bytes/);
    return true;
  });
  assert.deepEqual(f.waits, []);
});

test('missing version proof and network failures retain safe diagnostics without retry', async () => {
  const f = assetFixture();
  await assert.rejects(verifyConsoleAssets({ ...f.options, fetchImpl: async () => new Response(f.bytes) }), error => {
    assert.match(error.message, /"actualVersion":null/);
    assert.match(error.message, /version_mismatch/);
    return true;
  });
  await assert.rejects(verifyConsoleAssets({ ...f.options, fetchImpl: async () => { throw new Error('fixture secret in transport error'); } }), error => {
    assert.match(error.message, /request_failed/);
    assert.match(error.message, /index-Fixture123.js/);
    assert.doesNotMatch(error.message, /fixture secret/);
    return true;
  });
  assert.deepEqual(f.waits, []);
});

test('a selected-version asset with a stalled body is bounded by the request deadline', { timeout: 3_000 }, async t => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'x-clawrouter-version-id': green });
    response.write('unfinished fixture content');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const f = assetFixture();
  await assert.rejects(verifyConsoleAssets({ assets: [f.asset], baseUrl: `http://127.0.0.1:${server.address().port}`, version: green, readinessTimeoutMs: 500 }), error => {
    assert.match(error.message, /body_read_failed/);
    assert.match(error.message, /"status":200/);
    assert.doesNotMatch(error.message, /unfinished fixture content/);
    return true;
  });
});

test('diagnostics reject private paths and redact malformed version headers', async () => {
  const f = assetFixture();
  await assert.rejects(verifyConsoleAssets({ ...f.options, assets: [{ ...f.asset, path: '/assets/fixture.js?private=fixture-only-secret' }], fetchImpl: async () => assert.fail('invalid path must not dispatch') }), error => {
    assert.match(error.message, /Invalid console asset receipt path/);
    assert.doesNotMatch(error.message, /fixture-only-secret/);
    return true;
  });
  await assert.rejects(verifyConsoleAssets({ ...f.options, fetchImpl: async () => new Response(f.bytes, { headers: { 'x-clawrouter-version-id': 'fixture-only-secret' } }) }), error => {
    assert.match(error.message, /"actualVersion":"invalid"/);
    assert.doesNotMatch(error.message, /fixture-only-secret/);
    return true;
  });
  assert.deepEqual(f.waits, []);
});

test('legacy bootstrap refuses changed asset inputs until both versions support shared assets', (t) => {
  mkdirSync('.artifacts', { recursive: true });
  const directory = mkdtempSync(join(process.cwd(), '.artifacts/asset-source-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: directory, encoding: 'utf8' }).trim();
  git('init', '-q'); mkdirSync(join(directory, 'admin'));
  writeFileSync(join(directory, 'admin/index.html'), 'old'); git('add', '.'); git('commit', '-qm', 'blue');
  const blue = git('rev-parse', 'HEAD');
  assert.doesNotThrow(() => assertAssetBootstrap(blue, directory));
  writeFileSync(join(directory, 'admin/index.html'), 'new'); git('add', '.'); git('commit', '-qm', 'green');
  assert.throws(() => assertAssetBootstrap(blue, directory), /Legacy blue/);
  mkdirSync(join(directory, 'worker')); writeFileSync(join(directory, 'worker/console-assets.ts'), 'fixture protocol present'); git('add', '.'); git('commit', '-qm', 'protocol');
  const capable = git('rev-parse', 'HEAD');
  writeFileSync(join(directory, 'admin/index.html'), 'newer'); git('add', '.'); git('commit', '-qm', 'next green');
  assert.doesNotThrow(() => assertAssetBootstrap(capable, directory));
});
