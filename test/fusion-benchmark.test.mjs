import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gradeAnswer, selectCases, priceBound, parsePrice, runCase, models, writeCheckpoint } from '../scripts/benchmark-fusion.mjs';

test('grader accepts only exact final JSON string answers', () => {
  assert.equal(gradeAnswer('{"answer":"B"}', '(B)'), 1);
  assert.equal(gradeAnswer('{"answer":"-42"}', '-42'), 1);
  for (const answer of ['B', '{"answer":"B because..."}', '{"answer":42}', '{"answer":"42.0"}', '```json\n{"answer":"B"}\n```']) {
    assert.equal(gradeAnswer(answer, answer.includes('42') ? '42' : '(B)'), 0);
  }
});

test('selection is deterministic and independent of response quality', () => {
  const examples = Array.from({ length: 30 }, (_, i) => ({ input: `task ${i}`, target: 'A' }));
  const first = selectCases(examples, 'logic');
  assert.equal(first.length, 10);
  assert.deepEqual(first, selectCases(examples, 'logic'));
  assert.equal(new Set(first.map(x => x.caseId)).size, 10);
  assert.throws(() => selectCases(examples.slice(0, 2), 'logic'), /incomplete/);
});

test('cost reservation includes input bytes, full output allowance and request fee', () => {
  const price = parsePrice({ pricing: { prompt: '0.000001', completion: '0.00001', request: '0.01' } });
  assert.equal(priceBound({ text: '😀' }, price), Buffer.byteLength(JSON.stringify({ text: '😀' })) + 1024 + 40960 + 10000);
  assert.throws(() => parsePrice({ pricing: { prompt: 'unknown', completion: '0.1' } }));
  const tiered = parsePrice({ pricing: { prompt: '0.1', completion: '0.1', overrides: [{ min_prompt_tokens: 2000, prompt: '0.2' }] } });
  assert.equal(priceBound({}, tiered), priceBound({}, { input: 0.1, output: 0.1, request: 0 }));
  assert.equal(priceBound({ text: 'x'.repeat(2000) }, tiered), priceBound({ text: 'x'.repeat(2000) }, { input: 0.2, output: 0.1, request: 0 }));
});

test('checkpoint retains parseable partial measurements until explicitly complete', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fusion-checkpoint-'));
  try {
    await writeCheckpoint(root, { records: [] }, { complete: false, attempts: [{ costMicros: null }] });
    assert.equal(JSON.parse(await readFile(join(root, 'provenance.json'))).complete, false);
    await writeCheckpoint(root, { records: [{ score: 1 }] }, { complete: true });
    assert.equal(JSON.parse(await readFile(join(root, 'runs.json'))).records.length, 1);
    assert.equal(JSON.parse(await readFile(join(root, 'provenance.json'))).complete, true);
  } finally { await rm(root, { recursive: true }); }
});

test('case measurements count all billed calls, failed advisers and final grading', async () => {
  const engine = {
    normalizeFusionConfig: config => config,
    collectFusionProposals: async (_config, body, invoke) => {
      await invoke(models.critic, body, 1000);
      return { proposals: [], failedModels: [models.critic] };
    },
    buildAggregatorBody: body => body,
  };
  let count = 0;
  const invoke = async () => ({ costMicros: ++count * 10, served: { model: 'observed' }, response: Response.json({ choices: [{ message: { content: '{"answer":"A"}' } }] }) });
  const result = await runCase({ caseId: 'x', domain: 'logic', input: 'task', target: '(A)' }, { name: 'panel', model: models.cheap, strategy: 'ensemble' }, engine, invoke);
  assert.equal(result.costMicros, 30);
  assert.equal(result.callCount, 2);
  assert.equal(result.score, 1);
  assert.equal(result.failedAdvisers, 1);
  const unknown = async () => ({ costMicros: null, response: Response.json({ choices: [] }) });
  await assert.rejects(runCase({ caseId: 'x', input: 'task' }, { name: 'panel' }, engine, unknown), /unknown billed cost/);
});
