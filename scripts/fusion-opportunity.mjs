import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const digest = value => createHash('sha256').update(value).digest('hex');
const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/@+-]{0,127}$/.test(value);

/** Hindsight opportunity only. This does not simulate a deployable selector. */
export function analyzeOpportunity(inputs, strategies, trial = 1) {
  if (!Array.isArray(inputs) || !inputs.length || !Array.isArray(strategies) || strategies.length < 2
    || new Set(strategies).size !== strategies.length || !strategies.every(identifier)
    || !Number.isSafeInteger(trial) || trial < 1) throw new Error('invalid_opportunity_config');
  const cases = new Map(), sources = [], splits = new Set();
  for (const input of inputs) {
    if (input?.version !== 1 || !['development', 'test'].includes(input.split) || !Array.isArray(input.records)
      || ![input.evaluationId, input.datasetRevision, input.graderRevision].every(identifier)) throw new Error('invalid_run_source');
    splits.add(input.split);
    sources.push({ evaluationId: input.evaluationId, datasetRevision: input.datasetRevision,
      graderRevision: input.graderRevision, digest: digest(JSON.stringify(input)) });
    for (const row of input.records) {
      if (row.trial !== trial || !strategies.includes(row.strategy)) continue;
      if (!identifier(row.caseId) || !identifier(row.domain) || !identifier(row.configurationId)
        || ![0, 1].includes(row.score) || !['completed', 'error'].includes(row.status)
        || (row.status === 'error' && row.score !== 0)
        || !Number.isSafeInteger(row.costMicros) || row.costMicros < 0) throw new Error('invalid_opportunity_row');
      if (!cases.has(row.caseId)) cases.set(row.caseId, { domain: row.domain, rows: new Map() });
      const entry = cases.get(row.caseId);
      if (entry.domain !== row.domain || entry.rows.has(row.strategy)) throw new Error('conflicting_opportunity_row');
      entry.rows.set(row.strategy, row);
    }
  }
  if (splits.size !== 1 || !cases.size || [...cases.values()].some(entry => entry.rows.size !== strategies.length)) {
    throw new Error('incomplete_or_mixed_opportunity');
  }
  const totals = strategies.map(strategy => {
    const rows = [...cases.values()].map(entry => entry.rows.get(strategy));
    const costMicros = rows.reduce((sum, row) => sum + row.costMicros, 0);
    if (!Number.isSafeInteger(costMicros)) throw new Error('opportunity_cost_overflow');
    return { strategy, solved: rows.reduce((sum, row) => sum + row.score, 0), costMicros,
      configurations: [...new Set(rows.map(row => row.configurationId))].sort() };
  });
  const rows = [...cases].sort(([a], [b]) => a.localeCompare(b)).map(([caseId, entry]) => ({
    caseId, solvedBy: strategies.filter(strategy => entry.rows.get(strategy).score === 1),
  }));
  const oracleSolved = rows.filter(row => row.solvedBy.length > 0).length;
  const bestFixedSolved = Math.max(...totals.map(row => row.solved));
  const allCandidatesCostMicros = totals.reduce((sum, row) => sum + row.costMicros, 0);
  if (!Number.isSafeInteger(allCandidatesCostMicros)) throw new Error('opportunity_cost_overflow');
  return { version: 1, kind: 'hindsight-opportunity', split: [...splits][0], trial, sources,
    cases: cases.size, strategies: totals, oracleSolved, bestFixedSolved,
    potentialAdditionalSolved: oracleSolved - bestFixedSolved,
    allFailCases: rows.filter(row => row.solvedBy.length === 0).map(row => row.caseId),
    allCandidatesCostMicros, rows,
    limitations: ['Oracle selection uses hidden outcomes and is not deployable.',
      'Different source configurations and revisions are retained; this is not a matched causal comparison.',
      'All-candidate cost excludes a selector; production selection adds cost and can lose correct answers.'] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [names, trialText, ...files] = process.argv.slice(2);
    if (!names || !/^\d+$/.test(trialText ?? '') || !files.length) throw new Error('invalid_cli');
    const inputs = [];
    for (const file of files) {
      if ((await stat(file)).size > 16 * 1024 * 1024) throw new Error('source_too_large');
      inputs.push(JSON.parse(await readFile(file, 'utf8')));
    }
    console.log(JSON.stringify(analyzeOpportunity(inputs, names.split(','), Number(trialText)), null, 2));
  } catch {
    console.error('Opportunity analysis failed: use <strategy,strategy> <trial> <runs.json>... with complete paired binary outcomes.');
    process.exitCode = 1;
  }
}
