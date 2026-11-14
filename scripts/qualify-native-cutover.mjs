// Operates ONLY on coordinator-prepared isolated versions. No provisioning,
// secrets, upload, production override, inference, or registry writes.
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { isolatedNativeTarget, nativeTarget } from './deploy-native-target.mjs';
import { createApi } from './deploy-train-api.mjs';
import { createNativeControl, runNativeCutover, recoverNativeCutover, nativeWarm } from './deploy-native-cutover.mjs';
import { nativeBindings, nativeReceipt, nativeSource, verifyCutoverRecovery } from './deploy-train-runtime.mjs';
import { deploymentState, fullSha, versionId, stableVersion } from './deploy-train-policy.mjs';
import { nativeControlDigest } from './deploy-native-qualification.mjs';
import { smokeNativeCutover } from './smoke-native-cutover.mjs';
import { greenPushRun } from './deploy-train-policy.mjs';
import { successfulJobs } from './deploy-train-select.mjs';

export async function verifyIsolatedOwners(api, target, versions) {
  nativeTarget(target, { CLOUDFLARE_ACCOUNT_ID: target.account });
  if (!target.isolated) throw new Error('Qualification requires isolated target');
  const productionPath = '/accounts/' + target.account + '/workers/scripts/clawrouter-edge';
  const deployed = await api.cloudflare(productionPath + '/deployments');
  const production = await api.cloudflare(productionPath + '/versions/' + stableVersion(deployed.deployments[0]));
  nativeReceipt(production);
  const identities = bindings => bindings.flatMap(b => ['namespace_id','bucket_name','queue_name'].filter(k => b[k]).map(k => k + ':' + b[k]));
  const forbidden = new Set(identities(nativeBindings(production)));
  for (const version of versions) {
    nativeReceipt(version);
    const bindings = nativeBindings(version), vars = new Map(bindings.map(b => [b.name,b.text]));
    if (vars.get('LARGE_HTTP_ORIGIN') !== target.origin || identities(bindings).some(id => forbidden.has(id)))
      throw new Error('Qualification shares a production origin or persistent owner');
    if (bindings.some(b => b.type === 'service')) throw new Error('Qualification service bindings are not admitted');
  }
}
export async function qualifyNativeCutover({ api, control, target, sha, ids, mode, holdSeconds = 0, save = () => {}, wait = sleep, smoke = version => smokeNativeCutover({ target, env:{CLOUDFLARE_ACCOUNT_ID:target.account}, version }) }) {
  if (!['cutover','fail-smoke','interrupt-drain','interrupt-green','recover'].includes(mode)) throw new Error('Invalid qualification mode');
  if (!Number.isSafeInteger(holdSeconds) || holdSeconds < 0 || holdSeconds > 300) throw new Error('Invalid qualification hold');
  fullSha(sha);
  if (!ids || Object.keys(ids).sort().join() !== 'blue,green,recovery,run' || !/^[0-9]+$/.test(ids.run)) throw new Error('Invalid qualification version tuple');
  [ids.blue,ids.green,ids.recovery].forEach(versionId);
  const [blue,green,recovery,latest] = await Promise.all([api.version(ids.blue),api.version(ids.green),api.version(ids.recovery),api.latest()]);
  await verifyIsolatedOwners(api,target,[blue,green,recovery]);
  const state = { run: ids.run, sha, blue: ids.blue, green: ids.green, deploymentId: latest.id,
    status:'rolling', unsafe:false, migration:false, exposed:false, native:nativeReceipt(green),
    cutover:{schema:1,blueRuntimeSha:nativeReceipt(blue).runtimeSha,nativeSource:nativeSource(blue),recovery:ids.recovery,phase:'prepared'} };
  await verifyCutoverRecovery(api,state);
  const receipt = { schema:1, source:sha, controlSha256:nativeControlDigest(), worker:target.worker, origin:target.origin,
    blue:ids.blue,green:ids.green,recovery:ids.recovery,blueRuntimeSha:state.cutover.blueRuntimeSha,greenRuntimeSha:state.native.runtimeSha,
    startedAt:new Date().toISOString(), mode, qualified:false, observations:[],
    limits:['Controller evidence only; synthetic upstream, old-state/mixed-callback, accounting/envelope and saved Codex session evidence must be independently collected and reviewed.'] };
  const record = (phase, snapshot) => {
    // Explicit content-free fields only: no callback bodies, prompts, secrets or request IDs.
    const { accepting, phase:poolPhase, control:identity } = snapshot;
    const slots = snapshot.slots.map(({generation,phase,fingerprint,ids})=>({generation,phase,fingerprint,ids:ids.length}));
    const inspection = snapshot.inspection?.map(({slot,qualified,protocol,phase,generation,boot,fingerprint,runtimeSha,config})=>({slot,qualified,protocol,phase,generation,boot,fingerprint,runtimeSha,config:config && {runtimeSha:config.runtimeSha,fingerprint:config.fingerprint}}));
    receipt.observations.push({phase,at:new Date().toISOString(),accepting,poolPhase,control:identity && {schema:identity.schema,revision:identity.revision,runtimeSha:identity.runtimeSha,fingerprint:identity.fingerprint},slots,inspection,grants:snapshot.pool.grants.length,members:snapshot.pool.members.filter(Boolean).length,issued:snapshot.pool.issued,seen:Object.keys(snapshot.pool.seen).length}); save(receipt);
  };
  const observed = { snapshot: async version => { const s = await control.snapshot(version); record('snapshot:' + version,s); return s; },
    admission: async (...args) => { await control.admission(...args); if (mode === 'interrupt-drain' && !args[0]) throw interruption; } };
  const interruption = new Error('Deliberate isolated runner interruption');
  const restore = async () => {
    const remote = deploymentState(await api.latest());
    if (!remote || remote.run !== state.run || remote.sha !== sha || remote.blue !== ids.blue || remote.green !== ids.green || remote.cutover?.recovery !== ids.recovery)
      throw new Error('No exact owned qualification journal to recover');
    await recoverNativeCutover({ api, control:{snapshot:observed.snapshot,admission:(...args)=>control.admission(...args)}, state:remote });
    const active = stableVersion(await api.latest()), snapshot = await control.snapshot(active);
    if (active !== ids.recovery || !nativeWarm(snapshot,state.cutover.blueRuntimeSha)) throw new Error('Qualification recovery is not attested');
    await smoke(active);
    record('recovered',snapshot);
  };
  try {
    if (mode === 'recover') await restore();
    else await runNativeCutover({api,state,control:observed,smoke:async version => {
      record('green-warm',await control.snapshot(version));
      await smoke(version);
      // Allows the coordinator's independent saved client to finish its distinct
      // follow-up, then begin the active recovery-direction turn. No auto replay.
      if (holdSeconds) await wait(holdSeconds * 1000);
      if (mode === 'interrupt-green') throw interruption;
      if (mode === 'fail-smoke') throw new Error('Deliberate isolated smoke failure');
    }});
    receipt.result = mode === 'recover' ? 'recovered' : 'cutover-completed';
  } catch (error) {
    if (error === interruption) receipt.result = 'interrupted';
    else if (mode === 'fail-smoke' && error.message === 'Deliberate isolated smoke failure') { await restore(); receipt.result = 'failure-recovered'; }
    else { receipt.result = 'failed'; throw error; }
  } finally { receipt.finishedAt = new Date().toISOString(); save(receipt); }
  return receipt;
}
export async function main(env = process.env) {
  if (env.GITHUB_REPOSITORY !== 'openclaw/clawrouter' || env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || env.GITHUB_REF !== 'refs/heads/main' ||
      fullSha(env.EXPECTED_SHA) !== env.GITHUB_SHA || execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim() !== env.GITHUB_SHA)
    throw new Error('Qualification requires exact reviewed main dispatch');
  const target = isolatedNativeTarget({worker:env.QUALIFICATION_WORKER,origin:env.QUALIFICATION_ORIGIN,account:env.CLOUDFLARE_ACCOUNT_ID});
  const api = createApi({env,target});
  // Never make recovery depend on CI availability after a runner is lost.
  if (env.QUALIFICATION_MODE !== 'recover') {
    const runs = await api.github('/actions/workflows/ci.yml/runs?branch=main&event=push&head_sha=' + env.GITHUB_SHA + '&per_page=100');
    const ci = greenPushRun(runs.workflow_runs,env.GITHUB_SHA);
    if (!ci || !await successfulJobs(api,ci)) throw new Error('Qualification lacks successful exact-source main CI');
  }
  const receipt = await qualifyNativeCutover({ api,control:createNativeControl({env,target}),target,
    sha:env.GITHUB_SHA,ids:JSON.parse(env.QUALIFICATION_VERSIONS),mode:env.QUALIFICATION_MODE,holdSeconds:Number(env.QUALIFICATION_HOLD_SECONDS || 0),
    save:receipt=>writeFileSync(env.QUALIFICATION_RECEIPT,JSON.stringify({...receipt,actionsRun:env.GITHUB_RUN_ID,actionsAttempt:env.GITHUB_RUN_ATTEMPT},null,2)+'\n',{mode:0o600}) });
  console.log('Isolated controller result: ' + receipt.result + '; hosted qualification remains incomplete.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
