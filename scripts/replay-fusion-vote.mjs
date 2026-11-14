import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runExactVote } from './fusion-exact-vote.mjs';

/** Replay frozen answers and historical costs without invoking any provider. */
export async function replayFusionVote(input) {
  if (!Array.isArray(input?.cases) || !input.cases.length || input.cases.length > 10_000
    || !Array.isArray(input.workers)) throw new Error('invalid_vote_cases');
  const width = input.workers.length;
  const cases = Array.from(input.cases, row => {
    if (!Array.isArray(row?.answers) || row.answers.length !== width
      || !Array.isArray(row.costs) || row.costs.length !== width
      || !Array.from(row.costs).every(cost => Number.isFinite(cost) && cost >= 0)) {
      throw new Error('invalid_vote_case');
    }
    return { answers: Array.from(row.answers), costs: Array.from(row.costs) };
  });
  const panel = { version: input.version, choices: input.choices, workers: input.workers };
  let calls = 0, cost = 0, fullCost = 0, earlyStopped = 0;
  for (const row of cases) {
    const indices = new Map(panel.workers.map((worker, index) => [worker.id, index]));
    const invoke = id => row.answers[indices.get(id)];
    // Run the full panel as well: invalid skipped answers must still fail replay.
    const full = await runExactVote(panel, invoke, { earlyStop: false });
    const result = await runExactVote(panel, invoke);
    if (result.answer !== full.answer) throw new Error('vote_answer_mismatch');
    calls += result.called.length;
    cost += result.called.reduce((sum, id) => sum + row.costs[indices.get(id)], 0);
    fullCost += row.costs.reduce((sum, value) => sum + value, 0);
    earlyStopped += Number(!result.complete);
  }
  if (!Number.isFinite(cost) || !Number.isFinite(fullCost)) throw new Error('invalid_vote_cost_total');
  return { cases: cases.length, earlyStopped, meanCalls: calls / cases.length,
    meanCost: cost / cases.length, fullPanelMeanCost: fullCost / cases.length, answerMismatches: 0 };
}

async function main() {
  if (process.argv.length !== 3) throw new Error('usage: node scripts/replay-fusion-vote.mjs INPUT.json');
  const file = await open(process.argv[2], 'r');
  let input;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw new Error('invalid_vote_file');
    const bytes = Buffer.alloc(4 * 1024 * 1024 + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length === bytes.length) throw new Error('invalid_vote_file');
    input = JSON.parse(bytes.subarray(0, length).toString('utf8'));
  } finally {
    await file.close();
  }
  console.log(JSON.stringify(await replayFusionVote(input)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error('fusion_vote_replay_failed'); process.exitCode = 1; });
}
