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

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [file, ...extra] = process.argv.slice(2);
    if (!file || extra.length || (await stat(file)).size > 16 * 1024 * 1024) throw new Error('invalid_pair_file');
    console.log(JSON.stringify(analyzePairRun(JSON.parse(await readFile(file, 'utf8'))), null, 2));
  } catch {
    console.error('Pair analysis requires one complete, settled, internally consistent pair report.'); process.exitCode = 1;
  }
}
