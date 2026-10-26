import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { observabilityReconciliation, verifyObservability } from '../scripts/deploy-train-observability.mjs';
import { inspectSource } from '../scripts/deploy-train-source.mjs';

const source = { logs: { enabled: true, head_sampling_rate: 1, invocation_logs: false } };
const live = { enabled: true, head_sampling_rate: 1, redact_query_string: false,
  logs: { enabled: true, head_sampling_rate: 1, invocation_logs: false, persist: true },
  traces: { enabled: false, head_sampling_rate: 1, persist: true } };
const marker = 'retained-diagnostics-v1';

test('only the exact retained diagnostics source profile can be reconciled', () => {
  assert.equal(observabilityReconciliation(null, source), marker);
  assert.equal(observabilityReconciliation(source, source), undefined);
  for (const candidate of [null, { enabled: true }, { logs: { ...source.logs, invocation_logs: true } }, { ...source, traces: { enabled: true } }, { logs: { ...source.logs, head_sampling_rate: 0.5 } }]) {
    assert.throws(() => observabilityReconciliation(source, candidate), /Non-versioned Worker settings/);
  }
});

test('live reconciliation reads script-only settings, records a receipt, accepts API defaults', async () => {
  for (const observability of [live, { enabled: true, logs: source.logs }]) {
    const state = { observabilityReconciliation: marker }, calls = [];
    await verifyObservability({ workerPath: '/worker', cloudflare: async (...args) => { calls.push(args); return { observability }; } }, state, 1000);
    assert.deepEqual(calls, [['/worker/script-settings']], 'GET only; no settings body or version settings endpoint');
    assert.equal(state.observabilityVerifiedAt, '1970-01-01T00:00:01.000Z');
  }
  await verifyObservability({}, {}, 1000); // unchanged source needs no new API permission
});

test('missing, changed, or unavailable live settings fail without a success receipt', async () => {
  const candidates = [null, undefined, {}, { ...live, enabled: false }, { ...live, logs: { ...live.logs, invocation_logs: true } },
    { ...live, logs: { ...live.logs, enabled: false } }, { ...live, logs: { ...live.logs, persist: false } },
    { ...live, head_sampling_rate: 0.5 }, { ...live, logs: { ...live.logs, head_sampling_rate: 0.5 } },
    { ...live, traces: { ...live.traces, enabled: true } }, { ...live, logs: { ...live.logs, destinations: ['private-destination'] } },
    { ...live, future_setting: true }];
  for (const observability of candidates) {
    const state = { observabilityReconciliation: marker };
    await assert.rejects(verifyObservability({ workerPath: '/worker', cloudflare: async () => ({ observability }) }, state), /Live observability does not match/);
    assert.equal(state.observabilityVerifiedAt, undefined);
  }
  await assert.rejects(verifyObservability({ cloudflare: async () => { throw new Error('HTTP 403'); } }, { observabilityReconciliation: marker }), /403/);
  await assert.rejects(verifyObservability({}, { observabilityReconciliation: 'unknown' }), /Unknown observability/);
});

test('real source ranges permit the retained profile but keep unrelated settings blocked', t => {
  mkdirSync('.artifacts', { recursive: true });
  const directory = mkdtempSync(join(process.cwd(), '.artifacts/train-observability-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: directory, encoding: 'utf8' }).trim();
  const commit = text => { writeFileSync(join(directory, 'wrangler.toml'), text); git('add', '.'); git('commit', '-qm', 'fixture'); return git('rev-parse', 'HEAD'); };
  git('init', '-q');
  const base = 'name="fixture"\n', logs = '\n[observability.logs]\nenabled=true\nhead_sampling_rate=1\ninvocation_logs=false\n';
  const blue = commit(base), green = commit(base + logs);
  assert.deepEqual(inspectSource({ blueSha: blue, greenSha: green, cwd: directory }), { migration: false, unsafe: false, observabilityReconciliation: marker });
  const migration = commit(base + '\n[[migrations]]\ntag="v1"\nnew_sqlite_classes=["Ledger"]\n' + logs);
  assert.throws(() => inspectSource({ blueSha: blue, greenSha: migration, cwd: directory }), /version-only candidate/, 'plain wrangler deploy can write settings, so lifecycle changes stay separate');
  // Even matching live logs cannot excuse a simultaneous change in these surfaces.
  for (const other of ['logpush=true\n', 'workers_dev=false\n', 'preview_urls=false\n',
    '[[routes]]\npattern="fixture.example"\n', '[[tail_consumers]]\nservice="fixture"\n',
    '[triggers]\ncrons=["* * * * *"]\n', '[[queues.consumers]]\nqueue="fixture"\n']) {
    const changed = commit(base + other + logs);
    assert.throws(() => inspectSource({ blueSha: blue, greenSha: changed, cwd: directory }), /Non-versioned Worker settings/);
  }
});
