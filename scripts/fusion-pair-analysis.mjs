import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const identifier = value => typeof value === 'string' && /^[a-z][a-z0-9-]{1,63}$/.test(value);
const money = value => Number.isSafeInteger(value) && value >= 0;
const digest = (value, length) => typeof value === 'string' && new RegExp(`^[a-f0-9]{${length}}$`).test(value);
const sum = values => {
  const value = values.reduce((total, next) => total + next, 0);
  if (!money(value)) throw new Error('pair_cost_overflow');
  return value;
};

function analysisMetric({ latencyMetric = 'elapsedMs' } = {}) {
  if (!['elapsedMs', 'agentElapsedMs'].includes(latencyMetric)) throw new Error('invalid_pair_latency_metric');
  return latencyMetric;
}

const duration = (rows, metric) => rows.every(row => money(row[metric])) ? sum(rows.map(row => row[metric])) : null;

function failureSignals(rows, receipts) {
  const failed = rows.filter(row => row.score === 0);
  return {
    visiblePassFailures: failed.filter(row => row.publicPassed === true).length,
    falseAccepts: failed.filter(row => row.outcome === 'submitted' && row.publicPassed === true).length,
    acceptancePassesWithoutSubmission: failed.filter(row => {
      const receipt = receipts.find(receipt => receipt.taskId === row.taskId);
      return typeof row.outcome === 'string' && row.outcome !== 'submitted'
        && row.verdict?.passed === true && row.verdict.tests === receipt.oracleTests
        && row.verdict.skipped === receipt.oracleSkipped;
    }).length,
  };
}


function modelUse(runs, candidate) {
  const result = { cheapOnlyAttempts: 0, strongOnlyAttempts: 0, mixedAttempts: 0,
    noCallAttempts: 0, mixedWinsOverCheap: 0 };
  for (const run of runs) {
    for (const row of run.records.filter(row => row.strategy === candidate)) {
      const used = new Set(run.calls.filter(call => call.trialId === `${row.taskId}:${candidate}`).map(call => call.model));
      if (!used.size) result.noCallAttempts++;
      else if (used.size === 1) result[used.has(run.config.cheap) ? 'cheapOnlyAttempts' : 'strongOnlyAttempts']++;
      else {
        result.mixedAttempts++;
        const cheapRow = run.records.find(other => other.taskId === row.taskId && other.strategy === 'cheap');
        if (row.score > cheapRow.score) result.mixedWinsOverCheap++;
      }
    }
  }
  return result;
}

/** Observed paired outcomes, not a significance test or a production approval. */
export function analyzePairRun(run, options) {
  const latencyMetric = analysisMetric(options);
  if (run?.version !== 1 || run.kind !== 'native-pair-repository' || run.complete !== true || run.failure) {
    throw new Error('incomplete_pair_run');
  }
  if (!digest(run.sourceSha, 40) || !digest(run.datasetDigest, 64) || !digest(run.qualificationDigest, 64)
    || !Array.isArray(run.strategies) || run.strategies.length !== 3
    || new Set(run.strategies).size !== 3 || !run.strategies.every(identifier)
    || !run.strategies.includes('cheap') || !run.strategies.includes('strong')
    || !Array.isArray(run.receipts) || !run.receipts.length || !Array.isArray(run.records)
    || !Array.isArray(run.calls) || !money(run.config?.priorCostMicros) || !money(run.spentOrReservedMicros)
    || typeof run.config?.cheap !== 'string' || typeof run.config?.strong !== 'string'
    || run.config.cheap === run.config.strong
    || (run.probeRegressionGate !== undefined && typeof run.probeRegressionGate !== 'boolean')
    || (run.handoffProbeGate !== undefined && (typeof run.handoffProbeGate !== 'boolean'
      || (run.handoffProbeGate && (run.probeRegressionGate !== true || !['edit-handoff', 'matched-handoff'].includes(run.policy)))))
    || (run.handoffEvidence !== undefined && typeof run.handoffEvidence !== 'boolean')) throw new Error('invalid_pair_run');
  if (run.armOffset !== undefined && (!Number.isSafeInteger(run.armOffset) || run.armOffset < 0
    || run.armOffset >= run.strategies.length)) throw new Error('invalid_pair_run');
  if (run.handoffMaxTurns != null && (!Number.isSafeInteger(run.handoffMaxTurns) || run.handoffMaxTurns < 1
    || !Number.isSafeInteger(run.config.maxCalls) || run.handoffMaxTurns >= run.config.maxCalls
    || !['edit-handoff', 'matched-handoff'].includes(run.policy))) throw new Error('invalid_pair_run');
  const candidate = run.strategies.find(strategy => !['cheap', 'strong'].includes(strategy));
  const cases = new Map();
  for (const receipt of run.receipts) {
    if (!identifier(receipt.taskId) || cases.has(receipt.taskId)
      || !Number.isSafeInteger(receipt.oracleTests) || receipt.oracleTests < 1
      || !money(receipt.oracleSkipped) || receipt.oracleSkipped >= receipt.oracleTests) throw new Error('invalid_pair_receipt');
    cases.set(receipt.taskId, { receipt, rows: new Map() });
  }
  const attempts = new Map();
  for (const call of run.calls) {
    if (typeof call.trialId !== 'string' || !money(call.costMicros)
      || ![run.config.cheap, run.config.strong].includes(call.model)) throw new Error('unsettled_or_invalid_pair_call');
    const [taskId, strategy, extra] = call.trialId.split(':');
    if (extra !== undefined || !cases.has(taskId) || !run.strategies.includes(strategy)) throw new Error('unexpected_pair_call');
    if (['cheap', 'strong'].includes(strategy) && call.model !== run.config[strategy]) {
      throw new Error('mismatched_pair_control_model');
    }
    const entry = attempts.get(call.trialId) ?? [];
    entry.push(call.costMicros); attempts.set(call.trialId, entry);
  }
  for (const row of run.records) {
    const entry = cases.get(row.taskId);
    if (!entry || !run.strategies.includes(row.strategy) || entry.rows.has(row.strategy)
      || !['complete', 'error'].includes(row.status) || ![0, 1].includes(row.score)
      || (row.status === 'error' && row.score !== 0) || !money(row.costMicros) || !money(row.calls)) {
      throw new Error('invalid_or_duplicate_pair_row');
    }
    if ((row.status === 'complete' || row.verdict !== undefined) && row.verdict?.valid !== true) {
      throw new Error('incomplete_pair_grade');
    }
    if (row.score === 1 && ((run.probeRegressionGate === true && row.probeRegressionPassed !== true) || row.publicPassed !== true || row.verdict?.passed !== true
      || row.verdict.tests !== entry.receipt.oracleTests || row.verdict.skipped !== entry.receipt.oracleSkipped)) {
      throw new Error('unverified_pair_score');
    }
    const calls = attempts.get(`${row.taskId}:${row.strategy}`) ?? [];
    if (row.calls !== calls.length || row.costMicros !== sum(calls)) throw new Error('pair_accounting_mismatch');
    entry.rows.set(row.strategy, row);
  }
  if ([...cases.values()].some(entry => entry.rows.size !== run.strategies.length)) throw new Error('missing_pair_rows');
  const costMicros = sum(run.calls.map(call => call.costMicros));
  if (sum([run.config.priorCostMicros, costMicros]) !== run.spentOrReservedMicros) throw new Error('pair_accounting_mismatch');
  const totals = run.strategies.map(strategy => {
    const rows = [...cases.values()].map(entry => entry.rows.get(strategy));
    return { strategy, solved: rows.reduce((total, row) => total + row.score, 0),
      costMicros: sum(rows.map(row => row.costMicros)), calls: sum(rows.map(row => row.calls)),
      elapsedMs: duration(rows, 'elapsedMs'), agentElapsedMs: duration(rows, 'agentElapsedMs'),
      ...failureSignals(rows, run.receipts) };
  });
  const cheap = totals.find(row => row.strategy === 'cheap'), strong = totals.find(row => row.strategy === 'strong');
  const selected = totals.find(row => row.strategy === candidate);
  const comparison = reference => {
    let wins = 0, losses = 0;
    for (const { rows } of cases.values()) {
      const difference = rows.get(candidate).score - rows.get(reference).score;
      wins += Number(difference > 0); losses += Number(difference < 0);
    }
    return { reference, wins, losses, ties: cases.size - wins - losses };
  };
  const versusCheap = comparison('cheap'), versusStrong = comparison('strong');
  let mixture = null;
  // A task-independent coin chooses a model before seeing that task's outcome.
  // Interpolate only inside the observed control-cost interval; never extrapolate.
  if (strong.costMicros !== cheap.costMicros
    && selected.costMicros >= Math.min(cheap.costMicros, strong.costMicros)
    && selected.costMicros <= Math.max(cheap.costMicros, strong.costMicros)) {
    const strongProbability = (selected.costMicros - cheap.costMicros) / (strong.costMicros - cheap.costMicros);
    const expectedSolved = (1 - strongProbability) * cheap.solved + strongProbability * strong.solved;
    mixture = { strongProbability, expectedSolved, costMicros: selected.costMicros,
      candidateSolvedMinusExpected: selected.solved - expectedSolved };
  }
  const oracleSolved = [...cases.values()].filter(({ rows }) => rows.get('cheap').score || rows.get('strong').score).length;
  return { version: 1, kind: 'observed-pair-analysis', sourceSha: run.sourceSha, armOffset: run.armOffset ?? 0,
    handoffMaxTurns: run.handoffMaxTurns ?? null, handoffEvidence: run.handoffEvidence ?? false, probeRegressionGate: run.probeRegressionGate ?? false, handoffProbeGate: run.handoffProbeGate ?? false,
    datasetDigest: run.datasetDigest, qualificationDigest: run.qualificationDigest,
    inputDigest: createHash('sha256').update(JSON.stringify(run)).digest('hex'),
    cases: cases.size, candidate, latencyMetric, totals, comparisons: [versusCheap, versusStrong],
    candidateModelUse: modelUse([run], candidate),
    costSavingVersusStrong: strong.costMicros ? 1 - selected.costMicros / strong.costMicros : null,
    latencyRatioVersusStrong: strong[latencyMetric] > 0 && selected[latencyMetric] !== null ? selected[latencyMetric] / strong[latencyMetric] : null,
    cheapDominatesCandidate: cheap[latencyMetric] === null || selected[latencyMetric] === null ? null
      : cheap.solved >= selected.solved && versusCheap.wins === 0
        && cheap.costMicros <= selected.costMicros && cheap[latencyMetric] <= selected[latencyMetric],
    controlOracleSolved: oracleSolved, controlComplementarity: oracleSolved - Math.max(cheap.solved, strong.solved),
    matchedCostRandomMixture: mixture,
    observedCostSavingWithoutStrongRegressions: versusStrong.losses === 0 && selected.costMicros < strong.costMicros,
    observedQualityGainOverBestFixed: selected.solved > Math.max(cheap.solved, strong.solved),
    limitations: ['Single-trial observations do not establish statistical significance or production readiness.',
      'Missing or invalid elapsed time is reported as unknown; totals are summed, not concurrent wall time.',
      'A single-model candidate win is not evidence of model mixing; matched retry controls are still needed.',
      'Random-mixture values are expectations from these control observations, not fresh executed trials.',
      'Prior campaign reservations are excluded from arm comparisons but must remain in the spending ledger.',
      'This validates internal consistency, not authenticity of the supplied report.'] };
}

const canonical = value => JSON.stringify(value, (_key, entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
  ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b))) : entry);

/** Aggregate consecutive matched blocks without treating repeats as distinct tasks. */
export function analyzePairRepeats(runs, options) {
  const latencyMetric = analysisMetric(options);
  if (!Array.isArray(runs) || runs.length < 2) throw new Error('missing_pair_repeats');
  const reports = runs.map(run => analyzePairRun(run, { latencyMetric }));
  if (new Set(reports.map(report => report.inputDigest)).size !== runs.length) throw new Error('duplicate_pair_repeat');
  // Arm offsets vary across counterbalanced blocks, not model or scoring policy.
  const protocol = run => {
    const { priorCostMicros: _prior, ...config } = run.config;
    return canonical({ sourceSha: run.sourceSha, datasetDigest: run.datasetDigest,
      qualificationDigest: run.qualificationDigest, config, pins: run.pins, policy: run.policy,
      executor: run.executor, cheapReasoning: run.cheapReasoning, cheapMaxCalls: run.cheapMaxCalls,
      preloadSource: run.preloadSource, includeControls: run.includeControls, controlsOnly: run.controlsOnly,
      handoffMaxTurns: run.handoffMaxTurns ?? null, handoffEvidence: run.handoffEvidence ?? false, probeRegressionGate: run.probeRegressionGate ?? false, handoffProbeGate: run.handoffProbeGate ?? false,
      strategies: [...run.strategies].sort(), receipts: [...run.receipts].sort((a, b) => a.taskId.localeCompare(b.taskId)) });
  };
  const expected = protocol(runs[0]);
  for (let i = 0; i < runs.length; i++) {
    if (protocol(runs[i]) !== expected) throw new Error('mismatched_pair_protocol');
    if (i && runs[i].config.priorCostMicros !== runs[i - 1].spentOrReservedMicros) throw new Error('discontinuous_pair_ledger');
    if (runs[i].records.some(row => !money(row[latencyMetric]))) throw new Error('invalid_pair_elapsed');
  }
  const candidate = reports[0].candidate;
  const candidateModelUse = modelUse(runs, candidate);
  const totals = runs[0].strategies.map(strategy => {
    const rows = runs.flatMap(run => run.records.filter(row => row.strategy === strategy));
    return { strategy, solved: sum(rows.map(row => row.score)), attempts: rows.length,
      costMicros: sum(rows.map(row => row.costMicros)), elapsedMs: duration(rows, 'elapsedMs'),
      agentElapsedMs: duration(rows, 'agentElapsedMs'),
      ...failureSignals(rows, runs[0].receipts) };
  });
  const comparisons = ['cheap', 'strong'].map(reference => {
    const blocks = reports.map(report => report.comparisons.find(row => row.reference === reference));
    return { reference, wins: sum(blocks.map(row => row.wins)), losses: sum(blocks.map(row => row.losses)),
      ties: sum(blocks.map(row => row.ties)) };
  });
  const selected = totals.find(row => row.strategy === candidate);
  const strong = totals.find(row => row.strategy === 'strong');
  const cheap = totals.find(row => row.strategy === 'cheap');
  const saving = strong.costMicros ? 1 - selected.costMicros / strong.costMicros : null;
  const latencyRatio = strong[latencyMetric] ? selected[latencyMetric] / strong[latencyMetric] : null;
  const screen = { minimumSolvedFraction: 0.75, minimumCostSaving: 0.2, maximumLatencyRatio: 2,
    enoughSolved: selected.solved >= selected.attempts * 0.75,
    noStrongRegressions: comparisons[1].losses === 0,
    enoughCostSaving: saving !== null && BigInt(selected.costMicros) * 5n <= BigInt(strong.costMicros) * 4n,
    withinLatencyLimit: latencyRatio !== null && latencyRatio <= 2,
    rescuedBeyondCheap: comparisons[0].wins > 0 };
  return { version: 1, kind: 'observed-pair-repeat-analysis', armOffsets: runs.map(run => run.armOffset ?? 0), sourceSha: runs[0].sourceSha,
    handoffMaxTurns: runs[0].handoffMaxTurns ?? null, handoffEvidence: runs[0].handoffEvidence ?? false, probeRegressionGate: runs[0].probeRegressionGate ?? false, handoffProbeGate: runs[0].handoffProbeGate ?? false,
    blocks: runs.length, distinctTasks: reports[0].cases, attemptsPerStrategy: selected.attempts, latencyMetric,
    inputDigests: reports.map(report => report.inputDigest), totals, comparisons, candidateModelUse,
    costSavingVersusStrong: saving, latencyRatioVersusStrong: latencyRatio,
    cheapDominatesCandidate: cheap.solved >= selected.solved && comparisons[0].wins === 0
      && cheap.costMicros <= selected.costMicros && cheap[latencyMetric] <= selected[latencyMetric],
    pilotScreen: { ...screen, passed: screen.enoughSolved && screen.noStrongRegressions
      && screen.enoughCostSaving && screen.withinLatencyLimit && screen.rescuedBeyondCheap },
    spentOrReservedMicros: runs.at(-1).spentOrReservedMicros,
    limitations: ['Repeated attempts are not independent tasks or evidence of statistical significance.',
      'The fixed pilot screen is exploratory; passing it is not production approval.',
      'A single-model candidate win is not evidence of model mixing; matched retry controls are still needed.',
      'Costs use the input reports\' tariffs and elapsed time is summed, not concurrent wall time.',
      'Internal consistency does not establish authenticity or rule out omitted experiments.'] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const files = process.argv.slice(2);
    const options = files[0]?.startsWith('--latency-metric=') ? { latencyMetric: files.shift().slice('--latency-metric='.length) } : undefined;
    analysisMetric(options);
    if (!files.length || files.length > 32) throw new Error('invalid_pair_file');
    const runs = [];
    for (const file of files) {
      if ((await stat(file)).size > 16 * 1024 * 1024) throw new Error('invalid_pair_file');
      runs.push(JSON.parse(await readFile(file, 'utf8')));
    }
    console.log(JSON.stringify(runs.length === 1 ? analyzePairRun(runs[0], options) : analyzePairRepeats(runs, options), null, 2));
  } catch {
    console.error('Pair analysis requires complete, settled reports; repeated blocks must share a protocol and consecutive ledgers.'); process.exitCode = 1;
  }
}
