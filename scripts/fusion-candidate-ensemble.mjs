import { sandbox, validateEdits, writeFiles, probe } from './fusion-workloads.mjs';

// Candidate source stays in memory; every phase charges the same trial ledger.
export async function runCandidateEnsemble(task, image, trialId, config, invoke, engine, runAgent) {
  const started = performance.now();
  const signal = AbortSignal.timeout(config.deadlineMs);
  const workerTurns = Math.floor(config.maxTurns / 3);
  if (workerTurns < 1) throw new Error('ensemble_requires_three_turns');
  const remaining = () => Math.max(1, config.deadlineMs - Math.ceil(performance.now() - started));
  const results = [];
  for (const strategy of ['strong', 'claude']) {
    if (signal.aborted) throw new Error('ensemble_deadline');
    results.push(await runAgent(task, image, strategy, trialId,
      { ...config, maxTurns: workerTurns, deadlineMs: remaining() }, invoke, engine, { signal }));
  }
  if (signal.aborted) throw new Error('ensemble_deadline');
  const used = results.reduce((sum, result) => sum + result.turns, 0);
  const final = await runAgent(task, image, 'claude', trialId,
    { ...config, maxTurns: config.maxTurns - used, deadlineMs: remaining() }, invoke, engine,
    { signal, candidates: results.map(result => result.files) });
  return { ...final, turns: used + final.turns,
    actions: [...results.flatMap((result, candidate) => result.actions.map(action => ({ ...action, phase: `candidate-${candidate + 1}` }))),
      ...final.actions.map(action => ({ ...action, phase: 'synthesis' }))],
    invalidActions: final.invalidActions + results.reduce((sum, result) => sum + result.invalidActions, 0),
    adviserFailures: final.adviserFailures + results.reduce((sum, result) => sum + result.adviserFailures, 0),
    toolMs: final.toolMs + results.reduce((sum, result) => sum + result.toolMs, 0),
    agentMs: Math.round(performance.now() - started),
    candidates: results.map((result, index) => ({ strategy: ['strong', 'claude'][index],
      outcome: result.outcome, turns: result.turns, patchDigest: result.patchDigest, publicPassed: result.publicPassed })) };
}

// Each probe starts from a fresh candidate snapshot, never the final agent's edits.
export async function compareCandidates(task, image, candidates, script, timeout) {
  const started = performance.now(), results = [];
  for (const [index, files] of candidates.entries()) {
    validateEdits(task, files);
    const remaining = () => {
      const ms = timeout - Math.ceil(performance.now() - started);
      if (ms <= 0) throw new Error('command_timeout');
      return ms;
    };
    remaining();
    const box = await sandbox(image);
    try {
      await writeFiles(box, files, remaining());
      const result = await probe(box, script, remaining());
      results.push({ candidate: index + 1, passed: result.passed, feedback: result.feedback });
    } finally { await box.close(); }
  }
  return results;
}
