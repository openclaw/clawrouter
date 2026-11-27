import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { estimateCascadeBreakEven } from '../scripts/fusion-cascade-feasibility.mjs';
const stage = (costMicros, latencyMs) => ({ costMicros, latencyMs });
const input = () => ({ cheap: stage(100, 4), fallback: stage(1000, 10), strong: stage(1000, 10) });

test('latency and cost require separate acceptance rates', () => {
  const result = estimateCascadeBreakEven(input());
  assert.ok(Math.abs(result.minimumAcceptance.cost - 0.3) < 1e-12);
  assert.ok(Math.abs(result.minimumAcceptance.latency - 0.4) < 1e-12);
  assert.equal(result.minimumAcceptance.both, result.minimumAcceptance.latency);
  assert.deepEqual(result.targets, stage(800, 10));
});

test('an initial stage above either target cannot be rescued by perfect acceptance', () => {
  const cost = estimateCascadeBreakEven({ ...input(), cheap: stage(801, 4) });
  assert.equal(cost.minimumAcceptance.cost, null); assert.equal(cost.minimumAcceptance.both, null);
  assert.equal(cost.possibleUnderAssumptions, false);
  const time = estimateCascadeBreakEven({ ...input(), cheap: stage(100, 11) });
  assert.equal(time.minimumAcceptance.latency, null);
  assert.equal(time.possibleUnderAssumptions, false);
});

test('zero fallback work and an exactly exhausted target are distinct', () => {
  assert.equal(estimateCascadeBreakEven({ ...input(), fallback: stage(0, 0) }).minimumAcceptance.both, 0);
  assert.equal(estimateCascadeBreakEven({ ...input(), cheap: stage(800, 10) }).minimumAcceptance.both, 1);
  assert.equal(estimateCascadeBreakEven({ ...input(), cheap: stage(800, 10), fallback: stage(0, 0) }).minimumAcceptance.both, 0);
});

test('returned boundary satisfies both inequalities across different fallback costs and times', () => {
  for (const cheapCost of [0, 100, 700, 800]) for (const cheapTime of [0, 2, 9, 10]) {
    for (const fallbackCost of [100, 2000]) for (const fallbackTime of [1, 25]) {
      const value = { cheap: stage(cheapCost, cheapTime), fallback: stage(fallbackCost, fallbackTime), strong: stage(1000, 10) };
      const result = estimateCascadeBreakEven(value), p = result.minimumAcceptance.both;
      assert.ok(p >= 0 && p <= 1);
      assert.ok(cheapCost + (1-p)*fallbackCost <= result.targets.costMicros + 1e-10);
      assert.ok(cheapTime + (1-p)*fallbackTime <= result.targets.latencyMs + 1e-10);
      if (p > 0) {
        const lower = Math.max(0, p - 1e-5);
        assert.ok(cheapCost + (1-lower)*fallbackCost > result.targets.costMicros || cheapTime + (1-lower)*fallbackTime > result.targets.latencyMs);
      }
    }
  }
});

test('names invalid measurements and their accepted ranges', () => {
  for (const bad of [NaN, Infinity, -1, '1', null]) {
    assert.throws(() => estimateCascadeBreakEven({ ...input(), cheap: stage(bad, 1) }), /cheap\.costMicros.*finite nonnegative/);
  }
  for (const [value, expected] of [
    [null, /JSON object/],
    [{ ...input(), fallback: null }, /fallback must be an object with costMicros and latencyMs/],
    [{ ...input(), fallback: stage(1, -1) }, /fallback\.latencyMs.*finite nonnegative/],
    [{ ...input(), strong: stage(0, 1) }, /strong\.costMicros.*greater than zero/],
    [{ ...input(), strong: stage(1, 0) }, /strong\.latencyMs.*greater than zero/],
    [{ ...input(), latencyRatio: Infinity }, /latencyRatio.*greater than zero/],
    [{ ...input(), costSavingFraction: 1 }, /costSavingFraction.*0 .*1 /],
    [{ ...input(), strong: stage(1, Number.MAX_VALUE), latencyRatio: 2 }, /Reduce latencyRatio or strong\.latencyMs/],
  ]) {
    assert.throws(() => estimateCascadeBreakEven(value), expected);
  }
});

test('prints one actionable CLI diagnostic and exits unsuccessfully', t => {
  const directory = mkdtempSync(join(tmpdir(), 'fusion-feasibility-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'input.json');
  writeFileSync(path, JSON.stringify({ ...input(), cheap: stage(-1, 4) }));
  const cli = fileURLToPath(new URL('../scripts/fusion-cascade-feasibility.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [cli, path], { encoding: 'utf8' });
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr.trim(), 'cheap.costMicros must be a finite nonnegative number.');
});
