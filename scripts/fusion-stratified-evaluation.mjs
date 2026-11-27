import { evaluateFusion } from './evaluate-fusion.mjs';
import { clusteredFusionIntervals } from './fusion-cluster-intervals.mjs';

const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/@+-]{0,127}$/.test(value);
const fields = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

/** Analyze a complete, externally pinned partition without discarding any runs. */
export function stratifiedFusionEvaluation(input, baseline, partition, expectedSplit = 'test') {
  const report = evaluateFusion(input, baseline, expectedSplit);
  if (!fields(partition, ['revision', 'assignments']) || !identifier(partition.revision)
    || !Array.isArray(partition.assignments)) throw new Error('Invalid Fusion partition');
  const cases = new Set(input.records.map(row => row.caseId));
  const assignments = new Map();
  for (const row of partition.assignments) {
    if (!fields(row, ['caseId', 'stratum']) || !identifier(row.caseId) || !identifier(row.stratum)
      || !cases.has(row.caseId) || assignments.has(row.caseId)) throw new Error('Invalid Fusion stratum assignment');
    assignments.set(row.caseId, row.stratum);
  }
  if (assignments.size !== cases.size) throw new Error('Fusion partition must cover every case');
  const strata = new Map();
  for (const row of input.records) {
    const stratum = assignments.get(row.caseId);
    if (!strata.has(stratum)) strata.set(stratum, []);
    strata.get(stratum).push(row);
  }
  return {
    partitionRevision: partition.revision,
    overall: { report, sourceClustered: clusteredFusionIntervals(input, baseline, expectedSplit) },
    strata: [...strata].sort(([a], [b]) => a.localeCompare(b)).map(([stratum, records]) => {
      const subset = { ...input, records };
      return { stratum, report: evaluateFusion(subset, baseline, expectedSplit),
        sourceClustered: clusteredFusionIntervals(subset, baseline, expectedSplit) };
    }),
  };
}
