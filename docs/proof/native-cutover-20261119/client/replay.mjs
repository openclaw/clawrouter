import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {isAbsolute} from 'node:path';
import OpenAI from 'openai';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const output = process.argv[2];
assert(output && isAbsolute(output), 'Provide a fresh absolute receipt path');
const captured = JSON.parse(await readFile(new URL('../LOSS-RESPONSE.json', import.meta.url), 'utf8'));
const body = Buffer.from(captured.bodyBase64, 'base64');
assert.equal(captured.syntheticOnly, true);
assert.equal(captured.status, 200);
assert.equal(captured.bodyComplete, true);
assert.equal(captured.captureComplete, true);
assert.equal(captured.jsonValid, false);
assert.equal(body.length, captured.retainedBytes);
assert.equal(hash(body), captured.bodySha256);
assert.throws(() => JSON.parse(body.toString('utf8')), SyntaxError);

const sdk = JSON.parse(await readFile(new URL('./node_modules/openai/package.json', import.meta.url), 'utf8'));
const lock = JSON.parse(await readFile(new URL('./package-lock.json', import.meta.url), 'utf8'));
assert.equal(sdk.version, lock.packages['node_modules/openai'].version);
const requests = [], fetches = [], serverErrors = [];
const expectedText = 'distinct local control completed';
const valid = {
  id: 'resp_local_control', object: 'response', status: 'completed', model: 'local-proof-model',
  output: [{id: 'msg_local_control', type: 'message', role: 'assistant', status: 'completed',
    content: [{type: 'output_text', text: expectedText, annotations: []}]}],
  usage: {input_tokens: 1, output_tokens: 1, total_tokens: 2},
};
const server = createServer(async (req, res) => {
  try {
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/v1/responses');
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; assert(size < 65536); chunks.push(chunk); }
    const bytes = Buffer.concat(chunks), input = JSON.parse(bytes.toString('utf8'));
    assert.equal(input.stream, false);
    assert(['captured-loss-request', 'distinct-positive-control'].includes(input.input));
    requests.push({operation: input.input, bodySha256: hash(bytes), retryHeader: req.headers['x-stainless-retry-count'] ?? null});
    // A clean HTTP framing terminator is intentional. No content-length mismatch,
    // retry-suppression header, synthetic disconnect or SDK parser replacement.
    res.writeHead(200, {'content-type': 'application/json', 'transfer-encoding': 'chunked'});
    res.end(input.input === 'captured-loss-request' ? body : JSON.stringify(valid));
  } catch (error) {
    serverErrors.push(error.name);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
});
let listening = false, closed = false, defaultMaxRetries, malformed, positive, failure;
try {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { listening = true; resolve(); });
  });
  const origin = 'http://127.0.0.1:' + server.address().port;
  const client = new OpenAI({
    apiKey: 'local-only-placeholder', baseURL: origin + '/v1', timeout: 5000,
    fetch: async (url, init) => {
      const parsed = new URL(url);
      assert.equal(parsed.origin, origin, 'Non-loopback SDK egress refused');
      assert.equal(parsed.pathname, '/v1/responses');
      assert.equal(init.method, 'POST');
      fetches.push({method: init.method, path: parsed.pathname});
      return fetch(url, {...init, redirect: 'error'});
    },
  });
  defaultMaxRetries = client.maxRetries;
  assert.equal(defaultMaxRetries, 2, 'The representative retry defaults changed; inspect before interpreting');
  const started = Date.now();
  let returned = false, observedError;
  try {
    await client.responses.create({model: 'local-proof-model', input: 'captured-loss-request', stream: false});
    returned = true;
  } catch (error) { observedError = error; }
  malformed = {rejected: !returned && observedError !== undefined, successfulResult: returned,
    errorName: observedError?.name ?? null, syntaxError: observedError instanceof SyntaxError,
    durationMs: Date.now() - started,
    serverRequests: requests.filter(r => r.operation === 'captured-loss-request').length,
    fetchInvocations: fetches.length};
  assert.equal(returned, false);
  assert(observedError instanceof SyntaxError);
  assert.equal(malformed.serverRequests, 1);
  assert.equal(malformed.fetchInvocations, 1);
  const result = await client.responses.create({model: 'local-proof-model', input: 'distinct-positive-control', stream: false});
  positive = {completed: result.status === 'completed', expectedOutput: result.output_text === expectedText,
    serverRequests: requests.filter(r => r.operation === 'distinct-positive-control').length};
  assert(positive.completed && positive.expectedOutput);
  assert.equal(positive.serverRequests, 1);
  assert.equal(requests.length, 2);
  assert.equal(fetches.length, 2);
  assert.equal(new Set(requests.map(r => r.bodySha256)).size, 2, 'Control must be a distinct operation');
  assert.deepEqual(serverErrors, []);
} catch (error) { failure = {name: error.name, code: error.code ?? null}; }
finally {
  if (listening) await new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
  closed = !server.listening;
}
const sources = {};
for (const name of ['client.mjs', 'internal/parse.mjs', 'core/api-promise.mjs', 'resources/responses/responses.mjs'])
  sources[name] = hash(await readFile(new URL('./node_modules/openai/' + name, import.meta.url)));
const receipt = {
  schema: 1, at: new Date().toISOString(), passed: !failure && closed,
  node: process.version, sdk: {name: 'openai', version: sdk.version,
    packageIntegrity: lock.packages['node_modules/openai'].integrity, sourceSha256: sources,
    defaultMaxRetries, timeoutOverrideMs: 5000, retryOverride: false},
  capture: {artifact: '../LOSS-RESPONSE.json', status: captured.status,
    contentType: 'application/json', bodySha256: hash(body), bytes: body.length, framing: 'clean chunked EOF'},
  malformed, positive, requests, fetchInvocations: fetches.length, serverErrors, serverClosed: closed,
  realProviderRequests: 0, cloudflareCalls: 0, realCredentialsUsed: false,
  limits: 'Official Node SDK default parsed non-streaming responses.create only. Exact body/status/content type replayed; other original headers were not retained. No claim for every client, raw-response bypass, SSE/WebSocket or timeout/transport-error retry behavior. Independent hosted continuity/accounting/quarantine/cleanup evidence is unchanged.',
  ...(failure ? {failure} : {}),
};
await writeFile(output, JSON.stringify(receipt, null, 2) + '\n', {mode: 0o600, flag: 'wx'});
console.log(JSON.stringify(receipt));
if (!receipt.passed) process.exitCode = 1;
