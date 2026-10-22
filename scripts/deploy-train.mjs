import assert from 'node:assert/strict';
import { waitForHealth } from './smoke-readiness.mjs';
import { createVersionFetch } from './smoke-version.mjs';
import { spawn } from 'node:child_process';
import { appendFileSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { createApi, observeAnalytics } from './deploy-train-api.mjs';
import { analyticsDecision, LEGACY_DEPLOYMENT, deploymentMessage, deploymentState, POLL_MS, recoveryDecision, splitVersions, stableVersion, TRAIN_STEPS, versionId } from './deploy-train-policy.mjs';
import { inspectSource } from './deploy-train-source.mjs';
import { startQueueObservation } from './deploy-queue-observation.mjs';
import { assertAssetBootstrap, publishConsoleAssets, verifyConsoleAssets } from './deploy-console-assets.mjs';
import { assertSecretLineage, uploadMessage } from './deploy-train-secrets.mjs';

export function command(args, { env = process.env, timeout = 10 * 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('pnpm', args, { env: { ...env, CI: 'true', WRANGLER_SEND_METRICS: 'false' }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', bytes = 0, stopped = false, force;
    const killGroup = (signal) => { try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; } };
    const stop = () => {
      if (stopped) return;
      stopped = true;
      killGroup('SIGTERM');
      force = setTimeout(() => killGroup('SIGKILL'), 5_000);
    };
    const timer = setTimeout(stop, timeout);
    child.stdout.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > 8 * 1024 * 1024) return stop();
      stdout += chunk.toString(); process.stdout.write(chunk);
    });
    child.stderr.on('data', (chunk) => { bytes += chunk.length; if (bytes > 8 * 1024 * 1024) return stop(); process.stderr.write(chunk); });
    child.on('error', () => { clearTimeout(timer); clearTimeout(force); reject(new Error('Could not start deployment command')); });
    child.on('close', (code) => {
      clearTimeout(timer); clearTimeout(force);
      // Ensure a timed-out pnpm cannot leave Wrangler running after rollback.
      if (stopped) killGroup('SIGKILL');
      if (stopped || code !== 0) reject(new Error(`Deployment command ${args.slice(0, 3).join(' ')} failed or timed out`));
      else resolve(stdout);
    });
  });
}
export async function uploadVersion(state, env = process.env) {
  if (env.CONFIGURE_PROVIDER_SECRETS === 'true') throw new Error('Secret changes are excluded from the unattended train');
  const args = ['exec', 'wrangler', ...(state.migration ? ['deploy'] : ['versions', 'upload']), '--config', '.wrangler.generated.toml', '--tag', state.sha, '--message', uploadMessage(state)];
  const output = await command(args, { env, timeout: 12 * 60_000 });
  const matches = [...output.matchAll(/(?:Worker|Current) Version ID:\s*([a-f0-9-]{36})/gi)];
  if (matches.length !== 1) throw new Error('Upload did not return one unambiguous version ID');
  return versionId(matches[0][1]);
}
export async function recoverTrain({ api, state, save = () => {} }) {
  const action = recoveryDecision(state);
  if (action === 'none') return action;
  if (action === 'freeze') { state.recovery = 'freeze'; save(state); return action; }
  const latest = await api.latest();
  const remote = deploymentState(latest);
  if (!remote || remote.run !== String(state.run) || remote.blue !== state.blue || remote.green !== state.green) {
    // Upload-only failure needs no rollback; an unrelated deployment must not be overwritten.
    if (latest.id === state.deploymentId) return 'none';
    throw new Error('Cannot recover: latest deployment is not owned by this train');
  }
  if (recoveryDecision(remote) === 'freeze') { state.recovery = 'freeze'; save(state); return 'freeze'; }
  if (recoveryDecision(remote) === 'none') return 'none';
  const rolledBack = { ...state, status: 'rolled-back' };
  await api.deploy([{ version_id: state.blue, percentage: 100 }], deploymentMessage(rolledBack), latest.id);
  state.status = 'rolled-back'; state.recovery = 'rollback'; save(state);
  return 'rollback';
}
export async function runTrain({ state, api, upload, smoke, save = () => {}, now = Date.now, wait = sleep, analytics = observeAnalytics, mode = 'rollout', negativeSmoke = async () => { throw new Error('Deliberate 0% smoke failure'); } }) {
  if (!['rollout', 'zero-smoke', 'zero-failure'].includes(mode)) throw new Error('Invalid train mode');
  if (mode !== 'rollout' && (state.migration || state.unsafe)) throw new Error('No-impact rehearsals cannot include lifecycle or rollback-unsafe changes');
  state.status = 'rolling'; state.startedAt = now(); state.exposed = false; save(state);
  try {
    // Mark before the potentially irreversible command: a timeout cannot erase the gate.
    if (state.migration) { state.exposed = true; save(state); }
    const beforeUpload = await api.latest();
    if (beforeUpload.id !== state.deploymentId) throw new Error('Deployment changed since preflight');
    assertSecretLineage(await api.versions(), state.blue);
    state.green = await upload(state); save(state);
    const uploaded = await api.versions();
    if (assertSecretLineage(uploaded, state.blue) !== state.green) throw new Error('Latest upload changed during candidate creation');
    const version = await api.version(state.green);
    if (version.annotations?.['workers/tag'] !== state.sha) throw new Error('Uploaded version does not attest candidate SHA');
    if (state.migration) {
      const deployed = await api.latest();
      if (stableVersion(deployed) !== state.green) throw new Error('Migration deploy did not activate expected version');
      state.deploymentId = deployed.id; save(state);
      await smoke(state.green);
      state.status = 'done'; save(state);
      return state;
    }
    // Probe capability separately; a denied optional Analytics permission must not
    // fail every train. Smoke remains mandatory and the disabled gate is explicit.
    const capability = await analytics(api, { ...state, startedAt: now() - 5 * 60_000 }, now());
    if (capability.disabled) state.analyticsDisabled = capability.disabled;
    save(state);
    for (const step of TRAIN_STEPS) {
      // Non-HTTP trigger selection is not a canary guarantee. Conservatively mark
      // exposure BEFORE inclusion, also covering synthetic DO writes at zero percent.
      state.exposed = true; state.percentage = step.percentage; save(state);
      const deployment = await api.deploy(splitVersions(state.blue, state.green, step.percentage), deploymentMessage(state), state.deploymentId);
      state.deploymentId = deployment.id; save(state);
      if (mode === 'zero-failure') await negativeSmoke(state.green);
      const deadline = now() + step.holdMs;
      do {
        await smoke(state.green);
        if (now() - state.startedAt > 60_000) {
          const observation = await analytics(api, state, now());
          if (observation.disabled) {
            state.analyticsDisabled = observation.disabled;
          } else {
            state.analytics = analyticsDecision(observation.rows, state.blue, state.green);
            if (state.analytics.breach) throw new Error('Green per-version runtime error rate breached');
          }
          save(state);
        }
        if (now() >= deadline) break;
        await wait(Math.min(POLL_MS, deadline - now()));
      } while (true);
      if (mode === 'zero-smoke') {
        await api.deploy([{ version_id: state.blue, percentage: 100 }], deploymentMessage({ ...state, status: 'rehearsed' }), state.deploymentId);
        state.status = 'rehearsed'; save(state); return state;
      }
    }
    // A terminal receipt is remote as well as local. The failure job can distinguish
    // a completed train from a runner that vanished during the last smoke.
    const completed = await api.deploy(splitVersions(state.blue, state.green, 100), deploymentMessage({ ...state, status: 'done' }), state.deploymentId);
    state.deploymentId = completed.id; state.status = 'done'; save(state);
    return state;
  } catch (error) {
    state.failure = error.message; save(state);
    try { await recoverTrain({ api, state, save }); } catch (recovery) { state.recovery = 'failed'; state.recoveryFailure = recovery.message; save(state); }
    throw error;
  }
}
function saveState(path, state) {
  writeFileSync(`${path}.tmp`, JSON.stringify(state, null, 2));
  renameSync(`${path}.tmp`, path);
}
export async function main(env = process.env) {
  const state = JSON.parse(readFileSync(env.TRAIN_PLAN_PATH, 'utf8'));
  if (state.noop) return;
  Object.assign(state, inspectSource({ blueSha: state.deployedSha, greenSha: state.sha }));
  assertAssetBootstrap(state.deployedSha);
  const save = (value) => saveState(env.TRAIN_STATE_PATH, value);
  save(state);
  const api = createApi({ env });
  appendFileSync(env.GITHUB_OUTPUT, `migration=${state.migration}\n`);
  const ready = (green) => waitForHealth({
    baseUrl: env.CLAWROUTER_BASE_URL,
    fetchImpl: createVersionFetch({ baseUrl: env.CLAWROUTER_BASE_URL, versionId: green, workerName: 'clawrouter-edge' }),
    probeImpl: (health) => assert.equal(health.versionId, green, 'selected green runtime'),
  });
  let stopObservation = async () => {};
  try {
    state.assets = await publishConsoleAssets({ sha: state.sha, env }); save(state);
    stopObservation = await startQueueObservation({ api, state, save, queue: env.CLAWROUTER_USAGE_QUEUE || 'clawrouter-usage' });
    await runTrain({ state, api, save, upload: (s) => uploadVersion(s, env), mode: env.TRAIN_MODE || 'rollout',
      smoke: async (green) => {
        await ready(green);
        await verifyConsoleAssets({ assets: state.assets, baseUrl: env.CLAWROUTER_BASE_URL, version: green });
        if (!state.migration) await verifyConsoleAssets({ assets: state.assets, baseUrl: env.CLAWROUTER_BASE_URL, version: state.blue, legacy: state.blue === LEGACY_DEPLOYMENT.version });
        await command(['cf:smoke'], { env: { ...env, CLAWROUTER_SMOKE_VERSION_ID: green }, timeout: 5 * 60_000 });
      },
      negativeSmoke: async (green) => {
        const health = await ready(green);
        console.log(`negative rehearsal reached green ${green}; asserting deliberately incorrect version`);
        if (health.versionId !== '00000000-0000-0000-0000-000000000000') throw new Error('Deliberate green 0% version-assertion breach');
        throw new Error('Negative rehearsal unexpectedly matched impossible version');
      },
    });
  } finally {
    await stopObservation();
    const summary = `## Production train\n- Candidate: \`${state.sha}\`\n- Blue: \`${state.blue}\`\n- Green: \`${state.green || 'not uploaded'}\`\n- Result: ${state.status || 'preflight'}; recovery: ${state.recovery || 'not needed'}\n- Lifecycle migration: ${state.migration}; rollback-unsafe range: ${state.unsafe}\n- Analytics: ${state.analyticsDisabled ? `DISABLED — ${state.analyticsDisabled}; mandatory smoke-only gating` : state.analytics ? JSON.stringify(state.analytics) : 'no comparison sample'}\n- Queue observation: ${state.queueObservationStatus || 'not started'}; ${JSON.stringify(state.queueObservations || [])}\n- Mode: ${env.TRAIN_MODE || 'rollout'}\n`;
    appendFileSync(env.GITHUB_STEP_SUMMARY, summary);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
