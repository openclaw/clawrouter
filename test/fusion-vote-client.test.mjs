import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runFusionVote } from '../scripts/run-fusion-vote.mjs';

const input = () => ({ version: 1, prompt: 'Private prompt sentinel', choices: ['A', 'B'], workers:
  ['one', 'two', 'three'].map((id, priority) => ({ id, model: `provider/${id}`, weight: 1, priority })) });
const options = { endpoint: 'https://gateway.example/v1/chat/completions', apiKey: 'private-key-sentinel' };
const envelope = (answer, extra = {}) => ({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ answer }) } }],
  usage: { prompt_tokens: 11, completion_tokens: 7 }, ...extra });

test('live adapter dispatches sequentially and skips calls once the vote cannot change', async () => {
  const bodies = [];
  const result = await runFusionVote(input(), { ...options, fetcher: async (url, request) => {
    assert.equal(url, options.endpoint);
    assert.equal(request.redirect, 'error');
    assert.equal(request.headers.authorization, `Bearer ${options.apiKey}`);
    const body = JSON.parse(request.body); bodies.push(body);
    assert.equal(body.stream, false);
    assert.equal(body.messages[1].content, 'Private prompt sentinel');
    assert.deepEqual(body.response_format.json_schema.schema.properties.answer.enum, ['A', 'B', null]);
    return Response.json(envelope('A'));
  } });
  assert.equal(result.status, 'ok'); assert.equal(result.answer, 'A'); assert.equal(result.complete, false);
  assert.deepEqual(bodies.map(body => body.model), ['provider/one', 'provider/two']);
  assert.deepEqual(result.called, ['one', 'two']); assert.equal(result.usageComplete, true);
  assert.deepEqual(result.calls[0].usage, { promptTokens: 11, completionTokens: 7 });
  assert.ok(!JSON.stringify(result).includes('sentinel'));
});

test('nullable tool-call metadata represents no tool calls', async () => {
  const result = await runFusionVote(input(), { ...options, fetcher: async () => Response.json(envelope('A', {
    choices: [{ finish_reason: 'stop', message: { content: '{"answer":"A"}', tool_calls: null, function_call: null, refusal: null } }],
  })) });
  assert.equal(result.status, 'ok'); assert.equal(result.answer, 'A');
});

test('abstentions invoke the full panel and return null', async () => {
  const result = await runFusionVote(input(), { ...options, fetcher: async () => Response.json(envelope(null)) });
  assert.equal(result.answer, null); assert.equal(result.complete, true); assert.equal(result.calls.length, 3);
});

test('panel and model inputs are copied before the first call', async () => {
  const panel = input(); let calls = 0;
  const result = await runFusionVote(panel, { ...options, fetcher: async (_url, request) => {
    calls++;
    panel.choices[0] = 'changed'; panel.workers[1].model = 'changed'; panel.workers[2].weight = 100;
    assert.notEqual(JSON.parse(request.body).model, 'changed');
    return Response.json(envelope('A'));
  } });
  assert.equal(calls, 2); assert.equal(result.answer, 'A');
});

test('all panel entries and credentials are validated before dispatch', async () => {
  let calls = 0;
  const request = { ...options, fetcher: async () => { calls++; throw new Error('unexpected'); } };
  for (const mutate of [p => { p.workers[2].weight = -1; }, p => { p.workers[2].model = 'bad model'; },
    p => { p.workers[2].priority = p.workers[0].priority; }, p => { p.prompt = ' '; }]) {
    const panel = input(); mutate(panel);
    await assert.rejects(runFusionVote(panel, request));
  }
  for (const changes of [{ endpoint: 'http://remote.example/v1/chat/completions' },
    { endpoint: 'https://user:password@gateway.example' }, { endpoint: 'https://gateway.example?key=secret' },
    { apiKey: 'key\nsecret' }, { deadlineMs: 0 }, { requestTimeoutMs: 300001 }]) {
    await assert.rejects(runFusionVote(input(), { ...request, ...changes }));
  }
  assert.equal(calls, 0);
});

test('incomplete and invalid completions stop with settled usage and no retry', async () => {
  const invalid = [
    { finish_reason: 'length', message: { content: '{"answer":"A"}' } },
    { finish_reason: 'stop', message: { content: '{"answer":"A"}', refusal: 'private refusal sentinel' } },
    ...[false, 0, [], {}].map(refusal => ({ finish_reason: 'stop', message: { content: '{"answer":"A"}', refusal } })),
    { finish_reason: 'stop', message: { content: '{"answer":"A"}', tool_calls: [{}] } },
    { finish_reason: 'stop', message: { content: '{"answer":"A"}', tool_calls: {} } },
    { finish_reason: 'stop', message: { content: '{"answer":"A"}', function_call: {} } },
    { finish_reason: 'stop', message: { content: '{"answer":"outside"}' } },
    { finish_reason: 'stop', message: { content: '{"answer":"A","extra":1}' } },
  ];
  for (const choice of invalid) {
    let calls = 0;
    const result = await runFusionVote(input(), { ...options, fetcher: async () => {
      calls++; return Response.json(envelope('A', { choices: [choice] }));
    } });
    assert.equal(calls, 1); assert.equal(result.status, 'failed');
    assert.equal(result.calls[0].status, 'failed');
    assert.deepEqual(result.calls[0].usage, { promptTokens: 11, completionTokens: 7 });
    assert.ok(!JSON.stringify(result).includes('sentinel'));
  }
});

test('HTTP and transport errors never disclose response bodies or error messages', async () => {
  for (const fetcher of [async () => new Response('private response sentinel', { status: 403 }),
    async () => { throw new Error('private transport sentinel'); }]) {
    const result = await runFusionVote(input(), { ...options, fetcher });
    assert.equal(result.status, 'failed'); assert.equal(result.calls.length, 1);
    assert.equal(result.calls[0].usage, null); assert.ok(!JSON.stringify(result).includes('sentinel'));
  }
});

test('malformed or absent usage remains unknown without changing the answer', async () => {
  for (const usage of [undefined, { prompt_tokens: -1, completion_tokens: 1 },
    { prompt_tokens: 1, completion_tokens: '2' }, { prompt_tokens: Number.MAX_SAFE_INTEGER + 1, completion_tokens: 2 }]) {
    const result = await runFusionVote(input(), { ...options, fetcher: async () => Response.json(envelope('A', { usage })) });
    assert.equal(result.answer, 'A'); assert.equal(result.usageComplete, false);
    assert.ok(result.calls.every(call => call.usage === null));
  }
});

test('oversized responses stop after the first call', async () => {
  const result = await runFusionVote(input(), { ...options,
    fetcher: async () => Response.json(envelope('A', { unexpected: 'x'.repeat(128 * 1024) })) });
  assert.equal(result.error, 'vote_response_limit'); assert.equal(result.calls.length, 1);
});

test('caller cancellation and request deadlines stop later workers', async () => {
  const controller = new AbortController(); controller.abort(); let calls = 0;
  const stopped = await runFusionVote(input(), { ...options, signal: controller.signal,
    fetcher: async () => { calls++; return Response.json(envelope('A')); } });
  assert.equal(stopped.error, 'vote_deadline'); assert.equal(calls, 0);
  const result = await runFusionVote(input(), { ...options, requestTimeoutMs: 5,
    fetcher: (_url, request) => new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('deadline_not_observed')), 1000);
      request.signal.addEventListener('abort', () => { clearTimeout(timer); reject(request.signal.reason); }, { once: true });
    }) });
  assert.equal(result.error, 'vote_deadline'); assert.equal(result.calls.length, 1);
});

test('CLI rejects invalid input without exposing its content', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fusion-vote-client-'));
  try {
    const path = join(directory, 'input.json'); await writeFile(path, '{private prompt sentinel');
    const result = spawnSync(process.execPath, ['scripts/run-fusion-vote.mjs', options.endpoint, path],
      { encoding: 'utf8', env: { PATH: process.env.PATH, CLAWROUTER_API_KEY: options.apiKey } });
    assert.equal(result.status, 1); assert.equal(result.stdout, ''); assert.match(result.stderr, /fusion_vote_failed/);
    assert.ok(!result.stderr.includes('sentinel'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('standard HTTP endpoint works without any provider-specific adapter', async () => {
  const models = [];
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks)); models.push(body.model);
    assert.equal(request.headers.authorization, `Bearer ${options.apiKey}`);
    response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(envelope('B')));
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const result = await runFusionVote(input(), { ...options,
      endpoint: `http://127.0.0.1:${server.address().port}/v1/chat/completions` });
    assert.equal(result.answer, 'B'); assert.equal(models.length, 2);
  } finally { await new Promise(resolve => server.close(resolve)); }
});


test('adaptive endpoint scheduling skips unnecessary calls and retains usage', async () => {
  const panel = input(); panel.workers[2].weight = 3;
  const models = [], snapshots = [];
  const result = await runFusionVote(panel, { ...options,
    selectNext: snapshot => { snapshots.push(snapshot); return snapshot.remaining.at(-1); },
    fetcher: async (_url, request) => {
      models.push(JSON.parse(request.body).model);
      return Response.json(envelope('B'));
    },
  });
  assert.equal(result.status, 'ok'); assert.equal(result.answer, 'B');
  assert.deepEqual(models, ['provider/three']);
  assert.deepEqual(result.called, ['three']);
  assert.equal(result.usageComplete, true);
  assert.deepEqual(result.calls[0].usage, { promptTokens: 11, completionTokens: 7 });
  // Preflight validates the panel without invoking the caller's policy.
  assert.deepEqual(snapshots, [{ observed: [], remaining: ['one', 'two', 'three'] }]);
});

test('selector failures stop dispatch and preserve earlier settled usage', async () => {
  for (const mode of ['unknown', 'repeated', 'throw']) {
    let calls = 0;
    const result = await runFusionVote(input(), { ...options,
      selectNext: ({ observed }) => {
        if (!observed.length) return 'one';
        if (mode === 'throw') throw new Error('private selector sentinel');
        return mode === 'repeated' ? 'one' : 'unknown';
      },
      fetcher: async () => { calls++; return Response.json(envelope('A')); },
    });
    assert.equal(calls, 1); assert.equal(result.status, 'failed');
    assert.equal(result.error, 'vote_selection_failed');
    assert.equal(result.calls[0].status, 'complete');
    assert.deepEqual(result.calls[0].usage, { promptTokens: 11, completionTokens: 7 });
    assert.ok(!JSON.stringify(result).includes('sentinel'));
  }
  let calls = 0;
  const fetcher = async () => { calls++; return Response.json(envelope('A')); };
  const failed = await runFusionVote(input(), { ...options, fetcher, selectNext: () => 'unknown' });
  assert.equal(failed.error, 'vote_selection_failed'); assert.deepEqual(failed.calls, []);
  await assert.rejects(runFusionVote(input(), { ...options, fetcher, selectNext: true }), /invalid_vote_request/);
  assert.equal(calls, 0);
});
