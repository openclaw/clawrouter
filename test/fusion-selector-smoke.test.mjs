import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { selectorCases, selectorPrompt } from '../benchmarks/fusion/selector-smoke.mjs';
import { localEndpoint, parseDecision, summarizeSelectors, runSelectorSmoke } from '../scripts/fusion-selector-smoke.mjs';

const examples = {
  'finite-positive': [[1], [0], [-1], ['1'], [Infinity], [NaN]],
  'nullish-default': [[null, 9], [undefined, 9], [0, 9], [false, 9], ['', 9], [3, 9]],
  'exact-leaf': [['model', 'model'], ['prefixmodel', 'model'], ['p/model', 'model'], ['model/other', 'model']],
  'https-only': [['https://example.test'], ['http://example.test'], ['httpsjunk'], ['invalid']],
  'decimal-string': [['0'], ['000'], ['12'], [''], ['1.5'], ['+1'], [' 1'], ['3x'], [4]],
  'integer-range': [[1, 3], [3, 3], [1.5, 3], [0, 3]],
  'utf8-limit': [['a', 1], ['é', 1], ['😀', 3], ['a', 2]],
  'round-cost-up': [[1, 0.2], [1, 1], [3, 0.6]],
  'sort-copy': [[[2, 10, 1]]], 'stable-unique': [[['b', 'a', 'b', 'c', 'a']]],
  'literal-path': [['https://example.test/A%2FB/']],
};
const expected = {
  'finite-positive': [true, false, false, false, false, false],
  'nullish-default': [9, 9, 0, false, '', 3], 'exact-leaf': [true, false, true, false],
  'https-only': [true, false, false, false], 'decimal-string': [true, true, true, false, false, false, false, false, false],
  'integer-range': [true, true, false, false], 'utf8-limit': [true, false, false, true],
  'round-cost-up': [1, 1, 2], 'sort-copy': [[1, 2, 10]], 'stable-unique': [['b', 'a', 'c']],
  'literal-path': ['/A%2FB/'],
};

test('every hand-authored candidate has the declared gold outcome on contract probes', () => {
  // Only repository-authored fixture expressions execute here. Model output is never evaluated.
  for (const task of selectorCases()) for (const [index, source] of task.candidates.entries()) {
    const fn = runInNewContext(`(${source})`, { URL, Buffer }, { timeout: 100, contextCodeGeneration: { strings: false, wasm: false } });
    let passed;
    if (task.family === 'cleanup-once') {
      passed = [false, true].every(throws => {
        let count = 0, value, failed = false;
        try { value = fn(() => { if (throws) throw Error('fixture'); return 42; }, () => { count++; }); }
        catch { failed = true; }
        return count === 1 && failed === throws && (throws || value === 42);
      });
    } else {
      passed = examples[task.family].every((original, exampleIndex) => {
        const args = original.map(value => Array.isArray(value) ? [...value] : value);
        const before = JSON.stringify(args);
        try { return JSON.stringify(fn(...args)) === JSON.stringify(expected[task.family][exampleIndex]) && JSON.stringify(args) === before; }
        catch { return false; }
      });
    }
    assert.equal(passed, task.correctChoice === index + 1, `${task.id} candidate ${index + 1}`);
  }
});

test('case positions are balanced and prompts exclude gold labels and family IDs', () => {
  const cases = selectorCases(); assert.equal(cases.length, 48);
  for (let choice = 0; choice <= 3; choice++) assert.equal(cases.filter(task => task.correctChoice === choice).length, 12);
  for (const task of cases) {
    const prompt = selectorPrompt(task);
    assert.ok(!prompt.includes('correctChoice')); assert.ok(!prompt.includes(task.id));
    assert.ok(prompt.length < 2400);
  }
});

test('local endpoint and decision parsing reject remote routes and malformed output', () => {
  assert.equal(localEndpoint('http://127.0.0.1:11435'), 'http://127.0.0.1:11435');
  for (const url of ['https://127.0.0.1', 'http://example.test', 'http://user:secret@127.0.0.1', 'http://127.0.0.1/path']) {
    assert.throws(() => localEndpoint(url), /local_endpoint/);
  }
  assert.deepEqual(parseDecision('{"choice":0,"confidence":12}'), { choice: 0, confidence: 12 });
  for (const value of ['null', '{}', '{"choice":4,"confidence":99}', '{"choice":1,"confidence":101}',
    '{"choice":1,"confidence":99,"reason":"private"}', 'prefix {"choice":1,"confidence":99}']) assert.equal(parseDecision(value), null);
});

test('policy replay counts escalation and never scores invalid output as valid abstention', () => {
  const tasks = [{ id: 'a', family: 'one', correctChoice: 0 }, { id: 'b', family: 'two', correctChoice: 2 }];
  const records = tasks.flatMap(task => [0, 1, 2].map(sample => ({ caseId: task.id, model: 'tiny', sample,
    status: task.id === 'a' ? 'invalid' : 'valid', choice: task.id === 'a' ? null : 1,
    confidence: 90, inputTokens: 10, outputTokens: 5 })).concat([{ caseId: task.id, model: 'small', sample: 0,
    status: 'valid', choice: task.correctChoice, confidence: 90, inputTokens: 20, outputTokens: 5 }]));
  const policies = summarizeSelectors(tasks, records, ['tiny', 'small']);
  assert.equal(policies[0].correct, 0); assert.equal(policies[2].correct, 0);
  assert.equal(policies[3].correct, 1); assert.equal(policies[3].falseAcceptance, 1);
  assert.equal(policies[3].escalations, 1); assert.equal(policies[3].replayCalls, 3);
  assert.throws(() => summarizeSelectors(tasks, records.slice(1), ['tiny', 'small']), /incomplete/);
});

test('transport failure checkpoints and stops without persisting raw provider errors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fusion-selector-')); let chats = 0;
  try {
    const fetcher = async url => {
      if (url.endsWith('/api/tags')) return Response.json({ models: ['tiny', 'small'].map(name => ({ name, digest: 'a'.repeat(64), size: 1 })) });
      if (url.endsWith('/api/show')) return Response.json({ capabilities: [] });
      chats++; return new Response('private response', { status: 500 });
    };
    await assert.rejects(runSelectorSmoke({ out: join(root, 'run'), sourceSha: 'b'.repeat(40), models: ['tiny', 'small'], fetcher }), /local_smoke_incomplete/);
    const text = await readFile(join(root, 'run/selector-smoke.json'), 'utf8');
    assert.equal(chats, 1); assert.ok(!text.includes('private response')); assert.equal(JSON.parse(text).complete, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
