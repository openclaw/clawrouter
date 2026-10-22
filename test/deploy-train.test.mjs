import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createApi, observeAnalytics } from '../scripts/deploy-train-api.mjs';
import { analyticsDecision, deploymentMessage, deploymentState, greenPushRun, recoveryDecision, splitVersions, verifyDispatch } from '../scripts/deploy-train-policy.mjs';
import { candidateCommits, selectCandidate, deployedSource } from '../scripts/deploy-train-select.mjs';
import { inspectSource } from '../scripts/deploy-train-source.mjs';
import { command, runTrain, uploadVersion } from '../scripts/deploy-train.mjs';
import { assertSecretLineage, uploadMessage } from '../scripts/deploy-train-secrets.mjs';
import { recoverRemote, failureIssue } from '../scripts/deploy-train-recover.mjs';

const blue = '11111111-1111-1111-1111-111111111111';
const green = '22222222-2222-2222-2222-222222222222';
const sha = 'a'.repeat(40), oldSha = 'b'.repeat(40);
function fixture({ unsafe = false, migration = false, failSmokeAt, failSmokePercentage, lostPost = false, analyticsRows = [] } = {}) {
  let deployment = { id: 'd0', versions: [{ version_id: blue, percentage: 100 }], annotations: {} };
  let versions = [{ id: blue }];
  let time = 1_000_000, smokes = 0, uploads = 0;
  const calls = [], receipts = [], smokeObservations = [];
  const state = { blue, sha, deployedSha: oldSha, run: '123', deploymentId: 'd0', unsafe, migration };
  const api = createApi({ env: { CLOUDFLARE_API_TOKEN: 'fixture-token', CLOUDFLARE_ACCOUNT_ID: 'fixture-account' }, fetchImpl: async (url, init) => {
    calls.push({ url, method: init.method, body: init.body && JSON.parse(init.body), time });
    const path = new URL(url).pathname;
    let result;
    if (path.endsWith('/deployments')) {
      if (init.method === 'POST') {
        const body = JSON.parse(init.body);
        deployment = { id: `d${calls.length}`, versions: body.versions, annotations: body.annotations };
        result = deployment;
        if (lostPost) { lostPost = false; throw new Error('Lost response after mutation'); }
      } else result = { deployments: [deployment] };
    } else if (path.endsWith('/versions')) result = { items: versions };
    else if (path.endsWith(`/versions/${green}`)) result = { id: green, annotations: { 'workers/tag': sha } };
    else if (path.endsWith('/graphql')) return Response.json({ data: { viewer: { accounts: [{ workersInvocationsAdaptive: analyticsRows }] } } });
    else throw new Error(`Unexpected API path: ${path}`);
    return Response.json({ success: true, result });
  } });
  const options = {
    state, api, now: () => time, wait: async (ms) => { time += ms; }, save: (value) => receipts.push(structuredClone(value)),
    upload: async () => { uploads++; versions.unshift({ id: green, annotations: { 'workers/tag': sha, 'workers/message': uploadMessage(state) } }); if (migration) deployment = { id: 'migration', versions: [{ version_id: green, percentage: 100 }] }; return green; },
    smoke: async () => {
      smokes++;
      smokeObservations.push({ percentage: state.percentage, time });
      time += 100;
      if (smokes === failSmokeAt || (failSmokePercentage !== undefined && state.percentage === failSmokePercentage)) throw new Error('Smoke HTTP 503');
    },
    analytics: async (a, s, t) => a.analytics({ start: new Date(s.startedAt).toISOString(), end: new Date(t).toISOString() }),
  };
  return { options, api, state, calls, receipts, smokeObservations, get deployment() { return deployment; }, get smokes() { return smokes; }, get uploads() { return uploads; } };
}
const posts = (f) => f.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/deployments')).map((c) => c.body);

test('train observes a five-minute canary with frequent smoke, keeps DO order, finishes green100', async () => {
  const f = fixture();
  await runTrain(f.options);
  assert.deepEqual(posts(f).map((p) => p.versions.map((v) => [v.version_id, v.percentage])), [0, 10, 50, 100, 100].map((n) => [[green, n], [blue, 100 - n]]));
  const deployments = f.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/deployments'));
  const tenPercentMs = deployments[2].time - deployments[1].time;
  const fiftyPercentMs = deployments[3].time - deployments[2].time;
  assert.ok(tenPercentMs >= 120_000 && tenPercentMs < 121_000, '10% holds for two minutes plus bounded fixture smoke overhead');
  assert.ok(fiftyPercentMs >= 180_000 && fiftyPercentMs < 181_000, '50% holds for three minutes plus bounded fixture smoke overhead');
  for (const percentage of [10, 50]) {
    const observations = f.smokeObservations.filter((s) => s.percentage === percentage);
    assert.ok(observations.length >= 5, 'each hold repeatedly exercises live smoke rather than just sleeping');
    for (let i = 1; i < observations.length; i++) {
      assert.ok(observations[i].time - observations[i - 1].time <= 30_100, 'no more than 30 seconds between completed smoke and the next check');
    }
  }
  assert.equal(f.state.status, 'done');
  assert.equal(deploymentState(f.deployment).status, 'done');
  assert.equal(f.receipts.find((r) => r.percentage === 0).exposed, true, 'exposure journal precedes the first smoke');
});

test('zero-only success removes candidate and leaves exactly blue100', async () => {
  const f = fixture();
  await runTrain({ ...f.options, mode: 'zero-smoke' });
  assert.equal(f.smokes, 1);
  assert.equal(f.state.status, 'rehearsed');
  assert.equal(f.state.deploymentId, f.deployment.id);
  assert.deepEqual(f.deployment.versions, [{ version_id: blue, percentage: 100 }]);
});

for (const [name, percentage] of [['initial override', 0], ['10 percent', 10], ['50 percent', 50], ['final full cutover', 100]]) {
  test(`smoke breach at ${name} restores blue and throws`, async () => {
    const f = fixture({ failSmokePercentage: percentage });
    await assert.rejects(runTrain(f.options), /Smoke HTTP 503/);
    assert.equal(f.state.status, 'rolled-back');
    assert.equal(f.state.deploymentId, f.deployment.id);
    assert.deepEqual(f.deployment.versions, [{ version_id: blue, percentage: 100 }]);
  });
}

test('injected negative zero-smoke failure never assigns user traffic to green', async () => {
  const f = fixture();
  await assert.rejects(runTrain({ ...f.options, mode: 'zero-failure' }), /Deliberate 0% smoke failure/);
  assert.equal(f.smokes, 0);
  assert.deepEqual(posts(f).map((p) => p.versions), [splitVersions(blue, green, 0), [{ version_id: blue, percentage: 100 }]]);
});

test('rollback-unsafe exposure at zero freezes without rolling storage backwards', async () => {
  const f = fixture({ unsafe: true, failSmokeAt: 1 });
  await assert.rejects(runTrain(f.options), /Smoke HTTP 503/);
  assert.equal(f.state.recovery, 'freeze');
  assert.equal(posts(f).length, 1);
  assert.equal(await recoverRemote(f.api, '123'), 'freeze');
  assert.equal(posts(f).length, 1);
});

test('no-impact rehearsals refuse migration or unsafe candidates before upload', async () => {
  for (const flags of [{ unsafe: true }, { migration: true }]) {
    const f = fixture(flags);
    await assert.rejects(runTrain({ ...f.options, mode: 'zero-smoke' }), /No-impact/);
    assert.equal(f.uploads, 0);
  }
});

test('migration uses one immediate deploy, smoke failure freezes and never posts rollback', async () => {
  const f = fixture({ migration: true, failSmokeAt: 1 });
  await assert.rejects(runTrain(f.options), /Smoke HTTP 503/);
  assert.equal(f.state.recovery, 'freeze');
  assert.equal(posts(f).length, 0);
  assert.deepEqual(f.deployment.versions, [{ version_id: green, percentage: 100 }]);
});

test('green runtime errors breach hold and automatically roll back', async () => {
  const f = fixture({ analyticsRows: [
    { dimensions: { scriptVersion: green }, sum: { requests: 100, errors: 10 } },
    { dimensions: { scriptVersion: blue }, sum: { requests: 100, errors: 1 } },
  ] });
  await assert.rejects(runTrain(f.options), /runtime error rate breached/);
  assert.equal(f.state.status, 'rolled-back');
  assert.equal(f.state.analytics.comparison, true);
  assert.deepEqual(f.deployment.versions, [{ version_id: blue, percentage: 100 }]);
});

test('insufficient traffic is explicit; absolute green errors still trip', () => {
  const rows = [{ dimensions: { scriptVersion: green }, sum: { requests: 10, errors: 3 } }];
  assert.equal(analyticsDecision(rows, blue, green).breach, true);
  assert.equal(analyticsDecision(rows, blue, green).comparison, false);
  assert.equal(analyticsDecision([], blue, green).comparison, false);
  assert.throws(() => analyticsDecision([{ dimensions: { scriptVersion: green }, sum: { requests: 1, errors: 2 } }], blue, green), /Invalid analytics/);
});

test('unavailable optional analytics is reported and mandatory smoke still gates', async () => {
  const f = fixture();
  await runTrain({ ...f.options, analytics: async () => ({ disabled: 'Account Analytics Read unavailable' }) });
  assert.equal(f.state.status, 'done');
  assert.match(f.state.analyticsDisabled, /unavailable/);
  assert.ok(f.smokes > 10);
});

test('lost deployment response is reconciled without retrying the mutation', async () => {
  const f = fixture({ lostPost: true });
  await runTrain({ ...f.options, mode: 'zero-smoke' });
  assert.equal(posts(f).length, 2);
  assert.equal(f.state.status, 'rehearsed');
});

test('independent recovery job reconstructs an interrupted rollout from Cloudflare annotations', async () => {
  const f = fixture();
  const s = { ...f.state, green, exposed: true, status: 'rolling' };
  await f.api.deploy(splitVersions(blue, green, 50), deploymentMessage(s), 'd0');
  assert.match(await recoverRemote(f.api, '123'), /^rollback/);
  assert.deepEqual(f.deployment.versions, [{ version_id: blue, percentage: 100 }]);
  assert.equal(await recoverRemote(f.api, '123'), 'rollback: blue restored to 100%');
  assert.equal(posts(f).length, 2, 'terminal recovery is idempotent without another write');
});

test('another train cannot overwrite an owned deployment and stale compare prevents mutation', async () => {
  const f = fixture();
  await f.api.deploy(splitVersions(blue, green, 10), deploymentMessage({ ...f.state, green, exposed: true, status: 'rolling' }), 'd0');
  assert.equal(await recoverRemote(f.api, '456'), 'no owned deployment to recover');
  await assert.rejects(f.api.deploy([{ version_id: blue, percentage: 100 }], 'stale', 'd0'), /changed outside/);
  assert.equal(posts(f).length, 1);
});

test('dispatch rejects short SHAs, non-main branches and stale expected SHA', () => {
  assert.doesNotThrow(() => verifyDispatch({ event: 'workflow_dispatch', expected: sha.toUpperCase(), sha, ref: 'refs/heads/main' }));
  assert.doesNotThrow(() => verifyDispatch({ event: 'schedule', sha, ref: 'refs/heads/main' }));
  for (const overrides of [{ expected: 'a'.repeat(7) }, { expected: oldSha }, { ref: 'refs/heads/feat/test' }, { event: 'push' }]) {
    assert.throws(() => verifyDispatch({ event: 'workflow_dispatch', expected: sha, sha, ref: 'refs/heads/main', ...overrides }));
  }
});

const run = (head, id, conclusion = 'success') => ({ id, head_sha: head, head_branch: 'main', event: 'push', run_attempt: 1, status: 'completed', conclusion });
const jobs = ['native-codex (0.153.0)', 'native-codex (0.155.0)', 'native-codex (0.156.1)', 'self-host', 'admin', 'admin-fusion-macos', 'worker-package'].map((name) => ({ name, status: 'completed', conclusion: 'success' }));
test('candidate selection skips newer red commits; skipped required checks never admit a candidate', async () => {
  const newer = 'c'.repeat(40), fallback = 'd'.repeat(40);
  const api = { github: async (path) => {
    if (path.includes('/jobs')) return { jobs, total_count: jobs.length };
    const head = new URL(`https://fixture${path}`).searchParams.get('head_sha');
    return { workflow_runs: [run(head, head === newer ? 3 : 2, head === newer ? 'failure' : 'success')] };
  } };
  assert.equal((await selectCandidate({ api, commits: [newer, fallback], deployedSha: oldSha })).sha, fallback);
  assert.equal(greenPushRun([run(sha, 1), run(sha, 2, 'failure')], sha), null);
  const skipped = { github: async (path) => path.includes('/jobs') ? { total_count: jobs.length, jobs: jobs.map((j) => ({ ...j, conclusion: j.name === 'worker-package' ? 'skipped' : 'success' })) } : { workflow_runs: [run(sha, 1)] } };
  await assert.rejects(selectCandidate({ api: skipped, commits: [sha], deployedSha: oldSha, manualSha: sha }), /lacks successful/);
  assert.equal((await selectCandidate({ api, commits: [], deployedSha: oldSha })).noop, true);
  assert.equal((await selectCandidate({ api, commits: [oldSha], deployedSha: oldSha, manualSha: oldSha })).noop, true);
});

test('legacy source requires exact Cloudflare version plus successful attested historical run', async () => {
  const deployment = { versions: [{ version_id: 'd06cab69-8847-46da-b6b6-cc1585b42371', percentage: 100 }] };
  const api = { version: async () => ({}), github: async () => ({ conclusion: 'success', head_sha: '478974c17edab8da283f4637ae706a4d63885a2e', event: 'workflow_dispatch', path: '.github/workflows/deploy-cloudflare.yml' }) };
  assert.equal((await deployedSource(api, deployment)).deployedSha, '478974c17edab8da283f4637ae706a4d63885a2e');
  await assert.rejects(deployedSource({ ...api, github: async () => ({ conclusion: 'failure' }) }, deployment), /attestation failed/);
  await assert.rejects(deployedSource(api, { versions: [{ version_id: blue, percentage: 100 }] }), /no verified/);
});

test('real git range detects TOML lifecycle changes and rollback-unsafe commit trailer', (t) => {
  mkdirSync('.artifacts', { recursive: true });
  const directory = mkdtempSync(join(process.cwd(), '.artifacts/train-source-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: directory, encoding: 'utf8' }).trim();
  const commit = (text, message) => { writeFileSync(join(directory, 'wrangler.toml'), text); git('add', '.'); git('commit', '-qm', message); return git('rev-parse', 'HEAD'); };
  git('init', '-q');
  const a = commit('name="fixture"\n[[migrations]]\ntag="v1"\nnew_sqlite_classes=["Ledger"]\n', 'first');
  const b = commit('# formatting and reordered fields only\nname = "fixture"\n[[migrations]]\nnew_sqlite_classes = ["Ledger"]\ntag = "v1"\n', 'format');
  assert.deepEqual(inspectSource({ blueSha: a, greenSha: b, cwd: directory }), { migration: false, unsafe: false });
  const c = commit('name="fixture"\n[[migrations]]\ntag="v2"\nnew_sqlite_classes=["SecondLedger"]\n', 'new class\n\nClawRouter-Rollback-Unsafe: forward-only fixture format');
  assert.deepEqual(inspectSource({ blueSha: a, greenSha: c, cwd: directory }), { migration: true, unsafe: true });
  assert.throws(() => inspectSource({ blueSha: a, greenSha: b, cwd: directory }), /checkout differs/);
  assert.deepEqual(candidateCommits(c, a, git), [], 'queued old event cannot downgrade a newer deployment');
  assert.deepEqual(candidateCommits(a, c, git), [c, b]);
  const d = commit('name="fixture"\n[[migrations]]\ntag="v2"\nnew_sqlite_classes=["SecondLedger"]\n[observability]\nenabled=false\n', 'non-versioned change');
  assert.throws(() => inspectSource({ blueSha: c, greenSha: d, cwd: directory }), /Non-versioned Worker settings/);
});

test('failure notification reopens and updates one issue without mentions or extra comments', async () => {
  const calls = [];
  const api = { github: async (path, options) => { calls.push({ path, options }); return options ? { number: 9 } : [{ number: 9, title: 'Production deployment train failures', state: 'closed', body: '<!-- clawrouter-production-train-failures -->' }]; } };
  await failureIssue(api, { run: '123', sha, result: 'freeze' });
  assert.equal(calls[1].path, '/issues/9');
  assert.equal(calls[1].options.method, 'PATCH');
  assert.equal(calls[1].options.body.state, 'open');
  assert.doesNotMatch(JSON.stringify(calls[1].options.body), /@|assignee/);
  assert.equal(calls.filter((c) => c.options).length, 1);
});

test('secret changes are refused before any upload process', async () => {
  await assert.rejects(uploadVersion({ blue, run: '123', sha, migration: false }, { CONFIGURE_PROVIDER_SECRETS: 'true' }), /excluded/);
});

test('rehearsed/abandoned code uploads preserve blue lineage, unrelated secret uploads cannot leak forward', () => {
  const candidate = (id, run) => ({ id, annotations: { 'workers/tag': sha, 'workers/message': uploadMessage({ blue, sha, run }) } });
  const previous = candidate(green, '123');
  const next = candidate('33333333-3333-3333-3333-333333333333', '124');
  assert.equal(assertSecretLineage([{ id: blue }], blue), blue);
  assert.equal(assertSecretLineage([next, previous, { id: blue }], blue), next.id);
  const external = { id: '44444444-4444-4444-4444-444444444444', annotations: { 'workers/message': 'secret bulk' } };
  assert.throws(() => assertSecretLineage([external, previous, { id: blue }], blue), /Unproven/);
  assert.throws(() => assertSecretLineage([next, external, previous, { id: blue }], blue), /Unproven/, 'interleaved foreign upload cannot be hidden by a later train annotation');
  assert.throws(() => assertSecretLineage([next, previous], blue), /outside available/);
});

test('Cloudflare analytics permission denial explicitly selects smoke-only mode', async () => {
  const api = createApi({ env: { CLOUDFLARE_API_TOKEN: 'fixture' }, fetchImpl: async () => new Response('', { status: 403 }) });
  const result = await observeAnalytics(api, { startedAt: 1_000 }, 100_000);
  assert.match(result.disabled, /Account Analytics Read/);
});

test('unsupported per-version GraphQL schema is not reported as a successful comparison', async () => {
  const api = createApi({ env: { CLOUDFLARE_API_TOKEN: 'fixture' }, fetchImpl: async () => Response.json({ errors: [{ message: 'Cannot query field scriptVersion' }] }) });
  const result = await api.analytics({ start: '2026-10-22T10:00:00Z', end: '2026-10-22T10:01:00Z' });
  assert.match(result.disabled, /per-version/);
  assert.equal(result.rows, undefined);
});

test('command timeout terminates a descendant CLI before recovery can proceed', async (t) => {
  mkdirSync('.artifacts', { recursive: true });
  const directory = mkdtempSync(join(process.cwd(), '.artifacts/train-timeout-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const executable = join(directory, 'pnpm'), receipt = join(directory, 'pid');
  writeFileSync(executable, `#!${process.execPath}
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], { stdio: 'inherit' });
writeFileSync(process.env.TEST_RECEIPT, String(child.pid));
setInterval(() => {}, 1000);
`);
  chmodSync(executable, 0o700);
  await assert.rejects(command(['fixture'], { env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, TEST_RECEIPT: receipt }, timeout: 500 }), /timed out/);
  const pid = Number(readFileSync(receipt, 'utf8'));
  // close is emitted after inherited pipes close; the forced process-group kill
  // has happened before command() rejects, not later during rollback.
  const terminal = () => {
    try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return true; throw error; }
    // Linux may retain a killed, reparented zombie until init reaps it. A PID
    // still existing is not evidence that it can execute or mutate a deployment.
    if (process.platform === 'linux') {
      try { return /^\d+ \(.*\) Z /.test(readFileSync(`/proc/${pid}/stat`, 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') return true; throw error; }
    }
    return false;
  };
  const deadline = Date.now() + 1_000;
  while (!terminal() && Date.now() < deadline) await delay(20);
  assert.equal(terminal(), true, 'descendant must have exited, not merely received a signal');
});
