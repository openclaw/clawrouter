import assert from 'node:assert/strict';
import test from 'node:test';
import { runReviewCascade, reviewRequest } from '../scripts/fusion-review-cascade.mjs';
import { models } from '../scripts/fusion-benchmark-accounting.mjs';

const task = { instruction: 'Preserve the input bound.', editPaths: ['worker/example.ts'] };
const files = [{ path: 'worker/example.ts', content: 'export const bound = 1;' }];
const config = { maxTurns: 24, outputTokens: 8192, deadlineMs: 10000 };
const body = { messages: [], max_tokens: 256 };
const response = value => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }] });
const result = { files, actions: [{ action: 'edit', status: 'ok' }], publicPassed: true, outcome: 'submitted' };

test('accepted cheap repair pays for a strong review without a second repair agent', async () => {
  const roles = []; let agents = 0;
  const actual = await runReviewCascade(task, 'image', 'trial', config, async (_id, role) => {
    roles.push(role); return response({ decision: 'accept', findings: '' });
  }, async (_task, _image, _strategy, id, settings, invoke, _engine, options) => {
    agents++; assert.equal(settings.maxTurns, 12); assert.equal(options.preloadSource, true);
    await invoke(id, models.strong, body, options.signal); return result;
  });
  assert.deepEqual(roles, [models.cheap, models.strong]); assert.equal(agents, 1);
  assert.equal(actual.reviewAccepted, true); assert.equal(actual.turns, 2);
  assert.equal(actual.reviewDigest.length, 64);
});

test('rejected repair seeds strong revision and passes review as untrusted notes', async () => {
  const roles = []; let agents = 0;
  const actual = await runReviewCascade(task, 'image', 'trial', config, async (_id, role) => {
    roles.push(role); return response({ decision: 'revise', findings: 'private review sentinel' });
  }, async (_task, _image, _strategy, id, settings, invoke, _engine, options) => {
    agents++;
    if (agents === 2) {
      assert.equal(settings.maxTurns, 22); assert.deepEqual(options.initialFiles, files);
      assert.equal(options.reviewNotes, 'private review sentinel');
    }
    await invoke(id, models.cheap, body, options.signal); return result;
  });
  assert.deepEqual(roles, [models.cheap, models.strong, models.strong]);
  assert.equal(actual.reviewAccepted, false); assert.equal(actual.turns, 3);
  assert.equal(JSON.stringify(actual).includes('private review sentinel'), false);
});

test('failed visible tests cannot be overridden by an accepting review', async () => {
  let agents = 0;
  const actual = await runReviewCascade(task, 'image', 'trial', config,
    async () => response({ decision: 'accept', findings: '' }),
    async () => { agents++; return { ...result, publicPassed: agents > 1 }; });
  assert.equal(agents, 2); assert.equal(actual.reviewAccepted, false);
});

test('malformed reviews and refusals stop before revision', async () => {
  for (const reply of [response({ decision: 'revise', findings: '' }), response({ decision: 'accept', findings: 'x'.repeat(6001) }),
    { choices: [{ finish_reason: 'content_filter', message: { content: '' } }] }]) {
    let agents = 0;
    await assert.rejects(runReviewCascade(task, 'image', 'trial', config, async () => reply,
      async () => { agents++; return result; }), /invalid_review|provider_refused/);
    assert.equal(agents, 1);
  }
});

test('all phases share one call ceiling and cannot insert test edits', async () => {
  let dispatched = 0;
  await assert.rejects(runReviewCascade(task, 'image', 'trial', { ...config, maxTurns: 3 }, async () => {
    dispatched++; return response({ decision: 'revise', findings: 'fix bound' });
  }, async (_task, _image, _strategy, id, _settings, invoke, _engine, options) => {
    await invoke(id, models.strong, body, options.signal);
    if (options.initialFiles) await invoke(id, models.strong, body, options.signal);
    return result;
  }), /trial_budget/);
  assert.equal(dispatched, 3);
  assert.throws(() => reviewRequest(task, [{ path: 'worker/test/hidden.test.mjs', content: '' }], 4096), /invalid_edit/);
});
