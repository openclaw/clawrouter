import assert from 'node:assert/strict';
import test from 'node:test';
import { runReadWorker } from '../scripts/fusion-read-worker.mjs';

const files = () => [{ path: 'src/example.js', content: 'export const value = 1;\nexport const twice = x => x * 2;\n' }];
const action = (kind, extra = {}) => ({ action: kind, paths: [], query: '', summary: '', citations: [], insufficient: false, ...extra });
const read = action('read', { paths: ['src/example.js:1-2'] });
const report = action('report', { summary: 'twice doubles its input.', citations: [{ path: 'src/example.js', startLine: 2, endLine: 2 }] });

test('worker returns observed source evidence from an immutable admitted snapshot', async () => {
  const source = files(); const messages = [];
  const result = await runReadWorker({ brief: 'Locate twice.', files: source, invoke: async request => {
    messages.push(request.messages); source[0].content = 'changed after admission';
    request.messages.length = 0; request.schema.properties.action.enum.push('edit');
    return request.call === 1 ? read : report;
  } });
  assert.equal(result.status, 'reported');
  assert.equal(result.citations[0].content, 'export const twice = x => x * 2;');
  assert.equal(result.authority, 'untrusted-summary-with-source-excerpts');
  assert.match(result.snapshotSha256, /^[a-f0-9]{64}$/);
  assert.equal(messages.length, 2);
});

test('worker cannot report unobserved lines or access unadmitted files', async () => {
  await assert.rejects(runReadWorker({ brief: 'Locate twice.', files: files(), invoke: async () => report }), /unobserved_read_worker_citation/);
  await assert.rejects(runReadWorker({ brief: 'Read another file.', files: files(),
    invoke: async () => action('read', { paths: ['src/other.js'] }) }), /read_worker_unadmitted_source/);
  await assert.rejects(runReadWorker({ brief: 'Read a parent.', files: [{ path: 'src/../secret.js', content: '' }], invoke: async () => report }), /invalid_read_worker_path/);
});

test('worker exposes no editing or execution action and stops at the call budget', async () => {
  let calls = 0;
  await assert.rejects(runReadWorker({ brief: 'Inspect.', files: files(), invoke: async () => action('edit') }), /invalid_read_worker_action/);
  const result = await runReadWorker({ brief: 'Inspect.', files: files(), maxCalls: 1, invoke: async () => { calls++; return read; } });
  assert.deepEqual({ status: result.status, calls: result.calls, reason: result.reason }, { status: 'incomplete', calls: 1, reason: 'call-limit' });
  assert.equal(calls, 1);
});

test('cancellation prevents further worker calls and provider errors propagate', async () => {
  const controller = new AbortController(); let calls = 0;
  await assert.rejects(runReadWorker({ brief: 'Inspect.', files: files(), signal: controller.signal,
    invoke: async () => { calls++; controller.abort(Error('stopped')); return read; } }), /stopped/);
  assert.equal(calls, 1);
  await assert.rejects(runReadWorker({ brief: 'Inspect.', files: files(), invoke: async () => { throw Error('provider_rejected'); } }), /provider_rejected/);
});

test('literal search reveals only matched lines; insufficient evidence is not a report', async () => {
  const result = await runReadWorker({ brief: 'Locate twice.', files: files(), invoke: async ({ call, messages }) => {
    if (call === 1) return action('search', { query: 'twice' });
    const views = JSON.parse(messages.at(-1).content).views;
    assert.equal(views.length, 1); assert.equal(views[0].startLine, 2);
    return report;
  } });
  assert.equal(result.status, 'reported');
  const absent = await runReadWorker({ brief: 'Inspect.', files: files(), invoke: async () => action('report', { insufficient: true }) });
  assert.equal(absent.status, 'insufficient'); assert.equal(absent.summary, undefined);
});


test('the final call reserves a report and includes remaining calls in the bounded context', async () => {
  const result = await runReadWorker({ brief: 'Locate twice.', files: files(), maxCalls: 2,
    invoke: async ({ call, messages, schema }) => {
      assert.match(messages[0].content, new RegExp(`You have ${3 - call} calls remaining`));
      assert.deepEqual(schema.properties.action.enum, call === 1 ? ['read', 'search', 'report'] : ['report']);
      return call === 1 ? read : report;
    } });
  assert.equal(result.status, 'reported');
  assert.equal(result.calls, 2);
  const noRead = await runReadWorker({ brief: 'Inspect.', files: files(), maxCalls: 1,
    invoke: async ({ schema }) => {
      assert.deepEqual(schema.properties.action.enum, ['report']);
      return action('report', { insufficient: true });
    } });
  assert.equal(noRead.status, 'insufficient');
  let invoked = false;
  await assert.rejects(runReadWorker({ brief: 'x'.repeat(600), files: files(), maxContextBytes: 1024,
    invoke: async () => { invoked = true; return report; } }), /read_worker_context_limit/);
  assert.equal(invoked, false);
});


test('large excerpts preserve context for a report without marking omitted lines observed', async () => {
  const source = [{ path: 'src/large.js', content: Array.from({ length: 90 }, (_, i) => `${i}:` + 'x'.repeat(230)).join('\n') }];
  const result = await runReadWorker({ brief: 'Inspect large source.', files: source, maxCalls: 4, maxContextBytes: 60000,
    invoke: async ({ call, messages, schema }) => {
      assert.ok(Buffer.byteLength(JSON.stringify(messages)) <= 60000);
      if (call < 4) return action('read', { paths: ['src/large.js:1-90'] });
      assert.deepEqual(schema.properties.action.enum, ['report']);
      assert.equal(JSON.parse(messages.at(-1).content).truncated, true);
      return action('report', { summary: 'Observed the first line.', citations: [{ path: 'src/large.js', startLine: 1, endLine: 1 }] });
    } });
  assert.equal(result.status, 'reported');
  await assert.rejects(runReadWorker({ brief: 'Inspect.', files: source, maxCalls: 3, maxContextBytes: 2500,
    invoke: async ({ call, schema }) => {
      if (call === 1) return action('read', { paths: ['src/large.js:1-90'] });
      assert.deepEqual(schema.properties.action.enum, ['report']);
      return action('report', { summary: 'Claim omitted line.', citations: [{ path: 'src/large.js', startLine: 90, endLine: 90 }] });
    } }), /unobserved_read_worker_citation/);
});
