import { runDeployCli } from './deploy-cli.mjs';
import assert from 'node:assert/strict';
import { waitForHealth } from './smoke-readiness.mjs';
import { createVersionFetch } from './smoke-version.mjs';
import { appendFileSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';
import { createApi, observeAnalytics } from './deploy-train-api.mjs';
import { analyticsDecision, LEGACY_DEPLOYMENT, deploymentMessage, deploymentState, POLL_MS, recoveryDecision, splitVersions, stableVersion, TRAIN_STEPS, versionId } from './deploy-train-policy.mjs';
import { inspectSource } from './deploy-train-source.mjs';
import { verifyObservability } from './deploy-train-observability.mjs';
import { startQueueObservation } from './deploy-queue-observation.mjs';
import { assertAssetBootstrap, publishConsoleAssets, verifyConsoleAssets } from './deploy-console-assets.mjs';
import { assertSecretLineage, uploadMessage } from './deploy-train-secrets.mjs';
import { assertDeploymentAction, assertActivationAllowed } from './deploy-authorization.mjs';
import { nativeReceipt, assertRuntimePair, verifyRuntimeRecovery } from './deploy-train-runtime.mjs';
import { prepareNativeUpload, nativeUploadConfig } from './deploy-train-artifacts.mjs';
import { runNativeCutover, recoverNativeCutover, createNativeControl } from './deploy-native-cutover.mjs';
import { executeRelease } from './deploy-release-plan.mjs';
import { smokeNativeCutover } from './smoke-native-cutover.mjs';

export { command } from './deploy-command.mjs';
import { command } from './deploy-command.mjs';
export async function uploadVersion(state, env = process.env, recovery = false) {
  if (env.CONFIGURE_PROVIDER_SECRETS === 'true') throw new Error('Secret changes are excluded from the unattended train');
  if (state.migration) throw new Error('Native lifecycle migrations require a separately authorized release');
  const uploadState = recovery ? { ...state, nativeSource: state.cutover.nativeSource, native: { schema: 1, runtimeSha: state.cutover.blueRuntimeSha }, releaseManifest: state.recoveryReleaseManifest, releaseManifestSha256: state.recoveryReleaseManifestSha256 } : state;
  const config = await nativeUploadConfig(uploadState, { account: env.CLOUDFLARE_ACCOUNT_ID });
  const args = ['exec', 'wrangler', 'versions', 'upload', '--config', config, '--tag', state.sha, '--message', uploadMessage(uploadState)];
  const output = await command(args, { env, timeout: 12 * 60_000 });
  const matches = [...output.matchAll(/(?:Worker|Current) Version ID:\s*([a-f0-9-]{36})/gi)];
  if (matches.length !== 1) throw new Error('Upload did not return one unambiguous version ID');
  return versionId(matches[0][1]);
}
export async function recoverTrain({ api, state, save = () => {}, control, now, wait }) {
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
  if (remote.cutover) return recoverNativeCutover({ api, state, save, control: control ?? createNativeControl(), now, wait });
  await verifyRuntimeRecovery(api, remote);
  const rolledBack = { ...state, status: 'rolled-back' };
  const restored = await api.deploy([{ version_id: state.blue, percentage: 100 }], deploymentMessage(rolledBack), latest.id);
  state.deploymentId = restored.id; state.status = 'rolled-back'; state.recovery = 'rollback'; save(state);
  return 'rollback';
}
const UPLOAD_VISIBILITY_ATTEMPTS = 5, UPLOAD_VISIBILITY_STEP_MS = 1_000;
export async function runTrain({ state, api, upload, uploadRecovery, smoke, save = () => {}, now = Date.now, wait = sleep, analytics = observeAnalytics, mode = 'rollout', control, negativeSmoke = async () => { throw new Error('Deliberate 0% smoke failure'); } }) {
  if (!['rollout', 'zero-smoke', 'zero-failure', 'native-cutover', 'native-control'].includes(mode)) throw new Error('Invalid train mode');
  if (Boolean(state.cutover) !== ['native-cutover','native-control'].includes(mode) ||
      state.cutover && (state.cutover.kind === 'control') !== (mode === 'native-control')) throw new Error('Native cutover cannot enter a percentage rollout or a different purpose');
  if (state.cutover && !control) throw new Error('Native cutover control missing');
  if (mode !== 'rollout' && (state.migration || state.unsafe)) throw new Error('No-impact rehearsals cannot include lifecycle or rollback-unsafe changes');
  state.status = 'rolling'; state.startedAt = now(); state.exposed = false; save(state);
  try {
    await verifyObservability(api, state, now()); save(state);
    // Mark before the potentially irreversible command: a timeout cannot erase the gate.
    if (state.migration) { state.exposed = true; save(state); }
    const beforeUpload = await api.latest();
    if (beforeUpload.id !== state.deploymentId) throw new Error('Deployment changed since preflight');
    const blueVersion = await api.version(state.blue);
    const native = nativeReceipt(blueVersion);
    if ((state.cutover ? state.cutover.blueRuntimeSha !== native.runtimeSha : state.native && state.native.runtimeSha !== native.runtimeSha)) throw new Error('Native preflight receipt differs from deployed blue');
    if (!state.cutover) state.native = native;
    save(state);
    assertSecretLineage(await api.versions(), state.blue);
    if (state.cutover) {
      if (!uploadRecovery) throw new Error('Compatible recovery version uploader missing');
      state.cutover.recovery = await uploadRecovery(state); save(state);
    }
    state.green = await upload(state); save(state);
    // Cloudflare's version list can trail a just-completed upload. Re-read only
    // while the candidate is absent; any other newer upload still fails at once.
    let uploaded = await api.versions();
    for (let attempt = 1; attempt <= UPLOAD_VISIBILITY_ATTEMPTS && !uploaded.some(version => version.id === state.green); attempt++) {
      await wait(UPLOAD_VISIBILITY_STEP_MS * attempt);
      uploaded = await api.versions();
    }
    if (!uploaded.some(version => version.id === state.green)) throw new Error('Uploaded version did not appear in the version history');
    if (assertSecretLineage(uploaded, state.blue) !== state.green) throw new Error('Latest upload changed during candidate creation');
    // The per-version endpoint can 404 for a moment after the history lists it.
    let version;
    for (let attempt = 1; ; attempt++) {
      try { version = await api.version(state.green); break; }
      catch (error) {
        if (error?.status !== 404 || attempt > UPLOAD_VISIBILITY_ATTEMPTS) throw error;
        await wait(UPLOAD_VISIBILITY_STEP_MS * attempt);
      }
    }
    if (version.annotations?.['workers/tag'] !== state.sha) throw new Error('Uploaded version does not attest candidate SHA');
    if (state.cutover) return await runNativeCutover({ state, api, control, smoke, save, now, wait });
    assertRuntimePair(blueVersion, version, state);
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
      await verifyObservability(api, state, now()); save(state);
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
        await verifyRuntimeRecovery(api, state);
        const restored = await api.deploy([{ version_id: state.blue, percentage: 100 }], deploymentMessage({ ...state, status: 'rehearsed' }), state.deploymentId);
        state.deploymentId = restored.id; state.status = 'rehearsed'; save(state); return state;
      }
    }
    // A terminal receipt is remote as well as local. The failure job can distinguish
    // a completed train from a runner that vanished during the last smoke.
    const completed = await api.deploy(splitVersions(state.blue, state.green, 100), deploymentMessage({ ...state, status: 'done' }), state.deploymentId);
    state.deploymentId = completed.id; state.status = 'done'; save(state);
    return state;
  } catch (error) {
    state.failure = error.message; save(state);
    try { await recoverTrain({ api, state, save, control, now, wait }); } catch (recovery) { state.recovery = 'failed'; state.recoveryFailure = recovery.message; save(state); }
    throw error;
  }
}
function saveState(path, state) {
  writeFileSync(`${path}.tmp`, JSON.stringify(state, null, 2));
  renameSync(`${path}.tmp`, path);
}
export async function main(env = process.env) {
  assertDeploymentAction(env);
  assertActivationAllowed(env);
  const state = JSON.parse(readFileSync(env.TRAIN_PLAN_PATH, 'utf8'));
  if (state.noop) return;
  assertDeploymentAction(env,state.sha);
  Object.assign(state, inspectSource({ blueSha: state.deployedSha, greenSha: state.sha }));
  if(state.migration||state.unsafe)throw new Error('Development error: release needs an automated forward-compatible transition before it can deploy');
  assertAssetBootstrap(state.deployedSha);
  const save = (value) => saveState(env.TRAIN_STATE_PATH, value);
  const api = createApi({ env });
  await verifyObservability(api, state);
  // Build once, verify against deployed blue, then upload a build-hook-free
  // immutable config. This precedes even console publication and queue tails.
  await command(['exec', 'node', 'scripts/build-default-worker.mjs'], { env });
  await prepareNativeUpload({ state, blue: await api.version(state.blue), directory: `.wrangler/train-release-${state.run}`, mode:'auto' });
  if (state.sha===state.deployedSha && state.mode==='rollout') {
    state.status='done';state.noop=true;state.reason='Exact source and native artifact already deployed';save(state);return;
  }
  const control = state.cutover ? createNativeControl({ env }) : undefined;
  if (control) await control.snapshot(state.blue); // credential/readback preflight before publication or upload
  save(state);
  appendFileSync(env.GITHUB_OUTPUT, `migration=${state.migration}\n`);
  const ready = (green) => waitForHealth({
    baseUrl: env.CLAWROUTER_BASE_URL,
    fetchImpl: createVersionFetch({ baseUrl: env.CLAWROUTER_BASE_URL, versionId: green, workerName: 'clawrouter-edge' }),
    probeImpl: (health) => assert.equal(health.versionId, green, 'selected green runtime'),
  });
  let stopObservation = async () => {};
  try {
    await executeRelease({state,control,save,
      qualify:async(s,stage)=>{
        const plan=resolve(`.wrangler/qualification-${stage}.json`);saveState(plan,s);
        // Both checkouts have the same frozen SHA; dependencies live only in
        // candidate/. Run its packaging/client entrypoint from that checkout.
        await command(['exec','node',resolve('scripts/deploy-release-qualification.mjs')],{env:{...env,QUALIFICATION_PLAN_PATH:plan,QUALIFICATION_STAGE:stage},timeout:40*60_000});
        return JSON.parse(readFileSync(join(resolve(env.TRAIN_EVIDENCE_DIRECTORY),'public',`qualification-${stage}.json`),'utf8'));
      },
      run:async(s)=>{
      if(!state.assets){
        state.assets = await publishConsoleAssets({ sha: state.sha, env }); save(state);
        stopObservation = await startQueueObservation({ api, state, save, queue: env.CLAWROUTER_USAGE_QUEUE || 'clawrouter-usage' });
      }
      s.assets=state.assets;
      return runTrain({ state:s, api, save, upload: (s) => uploadVersion(s, env), uploadRecovery: (s) => uploadVersion(s, env, true), mode:s.mode, control,
      smoke: async (green) => {
        await ready(green);
        await verifyConsoleAssets({ assets: state.assets, baseUrl: env.CLAWROUTER_BASE_URL, version: green });
        if (!s.migration && !s.cutover) await verifyConsoleAssets({ assets: s.assets, baseUrl: env.CLAWROUTER_BASE_URL, version: s.blue, legacy: s.blue === LEGACY_DEPLOYMENT.version });
        if (s.cutover) await smokeNativeCutover({ version: green, env });
        else await command(['cf:smoke'], { env: { ...env, CLAWROUTER_SMOKE_VERSION_ID: green }, timeout: 5 * 60_000 });
      },
      negativeSmoke: async (green) => {
        const health = await ready(green);
        console.log(`negative rehearsal reached green ${green}; asserting deliberately incorrect version`);
        if (health.versionId !== '00000000-0000-0000-0000-000000000000') throw new Error('Deliberate green 0% version-assertion breach');
        throw new Error('Negative rehearsal unexpectedly matched impossible version');
      },
    });}});
  } finally {
    await stopObservation();
    const summary = `## Deploy ClawRouter\n- Frozen main: \`${state.sha}\`\n- Blue: \`${state.blue}\`\n- Green: \`${state.green || 'not uploaded'}\`\n- Result: ${state.status || 'preflight'}; recovery: ${state.recovery || 'not needed'}\n- Automatic path: ${state.mode}\n- Qualification: ${state.qualification?.reused ? state.qualification.reason : state.qualification?.qualified ? 'isolated cases passed and resources removed' : 'not completed'}\n- Analytics: ${state.analyticsDisabled ? `disabled: ${state.analyticsDisabled}; mandatory smoke gating` : state.analytics ? JSON.stringify(state.analytics) : 'no comparison sample'}\n- Cleanup has an independent job and artifact. A cleanup failure does not undo deployment.\n`;
    appendFileSync(env.GITHUB_STEP_SUMMARY, summary);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runDeployCli(() => main());
