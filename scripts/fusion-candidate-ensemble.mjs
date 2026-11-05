import { sandbox, validateEdits, writeFiles, probe, hash } from './fusion-workloads.mjs';

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

// Previews guide inspection; they are not patches and can omit changed source.
export function candidateSummaries(baseline, candidates) {
  const originals = new Map(baseline.map(file => [file.path, file.content]));
  const count = candidates.reduce((sum, files) => sum + files.length, 0);
  const budget = Math.floor(12000 / Math.max(1, count * 2));
  const preview = text => {
    const bytes = Buffer.from(text);
    if (bytes.length <= budget) return { head: text, tail: '', omittedBytes: 0 };
    const half = Math.floor(budget / 2);
    return { head: bytes.subarray(0, half).toString(), tail: bytes.subarray(bytes.length - half).toString(),
      omittedBytes: bytes.length - half * 2 };
  };
  let summaries = candidates.map((files, index) => ({ candidate: index + 1, files: files.map(file => {
    const before = originals.get(file.path), after = file.content;
    if (typeof before !== 'string') throw new Error('invalid_candidate_baseline');
    const metadata = { path: file.path, digest: hash(after), bytes: Buffer.byteLength(after), unchanged: before === after };
    if (metadata.unchanged) return metadata;
    let start = 0, endBefore = before.length, endAfter = after.length;
    while (start < endBefore && start < endAfter && before[start] === after[start]) start++;
    while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) { endBefore--; endAfter--; }
    const contextStart = Math.max(0, start - 120);
    return { ...metadata, changeStartLine: before.slice(0, start).split('\n').length,
      before: preview(before.slice(contextStart, endBefore + 120)), after: preview(after.slice(contextStart, endAfter + 120)) };
  }) }));
  if (Buffer.byteLength(JSON.stringify(summaries)) > 24000) summaries = summaries.map(summary => ({ ...summary,
    files: summary.files.map(({ before, after, ...metadata }) => ({ ...metadata, previewOmitted: true })) }));
  if (Buffer.byteLength(JSON.stringify(summaries)) > 24000) throw new Error('candidate_summary_too_large');
  return summaries;
}
