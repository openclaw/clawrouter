import assert from 'node:assert/strict';
import { evaluateFusion } from './evaluate-fusion.mjs';

/** In-sample, query-independent control envelope. Never selects individual answers. */
export function compareRandomControl(input, candidate, controls, expectedSplit = 'test') {
  assert.ok(Array.isArray(controls) && controls.length >= 2 && controls.length <= 8
    && Array.from(controls).every(id => typeof id === 'string' && id !== candidate)
    && new Set(controls).size === controls.length, 'invalid_controls');
  const report = evaluateFusion(input, candidate, expectedSplit);
  const selected = report.strategies.find(row => row.strategy === candidate);
  const fixed = controls.map(id => {
    const row = report.strategies.find(entry => entry.strategy === id);
    assert.ok(row, 'unknown_control');
    return row;
  });
  const budget = selected.meanCostMicros;
  const options = fixed.filter(row => row.meanCostMicros <= budget).map(row => ({
    weights: [{ strategy: row.strategy, probability: 1 }],
    meanScore: row.meanScore, meanCostMicros: row.meanCostMicros, meanLatencyMs: row.meanLatencyMs,
  }));
  // With one expected-cost constraint, an optimum needs at most two controls.
  for (let i = 0; i < fixed.length; i++) {
    for (let j = i + 1; j < fixed.length; j++) {
      const [low, high] = [fixed[i], fixed[j]].sort((a, b) => a.meanCostMicros - b.meanCostMicros);
      if (!(low.meanCostMicros < budget && budget < high.meanCostMicros)) continue;
      const p = (budget - low.meanCostMicros) / (high.meanCostMicros - low.meanCostMicros);
      const mix = key => (1 - p) * low[key] + p * high[key];
      options.push({ weights: [{ strategy: low.strategy, probability: 1 - p },
        { strategy: high.strategy, probability: p }], meanScore: mix('meanScore'),
      meanCostMicros: budget, meanLatencyMs: mix('meanLatencyMs') });
    }
  }
  options.sort((a, b) => b.meanScore - a.meanScore || a.meanCostMicros - b.meanCostMicros
    || a.meanLatencyMs - b.meanLatencyMs);
  const control = options[0] ?? null;
  return {
    candidate, controls: [...controls], cases: selected.cases, pairedSamples: selected.runs,
    weighting: report.weighting,
    scope: 'retrospective expected-value envelope; weights fitted on these outcomes, not a held-out routing policy',
    candidateMeans: { score: selected.meanScore, costMicros: budget, latencyMs: selected.meanLatencyMs },
    control,
    scoreDelta: control ? selected.meanScore - control.meanScore : null,
    latencyDeltaMs: control ? selected.meanLatencyMs - control.meanLatencyMs : null,
    qualifiedProductionGain: false,
  };
}
