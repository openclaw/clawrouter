import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import test from 'node:test';
import { distribution, parseOptions, percentile, readKey, runLoad, sseParser, summarize } from '../scripts/loadtest.mjs';

test('nearest-rank percentiles retain null for absent samples and do not mutate input', () => {
  const values = [4, 1, 3, 2];
  assert.equal(percentile(values, 50), 2); assert.equal(percentile(values, 99), 4);
  assert.deepEqual(values, [4, 1, 3, 2]);
  assert.deepEqual(distribution([]), { samples: 0, p50: null, p90: null, p95: null, p99: null, max: null });
  assert.equal(distribution([5]).p90, 5);
});

test('SSE parser handles byte splits, multibyte text, comments, multiline JSON and CRLF', () => {
  const events = [], parser = sseParser((name, body) => events.push([name, body]));
  const bytes = new TextEncoder().encode(': hello\r\nevent: content_block_delta\r\ndata: {"text":\r\ndata: "🦞"}\r\n\r\nevent: error\ndata: {"type":"error"}\n\n');
  for (const byte of bytes) parser.push(Uint8Array.of(byte));
  parser.end();
  assert.deepEqual(events, [['content_block_delta', { text: '🦞' }], ['error', { type: 'error' }]]);
});

test('SSE parser discards oversized/malformed frames and resumes at the next event', () => {
  const events = [], parser = sseParser((_, body) => events.push(body));
  parser.push(new TextEncoder().encode(`data: ${'x'.repeat(2 * 1024 * 1024 + 1)}\n\ndata: invalid\n\ndata: {"ok":true}\n\n`));
  assert.deepEqual(events, [{ ok: true }]);
});

test('options reject conflicting limits, secrets in URLs and invalid rates', () => {
  const base = ['--base-url', 'http://localhost', '--key-file', '/fixture'];
  for (const args of [['--requests', '2', '--duration', '2'], ['--rps', '0'], ['--abort-fraction', '2'], ['--concurrency', '1.5'], ['--key', 'hidden']]) assert.throws(() => parseOptions([...base, ...args]));
  assert.throws(() => parseOptions(['--base-url', 'https://name:secret@example.com', '--key-file', '/fixture']));
  assert.equal(parseOptions([...base, '--duration', '0.1']).requests, null);
});

test('summary separates cancellations, missing TTFB, failures and lane identity', () => {
  const rows = [
    { status: 200, error: null, totalMs: 10, ttfbMs: 5, firstByteMs: 2, lane: 'subscription', session: 'a', grantIdentity: 'x' },
    { status: 200, error: 'intentional_abort', totalMs: 3, ttfbMs: null, firstByteMs: 2, lane: 'subscription', session: 'a', grantIdentity: 'y', failover: true },
    { status: 503, error: 'unavailable', totalMs: 6, ttfbMs: 4, firstByteMs: 4, lane: null },
  ];
  const summary = summarize(rows, 2, 4);
  assert.equal(summary.errors, 1); assert.equal(summary.intentionalAborts, 1); assert.equal(summary.ttfbMs.samples, 2);
  assert.equal(summary.failovers, 1); assert.equal(summary.throughput, 1.5); assert.equal(summary.dropped, 4);
  assert.equal(summary.stickiness.changedSessions, 1);
});

test('HTTP runner measures SSE delta, caps concurrency, refuses redirects, aborts and times out', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'loadtest-'));
  const keyFile = join(directory, 'key'); await writeFile(keyFile, 'synthetic-key\n', { mode: 0o600 });
  assert.equal(await readKey(keyFile), 'synthetic-key');
  const unsafe = join(directory, 'unsafe'); await writeFile(unsafe, 'synthetic-key', { mode: 0o644 }); await assert.rejects(readKey(unsafe));
  let active = 0, peak = 0, mode = 'sse', hits = 0;
  const server = createServer(async (request, response) => {
    hits++; active++; peak = Math.max(active, peak); response.on('close', () => active--);
    assert.equal(request.headers.authorization, 'Bearer synthetic-key');
    if (mode === 'redirect') { response.writeHead(307, { location: '/secret' }); response.end(); return; }
    if (mode === 'error') { response.writeHead(429, { 'content-type': 'text/event-stream' }); response.end('event: error\ndata: {"error":{"type":"rate_limit_error"}}\n\n'); return; }
    if (mode === 'error200') { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end('event: error\ndata: {"error":{"type":"overloaded_error"}}\n\n'); return; }
    if (mode === 'json') { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"content":[]}'); return; }
    if (mode === 'stall') return;
    response.writeHead(200, { 'content-type': 'text/event-stream', 'x-clawrouter-grant-lane': 'subscription' });
    response.write('event: message_start\ndata: {"type":"message_start"}\n\n');
    const ending = mode === 'incomplete' ? '' : 'event: message_stop\ndata: {"type":"message_stop"}\n\n';
    setTimeout(() => { if (!response.destroyed) response.end(`event: content_block_delta\ndata: {"type":"content_block_delta"}\n\n${ending}`); }, 30);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); server.close(); await rm(directory, { recursive: true, force: true }); });
  const options = parseOptions(['--base-url', `http://127.0.0.1:${server.address().port}`, '--key-file', keyFile, '--scenario', 'stream', '--requests', '6', '--concurrency', '2']);
  const report = await runLoad({ ...options, jsonOut: join(directory, 'report.json') });
  assert.equal(report.summary.errors, 0); assert.ok(peak <= 2);
  assert.equal('keyFile' in report.configuration, false);
  assert.equal('prompt' in report.configuration, false);
  assert.equal(JSON.stringify(report).includes('synthetic-key'), false);
  await assert.rejects(runLoad({ ...options, requests: 1, jsonOut: join(directory, 'report.json') }));
  assert.ok(report.requests.every(row => row.ttfbMs > row.firstByteMs));
  const aborted = await runLoad({ ...options, requests: 1, abortFraction: 1 });
  assert.equal(aborted.summary.intentionalAborts, 1); assert.equal(aborted.requests[0].ttfbMs, null);
  mode = 'redirect'; const before = hits;
  assert.equal((await runLoad({ ...options, requests: 1 })).requests[0].error, 'http_307'); assert.equal(hits, before + 1);
  mode = 'error'; assert.equal((await runLoad({ ...options, requests: 1 })).requests[0].error, 'rate_limit_error');
  mode = 'error200';
  const serverError = await runLoad({ ...options, requests: 1, abortFraction: 1 });
  assert.equal(serverError.requests[0].error, 'overloaded_error');
  assert.equal(serverError.summary.intentionalAborts, 0);
  assert.equal(serverError.summary.errors, 1);
  mode = 'json';
  const wrongType = await runLoad({ ...options, requests: 1, abortFraction: 1 });
  assert.equal(wrongType.requests[0].error, 'unexpected_content_type');
  assert.equal(wrongType.requests[0].ttfbMs, null);
  assert.equal(wrongType.summary.intentionalAborts, 0);
  mode = 'incomplete'; assert.equal((await runLoad({ ...options, requests: 1 })).requests[0].error, 'incomplete_stream');
  mode = 'sse';
  const timed = await runLoad({ ...options, requests: null, duration: 0.15, rps: 1 });
  assert.equal(timed.summary.completed, 1);
  assert.ok(timed.summary.seconds >= 0.14, 'a low-RPS run must measure the duration window');
  mode = 'stall'; assert.equal((await runLoad({ ...options, requests: 1, timeoutMs: 50 })).requests[0].error, 'timeout');
  const capped = await runLoad({ ...options, requests: 10, concurrency: 1, rps: 1000, timeoutMs: 100 });
  assert.ok(capped.summary.dropped > 0);
});
