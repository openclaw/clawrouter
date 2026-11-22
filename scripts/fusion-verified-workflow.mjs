// Caller-side workflow. The caller owns model adapters, budget reservations,
// isolated verification and artifact storage; this module makes no network calls.
const isPassed = result => result.verification.runtimePassed && result.verification.compilerPassed;
const compilerOnly = result => result.verification.runtimePassed && !result.verification.compilerPassed;
const validModel = id => typeof id === 'string' && Boolean(id.trim()) && id.length <= 256;

async function bounded(signal, operation) {
  signal.throwIfAborted();
  let abort;
  const stopped = new Promise((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  try { return await Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return operation(); }), stopped]); }
  finally { signal.removeEventListener('abort', abort); }
}

/**
 * Execute a fixed, at-most-six-call repair workflow. Artifacts and verification
 * feedback must be structured-cloneable. invoke must reserve a conservative
 * budget before dispatch, report the actual cost, and honor signal. Errors stop
 * the workflow; they never authorize another provider call or a model fallback.
 */
export async function runVerifiedWorkflow({ models, invoke, verify, onStep = () => {}, strategy = 'fusion',
  deadlineMs = 900000, signal: callerSignal }) {
  if (!['fusion', 'strong'].includes(strategy) || !Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 1800000
    || typeof invoke !== 'function' || typeof verify !== 'function' || typeof onStep !== 'function'
    || !models || ['draft', 'repair', 'compiler'].some(k => !validModel(models[k]))
    || (models.runtimeRepair !== undefined && !validModel(models.runtimeRepair))
    || (models.admissionRepair !== undefined && !validModel(models.admissionRepair))) {
    throw new Error('invalid_verified_workflow');
  }
  const deadline = AbortSignal.timeout(deadlineMs);
  const signal = callerSignal ? AbortSignal.any([callerSignal, deadline]) : deadline;
  const started = performance.now(), steps = []; let totalCostMicros = 0;
  async function attempt(stage, model, previous = null) {
    if (steps.length >= (strategy === 'strong' ? 2 : 6)) throw new Error('verified_workflow_call_limit');
    const before = performance.now();
    const generated = await bounded(signal, () => invoke({ stage, model, signal,
      draft: previous ? structuredClone(previous.artifact) : null,
      feedback: previous ? structuredClone(previous.verification) : null }));
    if (!generated || !Object.hasOwn(generated, 'artifact') || generated.artifact === undefined
      || !Number.isSafeInteger(generated.costMicros) || generated.costMicros < 0
      || !Number.isSafeInteger(totalCostMicros + generated.costMicros)) {
      throw new Error('invalid_generation_receipt');
    }
    totalCostMicros += generated.costMicros;
    const artifact = structuredClone(generated.artifact);
    const verification = artifact === null ? { runtimePassed: false, compilerPassed: false, feedback: generated.feedback ?? 'No usable draft.' }
      : await bounded(signal, () => verify({ artifact: structuredClone(artifact), stage, model, signal }));
    if (!verification || typeof verification.runtimePassed !== 'boolean' || typeof verification.compilerPassed !== 'boolean') {
      throw new Error('invalid_verification_receipt');
    }
    const step = { stage, model, costMicros: generated.costMicros, runtimePassed: verification.runtimePassed,
      compilerPassed: verification.compilerPassed, elapsedMs: performance.now() - before };
    steps.push(step);
    await bounded(signal, () => onStep({ ...step }));
    return { artifact, verification: structuredClone(verification) };
  }
  const finish = result => ({ passed: isPassed(result), artifact: result.artifact, verification: result.verification,
    steps, costMicros: totalCostMicros, elapsedMs: performance.now() - started });
  if (strategy === 'strong') {
    const first = await attempt('strong-initial', models.repair);
    return finish(isPassed(first) ? first : await attempt('strong-repair', models.repair, first));
  }
  const draft = await attempt('draft', models.draft);
  if (isPassed(draft)) return finish(draft);
  if (draft.artifact === null && models.admissionRepair !== undefined) {
    const repaired = await attempt('draft-admission', models.admissionRepair, draft);
    if (isPassed(repaired)) return finish(repaired);
  }
  if (compilerOnly(draft)) {
    const repaired = await attempt('draft-compiler', models.compiler, draft);
    if (isPassed(repaired)) return finish(repaired);
  }
  if (!draft.verification.runtimePassed && draft.verification.compilerPassed && models.runtimeRepair !== undefined) {
    const repaired = await attempt('draft-runtime', models.runtimeRepair, draft);
    if (isPassed(repaired)) return finish(repaired);
  }
  // Failed specialist repairs cannot replace the original draft as repair input.
  const semantic = await attempt('semantic-repair', models.repair, draft);
  if (isPassed(semantic)) return finish(semantic);
  if (compilerOnly(semantic)) {
    const repaired = await attempt('semantic-compiler', models.compiler, semantic);
    if (isPassed(repaired)) return finish(repaired);
  }
  const restart = await attempt('strong-restart', models.repair);
  return finish(isPassed(restart) ? restart : await attempt('strong-repair', models.repair, restart));
}
