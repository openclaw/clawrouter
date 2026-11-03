import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

for (const provider of ['anthropic', 'responses']) test(`HTTP CPU diagnostic preserves ${provider} measurements and output`, async t => {
  const out = provider === 'anthropic' ? await mkdtemp(join(tmpdir(), 'http-cpu-smoke-')) : '';
  if (out) t.after(() => rm(out, { recursive: true, force: true }));
  const repetitions = provider === 'anthropic' ? 1 : 2, warmups = provider === 'anthropic' ? 1 : 0;
  const { stdout } = await promisify(execFile)(process.execPath, [`test/diagnostics/http-${provider}-cpu.test.mjs`], {
    timeout: 30_000,
    env: { ...process.env, NODE_TEST_CONTEXT: undefined, HTTP_CPU_RUNS: String(repetitions), HTTP_CPU_WARMUPS: String(warmups),
      HTTP_CPU_SIZES: '0.125', HTTP_CPU_DELTAS: '1', HTTP_CPU_COUNT_JSON: '1', HTTP_CPU_PROFILE: out ? '1' : '0', HTTP_CPU_OUT: out },
  });
  const summaries = stdout.split('\n').map(line => line.replace(/^# /, '')).filter(line => line.startsWith('{')).map(line => JSON.parse(line));
  const labels = (provider === 'anthropic' ? ['anthropic'] : ['unified', 'native']).flatMap(name => ['off', 'on'].map(retention => `${name}-0.125MiB-retention-${retention}`));
  assert.deepEqual(summaries.map(row => row.label), labels);
  for (const row of summaries) {
    assert.equal(row.repetitions, repetitions);
    assert.ok(row.requestBytes >= 0.125 * 1024 * 1024 - 100);
    assert.ok(row.responseBytes > 0);
    assert.ok(Number.isFinite(row.cpuMs) && row.cpuMs >= 0);
    assert.ok(Number.isFinite(row.headersCpuMs) && row.headersCpuMs >= 0);
    assert.equal(row.samples, undefined);
    assert.ok(Number.isFinite(row.largeJsonPerRequest.parse));
    assert.ok(Number.isFinite(row.largeJsonPerRequest.stringify));
  }
  if (out) {
    const report = JSON.parse(await readFile(join(out, 'results.json'), 'utf8'));
    assert.equal(report.warmups, warmups);
    assert.deepEqual(report.results.map(row => row.label), labels);
    for (const row of report.results) {
      assert.equal(row.samples.length, repetitions);
      assert.ok(row.samples.every(sample => sample.warm));
      const profile = JSON.parse(await readFile(join(out, `${row.label}.cpuprofile`), 'utf8'));
      assert.ok(profile.nodes.length > 0);
    }
  }
});
