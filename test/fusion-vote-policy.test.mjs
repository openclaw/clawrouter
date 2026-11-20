import test from 'node:test';
import assert from 'node:assert/strict';
import { createVotePolicy } from '../scripts/fusion-vote-policy.mjs';
import { runExactVote } from '../scripts/fusion-exact-vote.mjs';

const panel = () => ({ version: 1, choices: ['A', 'B'], workers:
  ['one', 'two', 'three'].map((id, priority) => ({ id, weight: 1, priority })) });
const policy = () => ({ version: 1, panel: panel(), entries: [
  { answers: [-2, -2, -2], next: 'three' },
  { answers: [-2, -2, 0], next: 'two' },
  { answers: [-2, -2, -1], next: 'one' },
] });

test('table ordering preserves full-panel answers across every vote and abstention', async () => {
  const input = panel(), selectNext = await createVotePolicy(input, policy());
  for (const one of ['A', 'B', null]) for (const two of ['A', 'B', null]) for (const three of ['A', 'B', null]) {
    const answers = { one, two, three }, invoke = async id => answers[id];
    const full = await runExactVote(input, invoke, { earlyStop: false });
    const result = await runExactVote(input, invoke, { selectNext });
    assert.equal(result.answer, full.answer);
    assert.equal(result.called[0], 'three');
    assert.equal(result.called[1], three === 'A' ? 'two' : 'one');
  }
});

test('policy binds choices, weights, priorities and canonical worker order', async () => {
  for (const change of [p => p.panel.choices.reverse(), p => p.panel.workers.reverse(),
    p => { p.panel.workers[0].weight = 2; }, p => { p.panel.workers[0].priority = 9; },
    p => { p.panel.workers[0].id = 'changed'; }]) {
    const changed = policy(); change(changed);
    await assert.rejects(createVotePolicy(panel(), changed), /vote_policy_panel_mismatch/);
  }
});

test('invalid, duplicate and already-observed table selections are rejected', async () => {
  for (const change of [p => { p.version = 2; }, p => { p.entries = Array(20001).fill(p.entries[0]); },
    p => p.entries.push(p.entries[0]), p => { p.entries[0].next = 'missing'; },
    p => { p.entries[0].answers[2] = 0; }, p => { p.entries[0].answers = [-2]; },
    p => { p.entries[0].answers[0] = -3; }, p => { p.entries[0].answers[0] = 2; },
    p => { p.entries[0].answers[0] = 0.5; }]) {
    const changed = policy(); change(changed);
    await assert.rejects(createVotePolicy(panel(), changed), /invalid_vote_policy/);
  }
});

test('unseen states use canonical remaining order; input mutation cannot change the table', async () => {
  const input = panel(), data = policy();
  const pending = createVotePolicy(input, data);
  input.choices.reverse(); input.workers[2].id = 'changed'; data.panel.workers[0].weight = 100;
  data.entries[0].next = 'one'; data.entries[0].answers[0] = 0;
  const selectNext = await pending;
  assert.equal(selectNext({ observed: [], remaining: ['one', 'two', 'three'] }), 'three');
  assert.equal(selectNext({ observed: [{ id: 'three', answer: 'B' }], remaining: ['one', 'two'] }), 'one');
  assert.equal(selectNext({ observed: [{ id: 'three', answer: null }], remaining: ['one', 'two'] }), 'one');
});

test('a table cannot select against an inconsistent snapshot', async () => {
  const selectNext = await createVotePolicy(panel(), policy());
  for (const snapshot of [
    { observed: [{ id: 'missing', answer: 'A' }], remaining: ['one', 'two', 'three'] },
    { observed: [{ id: 'one', answer: 'C' }], remaining: ['two', 'three'] },
    { observed: [{ id: 'one', answer: null }, { id: 'one', answer: null }], remaining: ['two', 'three'] },
    { observed: [], remaining: ['three', 'two', 'one'] },
  ]) assert.throws(() => selectNext(snapshot), /invalid_vote_policy_state/);
});
