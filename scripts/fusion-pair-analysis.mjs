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

/** Observed paired outcomes, not a significance test or a production approval. */
export function analyzePairRun(run) {
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
    || run.config.cheap === run.config.strong) throw new Error('invalid_pair_run');
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
    if (row.score === 1 && (row.publicPassed !== true || row.verdict?.passed !== true
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
      costMicros: sum(rows.map(row => row.costMicros)), calls: sum(rows.map(row => row.calls)) };
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
  const versusStrong = comparison('strong');
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
  return { version: 1, kind: 'observed-pair-analysis', sourceSha: run.sourceSha,
    datasetDigest: run.datasetDigest, qualificationDigest: run.qualificationDigest,
    inputDigest: createHash('sha256').update(JSON.stringify(run)).digest('hex'),
    cases: cases.size, candidate, totals, comparisons: [comparison('cheap'), versusStrong],
    controlOracleSolved: oracleSolved, controlComplementarity: oracleSolved - Math.max(cheap.solved, strong.solved),
    matchedCostRandomMixture: mixture,
    observedCostSavingWithoutStrongRegressions: versusStrong.losses === 0 && selected.costMicros < strong.costMicros,
    observedQualityGainOverBestFixed: selected.solved > Math.max(cheap.solved, strong.solved),
    limitations: ['Single-trial observations do not establish statistical significance or production readiness.',
      'Random-mixture values are expectations from these control observations, not fresh executed trials.',
      'Prior campaign reservations are excluded from arm comparisons but must remain in the spending ledger.',
      'This validates internal consistency, not authenticity of the supplied report.'] };
}

const canonical = value => JSON.stringify(value, (_key, entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
  ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b))) : entry);

/** Aggregate consecutive matched blocks without treating repeats as distinct tasks. */
export function analyzePairRepeats(runs) {
  if (!Array.isArray(runs) || runs.length < 2) throw new Error('missing_pair_repeats');
  const reports = runs.map(analyzePairRun);
  if (new Set(reports.map(report => report.inputDigest)).size !== runs.length) throw new Error('duplicate_pair_repeat');
  const protocol = run => {
    const { priorCostMicros: _prior, ...config } = run.config;
    return canonical({ sourceSha: run.sourceSha, datasetDigest: run.datasetDigest,
      qualificationDigest: run.qualificationDigest, config, pins: run.pins, policy: run.policy,
      executor: run.executor, cheapReasoning: run.cheapReasoning, cheapMaxCalls: run.cheapMaxCalls,
      preloadSource: run.preloadSource, includeControls: run.includeControls, controlsOnly: run.controlsOnly,
      strategies: [...run.strategies].sort(), receipts: [...run.receipts].sort((a, b) => a.taskId.localeCompare(b.taskId)) });
  };
  const expected = protocol(runs[0]);
  for (let i = 0; i < runs.length; i++) {
    if (protocol(runs[i]) !== expected) throw new Error('mismatched_pair_protocol');
    if (i && runs[i].config.priorCostMicros !== runs[i - 1].spentOrReservedMicros) throw new Error('discontinuous_pair_ledger');
    if (runs[i].records.some(row => !money(row.elapsedMs))) throw new Error('invalid_pair_elapsed');
  }
  const candidate = reports[0].candidate;
  const totals = runs[0].strategies.map(strategy => {
    const rows = runs.flatMap(run => run.records.filter(row => row.strategy === strategy));
    return { strategy, solved: sum(rows.map(row => row.score)), attempts: rows.length,
      costMicros: sum(rows.map(row => row.costMicros)), elapsedMs: sum(rows.map(row => row.elapsedMs)),
      falseAccepts: rows.filter(row => row.publicPassed === true && row.score === 0).length };
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
  const latencyRatio = strong.elapsedMs ? selected.elapsedMs / strong.elapsedMs : null;
  const screen = { minimumSolvedFraction: 0.75, minimumCostSaving: 0.2, maximumLatencyRatio: 2,
    enoughSolved: selected.solved >= selected.attempts * 0.75,
    noStrongRegressions: comparisons[1].losses === 0,
    enoughCostSaving: saving !== null && BigInt(selected.costMicros) * 5n <= BigInt(strong.costMicros) * 4n,
    withinLatencyLimit: latencyRatio !== null && latencyRatio <= 2,
    rescuedBeyondCheap: comparisons[0].wins > 0 };
  return { version: 1, kind: 'observed-pair-repeat-analysis', sourceSha: runs[0].sourceSha,
    blocks: runs.length, distinctTasks: reports[0].cases, attemptsPerStrategy: selected.attempts,
    inputDigests: reports.map(report => report.inputDigest), totals, comparisons,
    costSavingVersusStrong: saving, latencyRatioVersusStrong: latencyRatio,
    cheapDominatesCandidate: cheap.solved >= selected.solved && comparisons[0].wins === 0
      && cheap.costMicros <= selected.costMicros && cheap.elapsedMs <= selected.elapsedMs,
    pilotScreen: { ...screen, passed: screen.enoughSolved && screen.noStrongRegressions
      && screen.enoughCostSaving && screen.withinLatencyLimit && screen.rescuedBeyondCheap },
    spentOrReservedMicros: runs.at(-1).spentOrReservedMicros,
    limitations: ['Repeated attempts are not independent tasks or evidence of statistical significance.',
      'The fixed pilot screen is exploratory; passing it is not production approval.',
      'Costs use the input reports\' tariffs and elapsed time is summed, not concurrent wall time.',
      'Internal consistency does not establish authenticity or rule out omitted experiments.'] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const files = process.argv.slice(2);
    if (!files.length || files.length > 32) throw new Error('invalid_pair_file');
    const runs = [];
    for (const file of files) {
      if ((await stat(file)).size > 16 * 1024 * 1024) throw new Error('invalid_pair_file');
      runs.push(JSON.parse(await readFile(file, 'utf8')));
    }
    console.log(JSON.stringify(runs.length === 1 ? analyzePairRun(runs[0]) : analyzePairRepeats(runs), null, 2));
  } catch {
    console.error('Pair analysis requires complete, settled reports; repeated blocks must share a protocol and consecutive ledgers.'); process.exitCode = 1;
  }
}
