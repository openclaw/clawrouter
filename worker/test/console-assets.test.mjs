import './typescript-setup.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
const { default: worker } = await import('../index.ts');
const call = (path, env) => worker.fetch(new Request(`https://example.com${path}`), env, { waitUntil() {} });

test('a blue Worker serves green hashed assets without exposing retained R2 content', async () => {
  const reads = [];
  const env = { CF_VERSION_METADATA: { id: 'blue' }, ASSETS: { fetch: async () => new Response('not in blue', { status: 404 }) }, CONTENT_ARCHIVE: { get: async (key) => {
    reads.push(key);
    return { body: 'green JavaScript', httpEtag: '"green-hash"', writeHttpMetadata: (h) => h.set('content-type', 'text/javascript') };
  } } };
  const response = await call('/assets/index-Green123.js', env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-clawrouter-version-id'), 'blue');
  assert.equal(response.headers.get('content-type'), 'text/javascript');
  assert.equal(response.headers.get('etag'), '"green-hash"');
  assert.equal(await response.text(), 'green JavaScript');
  assert.deepEqual(reads, ['console-assets/v1/assets/index-Green123.js']);
  for (const path of ['/assets/v1/private', '/assets/index-Green123.js.map', '/assets/secret.json', '/assets/index%2fGreen123.js']) assert.equal((await call(path, env)).status, 404);
  assert.equal(reads.length, 1, 'untrusted paths cannot read arbitrary bucket objects');
});

test('local asset success, missing shared object and self-host without R2 preserve responses', async () => {
  const local = { ASSETS: { fetch: async () => new Response('own version') }, CONTENT_ARCHIVE: { get: async () => { throw new Error('must not read storage'); } } };
  assert.equal(await (await call('/assets/index-Green123.js', local)).text(), 'own version');
  for (const CONTENT_ARCHIVE of [undefined, { get: async () => null }]) {
    const response = await call('/assets/index-Green123.js', { ASSETS: { fetch: async () => new Response('absent', { status: 404 }) }, CONTENT_ARCHIVE });
    assert.equal(response.status, 404); assert.equal(await response.text(), 'absent');
  }
});
