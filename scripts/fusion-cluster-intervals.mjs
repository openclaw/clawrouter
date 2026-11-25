import { evaluateFusion } from './evaluate-fusion.mjs';

const metrics = ['scoreDelta95', 'costDelta95', 'costRatio95', 'latencyDelta95', 'latencyRatio95'];
const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
const ratio = (value, base) => base === 0 || !Number.isFinite(value / base) ? null : value / base;
const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];

/** Resample complete domains, preserving paired strategies and repeated tasks. */
export function clusteredFusionIntervals(input, baseline, expectedSplit = 'test') {
  const report = evaluateFusion(input, baseline, expectedSplit);
  const cases = new Map();
  for (const row of input.records) {
    if (!cases.has(row.caseId)) cases.set(row.caseId, { domain: row.domain, trials: new Map() });
    const trials = cases.get(row.caseId).trials;
    if (!trials.has(row.trial)) trials.set(row.trial, new Map());
    trials.get(row.trial).set(row.strategy, row);
  }
  const comparisons = report.comparisons.map(({ strategy }) => {
    const domains = new Map();
    for (const [, task] of [...cases].sort(([a], [b]) => a.localeCompare(b))) {
      const trials = [...task.trials].sort(([a], [b]) => a - b).map(([, rows]) => {
        const row = rows.get(strategy), base = rows.get(baseline);
        return [row.score - base.score, row.costMicros, base.costMicros, row.latencyMs, base.latencyMs];
      });
      const values = Array.from({ length: 5 }, (_, i) => mean(trials.map(row => row[i])));
      if (!domains.has(task.domain)) domains.set(task.domain, { count: 0, sums: [0, 0, 0, 0, 0] });
      const group = domains.get(task.domain);
      group.count++;
      values.forEach((value, i) => { group.sums[i] += value; });
    }
    const groups = [...domains].sort(([a], [b]) => a.localeCompare(b)).map(([, group]) => group);
    const metadata = { strategy, baseline, cases: cases.size, clusters: groups.length };
    if (groups.length < 2) return { ...metadata, ...Object.fromEntries(metrics.map(key => [key, null])) };
    const samples = Object.fromEntries(metrics.map(key => [key, []]));
    let seed = 42;
    const random = () => { seed = (Math.imul(1664525, seed) + 1013904223) >>> 0; return seed / 4294967296; };
    for (let sample = 0; sample < 2000; sample++) {
      const sums = [0, 0, 0, 0, 0];
      let count = 0;
      for (let i = 0; i < groups.length; i++) {
        const group = groups[Math.floor(random() * groups.length)];
        count += group.count;
        group.sums.forEach((value, index) => { sums[index] += value; });
      }
      const [score, cost, baseCost, latency, baseLatency] = sums;
      const values = [score / count, (cost - baseCost) / count, ratio(cost, baseCost),
        (latency - baseLatency) / count, ratio(latency, baseLatency)];
      metrics.forEach((key, i) => { samples[key].push(values[i]); });
    }
    return { ...metadata, ...Object.fromEntries(metrics.map(key => [key, samples[key].includes(null) ? null : {
      low: percentile(samples[key], 0.025), high: percentile(samples[key], 0.975),
      method: 'paired domain-cluster bootstrap', samples: 2000, seed: 42,
    }])) };
  });
  return { clusterBy: 'domain', weighting: 'equal case; trials averaged within case; domains resampled together', comparisons };
}
