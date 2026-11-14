import assert from 'node:assert/strict';
import test from 'node:test';
import { runExactVote } from '../scripts/fusion-exact-vote.mjs';
import { replayFusionVote } from '../scripts/replay-fusion-vote.mjs';

const choices = ['A', 'B', 'C', 'D'];
function panel(weights) {
  return { version: 1, choices: [...choices], workers: weights.map((weight, i) => ({ id: String(i), weight, priority: weights.length - i })) };
}

test('certificate preserves full votes for every six-worker answer and abstention pattern', async () => {
  for (const weights of [[1, 1, 1, 1, 1, 1], [61, 74, 9, 67, 0, 0], [0, 0, 0, 0, 0, 1]]) {
    const input = panel(weights);
    for (let code = 0; code < 5 ** 6; code++) {
      let value = code;
      const answers = weights.map(() => { const digit = value % 5; value = Math.floor(value / 5); return choices[digit] ?? null; });
      // Independent integer oracle, including priority-based ties and abstention.
      const totals = choices.map(choice => answers.reduce((sum, answer, i) => sum + (answer === choice ? weights[i] : 0), 0));
      const ranks = choices.map(choice => Math.min(...answers.flatMap((answer, i) => answer === choice ? [input.workers[i].priority] : [])));
      const candidates = choices.map((_, i) => i).filter(i => ranks[i] !== Infinity);
      candidates.sort((a, b) => totals[b] - totals[a] || ranks[a] - ranks[b]);
      const expected = candidates.length ? choices[candidates[0]] : null;
      const result = await runExactVote(input, id => answers[Number(id)]);
      assert.equal(result.answer, expected, `${weights}/${answers}`);
    }
  }
});

test('ties, rounding boundaries and tiny weights do not permit unsafe early exit', async () => {
  for (const weights of [[0.1, 0.2, 0.3], [1, 1 - Number.EPSILON], [1e-300, 1e-300]]) {
    const input = panel(weights);
    const answers = weights.map((_, i) => i === weights.length - 1 ? 'B' : 'A');
    const result = await runExactVote(input, id => answers[Number(id)]);
    const full = await runExactVote(input, id => answers[Number(id)], { earlyStop: false });
    assert.equal(result.answer, full.answer);
    assert.equal(result.complete, true);
  }
});

test('calls are lazy, input is copied, and provider errors stop execution', async () => {
  const input = panel([3, 1, 1]);
  const called = [];
  const result = await runExactVote(input, id => {
    called.push(id);
    input.workers[1].weight = 100;
    input.choices[0] = 'changed';
    return 'A';
  });
  assert.deepEqual(called, ['0']);
  assert.deepEqual(result, { answer: 'A', called: ['0'], complete: false });
  const failed = [];
  await assert.rejects(runExactVote(panel([1, 1]), id => { failed.push(id); throw new Error('upstream'); }), /upstream/);
  assert.deepEqual(failed, ['0']);
});

test('reject malformed panels and answers', async () => {
  for (const input of [panel([-1]), panel([0]), panel([Infinity]), panel([Number.MAX_VALUE, Number.MAX_VALUE]),
    { ...panel([1]), choices: ['A', 'A'] }, { ...panel([1]), workers: Array(65).fill({ id: 'x', weight: 1, priority: 0 }) },
    { ...panel([1, 1]), workers: [{ id: 'x', weight: 1, priority: 0 }, { id: 'x', weight: 1, priority: 1 }] }]) {
    await assert.rejects(runExactVote(input, () => 'A'), /invalid_vote/);
  }
  await assert.rejects(runExactVote(panel([1]), () => undefined), /invalid_vote_answer/);
  await assert.rejects(runExactVote(panel([1]), () => 'unknown'), /invalid_vote_answer/);
});

test('replay verifies full answers and accounts only for calls the certificate needs', async () => {
  const input = { ...panel([3, 1, 1]), cases: [
    { answers: ['A', 'B', 'B'], costs: [2, 3, 4] },
    { answers: [null, 'B', 'B'], costs: [2, 3, 4] },
  ] };
  assert.deepEqual(await replayFusionVote(input), { cases: 2, earlyStopped: 1, meanCalls: 2,
    meanCost: 5.5, fullPanelMeanCost: 9, answerMismatches: 0 });
  input.cases[0].answers[2] = 'invalid skipped answer';
  await assert.rejects(replayFusionVote(input), /invalid_vote_answer/);
  input.cases[0].costs[0] = -1;
  await assert.rejects(replayFusionVote(input), /invalid_vote_case/);
});


test('adaptive selection preserves every six-worker vote against the integer oracle', async () => {
  const weights = [61, 74, 9, 67, 0, 0];
  const input = panel(weights);
  for (let code = 0; code < 5 ** 6; code++) {
    let value = code;
    const answers = weights.map(() => { const digit = value % 5; value = Math.floor(value / 5); return choices[digit] ?? null; });
    const totals = choices.map(choice => answers.reduce((sum, answer, i) => sum + (answer === choice ? weights[i] : 0), 0));
    const ranks = choices.map(choice => Math.min(...answers.flatMap((answer, i) => answer === choice ? [input.workers[i].priority] : [])));
    const candidates = choices.map((_, i) => i).filter(i => ranks[i] !== Infinity);
    candidates.sort((a, b) => totals[b] - totals[a] || ranks[a] - ranks[b]);
    const result = await runExactVote(input, id => answers[Number(id)], {
      selectNext: ({ observed, remaining }) => observed.at(-1)?.answer === 'A' ? remaining[0] : remaining.at(-1),
    });
    assert.equal(result.answer, candidates.length ? choices[candidates[0]] : null, String(answers));
  }
});

test('adaptive arrival order retains canonical floating-point sums', async () => {
  const input = panel([1e16, 1, 1, 1e16, 2]);
  const answers = ['A', 'A', 'A', 'B', 'B'];
  const full = await runExactVote(input, id => answers[Number(id)], { earlyStop: false });
  const adaptive = await runExactVote(input, id => answers[Number(id)], {
    selectNext: ({ remaining }) => remaining.at(-1),
  });
  assert.equal(full.answer, 'B');
  assert.equal(adaptive.answer, full.answer);
  assert.equal(adaptive.complete, true);
});

test('selection snapshots are frozen and only expose observed answers and remaining IDs', async () => {
  const snapshots = [];
  await runExactVote(panel([1, 1]), () => 'A', { selectNext: state => {
    snapshots.push(state);
    assert.deepEqual(Object.keys(state), ['observed', 'remaining']);
    assert.throws(() => state.remaining.pop(), TypeError);
    assert.throws(() => state.observed.push({ id: 'fake', answer: 'B' }), TypeError);
    if (state.observed.length) assert.throws(() => { state.observed[0].answer = 'B'; }, TypeError);
    return state.remaining[0];
  } });
  assert.deepEqual(snapshots[0], { observed: [], remaining: ['0', '1'] });
  assert.deepEqual(snapshots[1], { observed: [{ id: '0', answer: 'A' }], remaining: ['1'] });
});

test('invalid selections stop before invoking another worker', async () => {
  for (const selection of [undefined, null, 'unknown', Promise.resolve('0')]) {
    const called = [];
    await assert.rejects(runExactVote(panel([1, 1]), id => { called.push(id); return 'A'; }, {
      selectNext: () => selection,
    }), /invalid_vote_selection/);
    assert.deepEqual(called, []);
  }
  const called = [];
  await assert.rejects(runExactVote(panel([1, 1]), id => { called.push(id); return 'A'; }, {
    selectNext: () => '0',
  }), /invalid_vote_selection/);
  assert.deepEqual(called, ['0']);
  await assert.rejects(runExactVote(panel([1]), () => 'A', { selectNext: true }), /invalid_vote_input/);
});

test('adaptive replay can avoid a call without changing the canonical answer', async () => {
  const input = { ...panel([1, 1, 3]), cases: [{ answers: ['B', 'B', 'A'], costs: [2, 2, 3] }] };
  const fixed = await replayFusionVote(input);
  const adaptive = await replayFusionVote(input, { selectNext: ({ remaining }) => remaining.at(-1) });
  assert.equal(fixed.meanCalls, 3);
  assert.equal(adaptive.meanCalls, 1);
  assert.equal(adaptive.meanCost, 3);
  assert.equal(adaptive.answerMismatches, 0);
});
