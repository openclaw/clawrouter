import { runExactVote } from './fusion-exact-vote.mjs';

const copyPanel = input => {
  if (!Array.isArray(input?.choices) || input.choices.length < 2 || input.choices.length > 32
    || !Array.isArray(input?.workers) || !input.workers.length || input.workers.length > 64
    || input.workers.some(worker => worker?.model !== undefined && (typeof worker.model !== 'string'
      || !worker.model.length || worker.model.length > 256 || /\s|[\x00-\x1f\x7f]/.test(worker.model)))) {
    throw new Error('invalid_vote_policy');
  }
  return { version: input.version, choices: [...input.choices], workers: input.workers.map(worker => ({
    id: worker?.id, weight: worker?.weight, priority: worker?.priority, model: worker?.model,
  })) };
};

/** Bind a data-only scheduling table to one canonical weighted panel. */
export async function createVotePolicy(input, policy) {
  if (policy?.version !== 1 || !Array.isArray(policy.entries) || policy.entries.length > 20000) {
    throw new Error('invalid_vote_policy');
  }
  // Copy all caller-owned data before the first await.
  const panel = copyPanel(input), configured = copyPanel(policy.panel);
  const entries = policy.entries.map(entry => {
    if (!Array.isArray(entry?.answers) || entry.answers.length > 64) throw new Error('invalid_vote_policy');
    return { answers: [...entry.answers], next: entry.next };
  });
  await runExactVote(panel, async () => null);
  await runExactVote(configured, async () => null);
  if (JSON.stringify(panel) !== JSON.stringify(configured)) throw new Error('vote_policy_panel_mismatch');
  const indices = new Map(panel.workers.map((worker, index) => [worker.id, index]));
  const table = new Map();
  for (const { answers, next } of entries) {
    if (answers.length !== panel.workers.length || !answers.every(value => Number.isInteger(value)
      && value >= -2 && value < panel.choices.length) || !indices.has(next)
      || answers[indices.get(next)] !== -2 || table.has(answers.join(','))) throw new Error('invalid_vote_policy');
    table.set(answers.join(','), next);
  }
  return ({ observed, remaining }) => {
    if (!Array.isArray(observed) || observed.length > panel.workers.length
      || !Array.isArray(remaining) || remaining.length > panel.workers.length) throw new Error('invalid_vote_policy_state');
    const answers = panel.workers.map(() => -2);
    for (const item of observed) {
      const index = indices.get(item?.id), answer = item?.answer;
      if (index === undefined || answers[index] !== -2 || answer !== null && !panel.choices.includes(answer)) {
        throw new Error('invalid_vote_policy_state');
      }
      answers[index] = answer === null ? -1 : panel.choices.indexOf(answer);
    }
    const unseen = panel.workers.filter((_, index) => answers[index] === -2).map(worker => worker.id);
    if (!unseen.length || unseen.length !== remaining.length || unseen.some((id, index) => id !== remaining[index])) {
      throw new Error('invalid_vote_policy_state');
    }
    return table.get(answers.join(',')) ?? unseen[0];
  };
}
