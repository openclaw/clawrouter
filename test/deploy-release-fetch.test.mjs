import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import test from 'node:test';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const preload = new URL('./helpers/deploy-release-fetch.mjs', import.meta.url).href;
const origin = 'https://clawrouter-native-qualification-012345abcdef.fixture.workers.dev';
function child(source, targets) {
  const env = { PATH: process.env.PATH };
  if (targets !== undefined) env.CLAWROUTER_RELEASE_PROOF_TARGETS = JSON.stringify(targets);
  return exec(process.execPath, ['--import=' + preload, '--input-type=module', '--eval', source], { env, timeout: 15_000 });
}

test('static proof preload forwards actual HTTP while refusing foreign origins and redirects', async t => {
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ url: req.url, method: req.method, marker: req.headers['x-proof-marker'], body });
    if (req.url === '/redirect') {
      res.writeHead(302, { location: 'https://example.invalid/forbidden' });
      res.end();
    } else res.end('controlled');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const local = 'http://127.0.0.1:' + server.address().port;
  await child(`
    import assert from 'node:assert/strict';
    const { origin, local } = JSON.parse(process.env.CLAWROUTER_RELEASE_PROOF_TARGETS);
    for (const base of ['https://api.cloudflare.com', origin, local]) {
      const request = new Request(base + '/probe?value=%22%3C%2Fscript%3E', {
        method: 'POST', headers: { 'x-proof-marker': 'literal-data' }, body: '"</script>\u2028\u2029',
      });
      assert.equal(await (await fetch(request)).text(), 'controlled');
    }
    for (const base of ['https://example.invalid', 'https://api.cloudflare.com.example.invalid', 'http://127.0.0.1:9'])
      await assert.rejects(async () => fetch(base + '/forbidden'), /External egress refused/);
    await assert.rejects(fetch(origin + '/redirect'), /fetch failed/);
  `, { origin, local });
  assert.equal(requests.length, 4, 'denied origins never reach even the local fixture');
  for (const request of requests.slice(0, 3)) assert.deepEqual(request, {
    url: '/probe?value=%22%3C%2Fscript%3E', method: 'POST', marker: 'literal-data', body: '"</script>\u2028\u2029',
  });
  assert.equal(requests[3].url, '/redirect');
});

test('missing or invalid proof target data fails before the child program runs', async () => {
  for (const targets of [undefined, null, {},
    { origin, local: 'https://example.invalid' },
    { origin, local: 'http://127.0.0.1:1234/path' },
    { origin: origin + '/path', local: 'http://127.0.0.1:1234' },
    { origin: 'https://example.invalid', local: 'http://127.0.0.1:1234' },
    { origin: origin + "';console.log('injected');//", local: 'http://127.0.0.1:1234' },
  ]) await assert.rejects(child("console.log('program-ran')", targets), error => {
    assert.match(error.stderr, /Missing release proof targets|Invalid release proof targets|Invalid URL/);
    assert.equal(error.stdout, '');
    return true;
  });
});
