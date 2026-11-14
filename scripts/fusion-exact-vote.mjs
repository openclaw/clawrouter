/**
 * Fixed-choice weighted voting. Weights and call order must be frozen before
 * evaluation. The certificate bounds unseen votes; it is not a probability.
 * The caller owns timeouts, admission, billing and parsing provider responses.
 */
export async function runExactVote(input, invoke, { earlyStop = true } = {}) {
  if (typeof invoke !== 'function' || typeof earlyStop !== 'boolean'
    || input?.version !== 1 || !Array.isArray(input.choices)
    || input.choices.length < 2 || input.choices.length > 32
    || !Array.isArray(input.workers) || !input.workers.length || input.workers.length > 64) {
    throw new Error('invalid_vote_input');
  }
  const choices = Array.from(input.choices);
  const workers = Array.from(input.workers, worker => ({
    id: worker?.id, weight: worker?.weight, priority: worker?.priority,
  }));
  const label = value => typeof value === 'string' && value.length > 0 && value.length <= 128;
  if (!choices.every(label) || new Set(choices).size !== choices.length
    || !workers.every(worker => label(worker.id) && Number.isFinite(worker.weight) && worker.weight >= 0
      && Number.isSafeInteger(worker.priority) && worker.priority >= 0)
    || new Set(workers.map(worker => worker.id)).size !== workers.length
    || new Set(workers.map(worker => worker.priority)).size !== workers.length) {
    throw new Error('invalid_vote_panel');
  }
  const total = workers.reduce((sum, worker) => sum + worker.weight, 0);
  if (!Number.isFinite(total) || total <= 0) throw new Error('invalid_vote_weight');
  // Bound rounding error conservatively for at most 64 finite positive terms.
  // Tiny weights may prevent early exit, but must never weaken the certificate.
  const tolerance = 1e-12 * Math.max(1, total);
  const scores = choices.map(() => 0);
  const priorities = choices.map(() => Infinity);
  const called = [];
  let winner = -1;
  for (let index = 0; index < workers.length; index++) {
    const worker = workers[index];
    const answer = await invoke(worker.id);
    if (answer !== null && !choices.includes(answer)) throw new Error('invalid_vote_answer');
    called.push(worker.id);
    if (answer !== null) {
      const choice = choices.indexOf(answer);
      scores[choice] += worker.weight;
      priorities[choice] = Math.min(priorities[choice], worker.priority);
    }
    winner = -1;
    for (let choice = 0; choice < choices.length; choice++) {
      if (priorities[choice] === Infinity) continue;
      if (winner === -1 || scores[choice] > scores[winner]
        || (scores[choice] === scores[winner] && priorities[choice] < priorities[winner])) winner = choice;
    }
    const remaining = workers.slice(index + 1).reduce((sum, next) => sum + next.weight, 0);
    const runnerUp = Math.max(0, ...scores.filter((_, choice) => choice !== winner));
    if (earlyStop && winner !== -1 && scores[winner] - runnerUp > remaining + tolerance) {
      return { answer: choices[winner], called, complete: index === workers.length - 1 };
    }
  }
  return { answer: winner === -1 ? null : choices[winner], called, complete: true };
}
