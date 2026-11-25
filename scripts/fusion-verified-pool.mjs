// Opt-in caller-side candidate pool. No network, credential or ledger ownership.
const validModel = value => typeof value === 'string' && Boolean(value.trim()) && value.length <= 256;
async function bounded(signal, action) {
  signal.throwIfAborted();
  let abort;
  const stopped = new Promise((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  try { return await Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return action(); }), stopped]); }
  finally { signal.removeEventListener('abort', abort); }
}

/**
 * Reserve the whole pool before invoking any candidate. The caller must durably
 * reserve all permits in reserve(), settle each request inside invoke(), and
 * retain unknown charges and physical work on errors/abort. A deadline bounds
 * this coordinator; it does not prove an upstream stopped or refund a permit.
 *
 * All generations finish before verification. Selection follows input order,
 * not completion speed. Every generated candidate is charged, including unused
 * candidates. Errors stop the pool and never authorize retries or fallback.
 */
export async function runVerifiedPool({ models, reserve, invoke, verify, deadlineMs = 900000, signal: callerSignal }) {
  if (!Array.isArray(models) || models.length < 2 || models.length > 3 || !Array.from(models).every(validModel)
    || typeof reserve !== 'function' || typeof invoke !== 'function' || typeof verify !== 'function'
    || !Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 1800000) {
    throw new Error('invalid_verified_pool');
  }
  const selectedModels = [...models], stop = new AbortController();
  const signal = AbortSignal.any([stop.signal, AbortSignal.timeout(deadlineMs), ...(callerSignal ? [callerSignal] : [])]);
  const started = performance.now();
  const reservation = await bounded(signal, () => reserve({ models: [...selectedModels], signal }));
  const caps = reservation?.costCapsMicros;
  if (!Array.isArray(caps) || caps.length !== selectedModels.length
    || !Array.from(caps).every(value => Number.isSafeInteger(value) && value >= 0)
    || !Number.isSafeInteger(caps.reduce((sum, value) => sum + value, 0))) {
    throw new Error('invalid_pool_reservation');
  }
  const costCaps = [...caps];
  const jobs = selectedModels.map((model, index) => bounded(signal, async () => {
    const before = performance.now();
    const result = await invoke({ model, index, signal });
    if (!result || !Object.hasOwn(result, 'artifact') || result.artifact === undefined
      || !Number.isSafeInteger(result.costMicros) || result.costMicros < 0 || result.costMicros > costCaps[index]) {
      throw new Error('invalid_pool_generation_receipt');
    }
    return { model, index, artifact: structuredClone(result.artifact), costMicros: result.costMicros,
      generationMs: performance.now() - before };
  }).catch(error => { stop.abort(error); throw error; }));
  const settled = await Promise.allSettled(jobs);
  const failure = settled.find(result => result.status === 'rejected');
  if (failure) throw failure.reason;
  signal.throwIfAborted();
  const candidates = settled.map(result => result.value), steps = [];
  let selectedIndex = null, artifact = null, verification = null;
  for (const candidate of candidates) {
    const verdict = candidate.artifact === null ? { runtimePassed: false, compilerPassed: false }
      : await bounded(signal, () => verify({ model: candidate.model, index: candidate.index,
        artifact: structuredClone(candidate.artifact), signal }));
    if (!verdict || typeof verdict.runtimePassed !== 'boolean' || typeof verdict.compilerPassed !== 'boolean') {
      throw new Error('invalid_pool_verification_receipt');
    }
    steps.push({ index: candidate.index, runtimePassed: verdict.runtimePassed, compilerPassed: verdict.compilerPassed });
    if (verdict.runtimePassed && verdict.compilerPassed) {
      selectedIndex = candidate.index; artifact = candidate.artifact; verification = structuredClone(verdict); break;
    }
  }
  return { passed: selectedIndex !== null, selectedIndex, artifact, verification, steps,
    candidates: candidates.map(({ artifact: _artifact, ...receipt }) => receipt),
    costMicros: candidates.reduce((sum, candidate) => sum + candidate.costMicros, 0),
    elapsedMs: performance.now() - started };
}
