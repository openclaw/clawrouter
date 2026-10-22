import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
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
