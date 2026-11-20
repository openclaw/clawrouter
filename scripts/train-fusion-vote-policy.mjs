import { createHash } from 'node:crypto';
import { open, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runExactVote } from './fusion-exact-vote.mjs';
import { replayFusionVote } from './replay-fusion-vote.mjs';
import { createVotePolicy } from './fusion-vote-policy.mjs';

/** Fit call order on complete training traces, without correctness labels. */
export async function trainVotePolicy(input, { maxStates = 50000, maxRowVisits = 5000000 } = {}) {
  if (!Number.isSafeInteger(maxStates) || maxStates < 1 || maxStates > 50000
    || !Number.isSafeInteger(maxRowVisits) || maxRowVisits < 1 || maxRowVisits > 5000000
    || !Array.isArray(input?.workers) || !input.workers.length || input.workers.length > 8
    || !Array.isArray(input.choices) || input.choices.length < 2 || input.choices.length > 32
    || !Array.isArray(input.cases) || !input.cases.length || input.cases.length > 10000) throw new Error('invalid_vote_training');
  const panel = { version: input.version, choices: [...input.choices], workers: input.workers.map(w => ({
    id: w?.id, weight: w?.weight, priority: w?.priority, model: w?.model,
  })) };
  const cases = Array.from(input.cases, row => {
    if (!Array.isArray(row?.answers) || row.answers.length !== panel.workers.length
      || !Array.isArray(row.costs) || row.costs.length !== panel.workers.length) throw new Error('invalid_vote_training');
    return { answers: [...row.answers], costs: [...row.costs] };
  });
  // Snapshot the full training input before validation yields to caller code.
  await createVotePolicy(panel, { version: 1, panel, entries: [] });
  const fixed = await replayFusionVote({ ...panel, cases });
  const rows = cases.map(row => ({ answers: row.answers.map(a => a === null ? -1 : panel.choices.indexOf(a)), costs: row.costs }));
  const indices = new Map(panel.workers.map((w, i) => [w.id, i]));
  const memo = new Map(), entries = [];
  let states = 0, visits = 0;
  const needsMore = Symbol('needs_more_votes');
  async function terminal(state) {
    const known = panel.workers.filter((_, i) => state[i] !== -2);
    let index = 0;
    try {
      await runExactVote(panel, async id => state[indices.get(id)] === -1 ? null : panel.choices[state[indices.get(id)]], {
        selectNext: () => { if (index === known.length) throw needsMore; return known[index++].id; },
      });
      return true;
    } catch (error) { if (error === needsMore) return false; throw error; }
  }
  async function fit(state, samples) {
    const key = state.join(',');
    if (memo.has(key)) return memo.get(key);
    if (++states > maxStates) throw new Error('vote_training_limit');
    if (await terminal(state)) { memo.set(key, 0); return 0; }
    let best = Infinity, selected;
    for (let i = 0; i < state.length; i++) {
      if (state[i] !== -2) continue;
      visits += samples.length;
      if (visits > maxRowVisits) throw new Error('vote_training_limit');
      const branches = new Map();
      let total = 0;
      for (const row of samples) {
        total += row.costs[i];
        const answer = row.answers[i];
        if (!branches.has(answer)) branches.set(answer, []);
        branches.get(answer).push(row);
      }
      let cost = total / samples.length;
      for (const [answer, group] of branches) {
        const next = [...state]; next[i] = answer;
        cost += group.length / samples.length * await fit(next, group);
      }
      if (!Number.isFinite(cost)) throw new Error('invalid_vote_training_cost');
      // Strict comparison makes equal-cost ties follow canonical worker order.
      if (cost < best) { best = cost; selected = panel.workers[i].id; }
    }
    if (entries.length >= 20000 || selected === undefined) throw new Error('vote_training_limit');
    entries.push({ answers: state, next: selected }); memo.set(key, best); return best;
  }
  const expectedCost = await fit(panel.workers.map(() => -2), rows);
  const policy = { version: 1, panel, entries };
  const selectNext = await createVotePolicy(panel, policy);
  const adaptive = await replayFusionVote({ ...panel, cases }, { selectNext });
  if (Math.abs(adaptive.meanCost - expectedCost) > 1e-10 * Math.max(1, expectedCost)) throw new Error('vote_training_replay_mismatch');
  policy.training = { cases: cases.length, states, rowVisits: visits,
    dataSha256: createHash('sha256').update(JSON.stringify({ panel, cases })).digest('hex'),
    fixedMeanCost: fixed.meanCost, adaptiveMeanCost: adaptive.meanCost,
    scope: 'Training-set cost fit only; assumes order-independent recorded costs. Evaluate on separate traces before claiming savings.' };
  return policy;
}

async function main() {
  if (process.argv.length !== 4) throw new Error('invalid_arguments');
  const file = await open(process.argv[2], 'r');
  let input;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw new Error('invalid_training_file');
    const bytes = Buffer.alloc(4 * 1024 * 1024 + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length === bytes.length) throw new Error('invalid_training_file');
    input = JSON.parse(bytes.subarray(0, length).toString('utf8'));
  } finally { await file.close(); }
  const policy = await trainVotePolicy(input), encoded = JSON.stringify(policy) + '\n';
  if (Buffer.byteLength(encoded) > 4 * 1024 * 1024) throw new Error('vote_policy_file_limit');
  await writeFile(process.argv[3], encoded, { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify(policy.training));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error('fusion_vote_training_failed'); process.exitCode = 1; });
}
