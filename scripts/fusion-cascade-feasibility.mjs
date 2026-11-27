import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Planning arithmetic only: means and a constant conditional fallback are assumptions.
// Public acceptance does not establish full correctness or a confidence bound.
export function estimateCascadeBreakEven(input) {
  const { cheap, fallback, strong, costSavingFraction = 0.2, latencyRatio = 1 } = input;
  for (const stage of [cheap, fallback, strong]) {
    assert.ok(stage && typeof stage === 'object', 'stage_required');
    for (const key of ['costMicros', 'latencyMs']) {
      assert.ok(Number.isFinite(stage[key]) && stage[key] >= 0, 'invalid_stage_measure');
    }
  }
  assert.ok(strong.costMicros > 0 && strong.latencyMs > 0, 'positive_control_required');
  assert.ok(Number.isFinite(costSavingFraction) && costSavingFraction >= 0 && costSavingFraction < 1, 'invalid_saving_fraction');
  assert.ok(Number.isFinite(latencyRatio) && latencyRatio > 0, 'invalid_latency_ratio');
  const targets = { costMicros: (1 - costSavingFraction) * strong.costMicros, latencyMs: latencyRatio * strong.latencyMs };
  assert.ok(Object.values(targets).every(Number.isFinite), 'target_overflow');
  const required = key => {
    if (cheap[key] > targets[key]) return null;
    if (fallback[key] === 0) return 0;
    return Math.max(0, 1 - (targets[key] - cheap[key]) / fallback[key]);
  };
  const cost = required('costMicros'), latency = required('latencyMs');
  return { targets, minimumAcceptance: { cost, latency, both: cost === null || latency === null ? null : Math.max(cost, latency) },
    possibleUnderAssumptions: cost !== null && latency !== null };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assert.equal(process.argv.length, 3, 'usage: node scripts/fusion-cascade-feasibility.mjs INPUT.json');
  const bytes = await readFile(process.argv[2]);
  assert.ok(bytes.length <= 128 * 1024, 'input_too_large');
  console.log(JSON.stringify(estimateCascadeBreakEven(JSON.parse(bytes)), null, 2));
}
