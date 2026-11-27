/**
 * Fixed-choice weighted voting. Freeze the panel and scheduling policy before
 * evaluation. The certificate bounds unseen votes; it is not a probability.
 * The caller owns timeouts, admission, billing and parsing provider responses.
 */
export async function runExactVote(input, invoke, { earlyStop = true, selectNext } = {}) {
  if (typeof invoke !== 'function' || typeof earlyStop !== 'boolean'
    || (selectNext !== undefined && typeof selectNext !== 'function')
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
  const observed = new Map();
  let winner = -1;
  for (let index = 0; index < workers.length; index++) {
    const remainingWorkers = workers.filter(worker => !observed.has(worker.id));
    const id = selectNext === undefined ? remainingWorkers[0].id : selectNext(Object.freeze({
      observed: Object.freeze(called.map(id => Object.freeze({ id, answer: observed.get(id) }))),
      remaining: Object.freeze(remainingWorkers.map(worker => worker.id)),
    }));
    const worker = remainingWorkers.find(worker => worker.id === id);
    if (!worker) throw new Error('invalid_vote_selection');
    const answer = await invoke(worker.id);
    if (answer !== null && !choices.includes(answer)) throw new Error('invalid_vote_answer');
    called.push(worker.id);
    observed.set(worker.id, answer);
    scores.fill(0);
    priorities.fill(Infinity);
    // Floating-point sums must follow panel order, independent of call order.
    for (const seen of workers) {
      if (!observed.has(seen.id) || observed.get(seen.id) === null) continue;
      const choice = choices.indexOf(observed.get(seen.id));
      scores[choice] += seen.weight;
      priorities[choice] = Math.min(priorities[choice], seen.priority);
    }
    winner = -1;
    for (let choice = 0; choice < choices.length; choice++) {
      if (priorities[choice] === Infinity) continue;
      if (winner === -1 || scores[choice] > scores[winner]
        || (scores[choice] === scores[winner] && priorities[choice] < priorities[winner])) winner = choice;
    }
    const remaining = workers.reduce((sum, next) => sum + (observed.has(next.id) ? 0 : next.weight), 0);
    const runnerUp = Math.max(0, ...scores.filter((_, choice) => choice !== winner));
    if (earlyStop && winner !== -1 && scores[winner] - runnerUp > remaining + tolerance) {
      return { answer: choices[winner], called, complete: index === workers.length - 1 };
    }
  }
  return { answer: winner === -1 ? null : choices[winner], called, complete: true };
}
