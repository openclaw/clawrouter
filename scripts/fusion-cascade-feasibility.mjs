import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Planning arithmetic only: means and a constant conditional fallback are assumptions.
// Public acceptance does not establish full correctness or a confidence bound.
export function estimateCascadeBreakEven(input) {
  assert.ok(input && typeof input === 'object' && !Array.isArray(input), 'Input must be a JSON object with cheap, fallback and strong stages.');
  const { cheap, fallback, strong, costSavingFraction = 0.2, latencyRatio = 1 } = input;
  for (const [name, stage] of Object.entries({ cheap, fallback, strong })) {
    assert.ok(stage && typeof stage === 'object' && !Array.isArray(stage),
      `${name} must be an object with costMicros and latencyMs.`);
    for (const key of ['costMicros', 'latencyMs']) {
      const value = stage[key];
      if (name === 'strong') {
        assert.ok(Number.isFinite(value) && value > 0, `strong.${key} must be a finite number greater than zero.`);
      } else {
        assert.ok(Number.isFinite(value) && value >= 0, `${name}.${key} must be a finite nonnegative number.`);
      }
    }
  }
  assert.ok(Number.isFinite(costSavingFraction) && costSavingFraction >= 0 && costSavingFraction < 1,
    'costSavingFraction must be a finite number from 0 (inclusive) to 1 (exclusive).');
  assert.ok(Number.isFinite(latencyRatio) && latencyRatio > 0, 'latencyRatio must be a finite number greater than zero.');
  const targets = { costMicros: (1 - costSavingFraction) * strong.costMicros, latencyMs: latencyRatio * strong.latencyMs };
  assert.ok(Number.isFinite(targets.latencyMs), 'Reduce latencyRatio or strong.latencyMs so their product is finite.');
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
  try {
    assert.equal(process.argv.length, 3, 'Usage: node scripts/fusion-cascade-feasibility.mjs INPUT.json');
    const bytes = await readFile(process.argv[2]);
    assert.ok(bytes.length <= 128 * 1024, 'INPUT.json must be 128 KiB or smaller.');
    console.log(JSON.stringify(estimateCascadeBreakEven(JSON.parse(bytes)), null, 2));
  } catch (error) {
    console.error(error instanceof SyntaxError ? 'INPUT.json must contain valid JSON.' : error.message);
    process.exitCode = 1;
  }
}
