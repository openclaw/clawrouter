// Built-ins only: identical code is used by the fresh-runner recovery job.
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { deploymentMessage, deploymentState, stableVersion } from './deploy-train-policy.mjs';
import { verifyCutoverRecovery, nativeReceipt, assertNativeOwners } from './deploy-train-runtime.mjs';
import { verifyObservability } from './deploy-train-observability.mjs';

export const NATIVE_PHASE_TIMEOUT_MS = 10 * 60_000; // includes the existing 460s native drain
function snapshotState(value) {
  if (value?.schema !== 2 || typeof value.accepting !== 'boolean' || !['serving','draining','closed'].includes(value.phase) ||
      !Array.isArray(value.slots) || value.slots.length !== 8 || value.slots.some(s => !Number.isSafeInteger(s.generation) || s.generation < 0 ||
        !['idle','starting','ready','draining','stopping','blocked'].includes(s.phase) || !/^[a-f0-9]{64}$/.test(s.fingerprint ?? '') || !Array.isArray(s.ids)) ||
      !Array.isArray(value.pool?.grants) || !Array.isArray(value.pool.members) || value.pool.members.length !== 8 ||
      !Number.isSafeInteger(value.pool.issued) || value.pool.issued < 0 || !value.pool.seen || typeof value.pool.seen !== 'object')
    throw new Error('Native control snapshot is incomplete');
  return value;
}
export function nativeDrained(value) {
  const s = snapshotState(value);
  // Idle is reached only after exact-generation destruction ACK + observed
  // absence. Closed alone also permits blocked slots and is insufficient.
  return !s.accepting && s.phase === 'closed' && s.slots.every(m => m.phase === 'idle' && m.ids.length === 0) &&
    s.pool.grants.length === 0 && s.pool.members.every(m => m === null) && s.pool.issued === 0 && Object.keys(s.pool.seen).length === 0;
}
export function nativeWarm(value, runtimeSha) {
  const s = snapshotState(value);
  const attested = runtimeSha === undefined || controlReady(s,runtimeSha) && Array.isArray(s.inspection) && s.inspection.length === 8 &&
    s.inspection.every((o,i) => o.slot === i && o.qualified === true && o.protocol === 1 && o.phase === 'ready' &&
      o.generation === s.slots[i].generation && o.boot === s.pool.members[i]?.boot && o.fingerprint === s.control.fingerprint &&
      o.runtimeSha === runtimeSha && o.config?.runtimeSha === runtimeSha && o.config?.fingerprint === s.control.fingerprint);
  return attested && s.accepting && s.phase === 'serving' && s.slots.every((m,i) => m.phase === 'ready' && m.generation > 0 &&
    m.fingerprint === s.slots[0].fingerprint && s.pool.members[i]?.quarantined === false &&
    /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(s.pool.members[i]?.boot ?? ''));
}
function controlReady(s,runtimeSha) {
  return s.control?.schema === 1 && Number.isSafeInteger(s.control.revision) && s.control.revision >= 0 &&
    s.control.runtimeSha === runtimeSha && /^[a-f0-9]{64}$/.test(s.control.fingerprint ?? '');
}
export function createNativeControl({ env = process.env, fetchImpl = fetch, wait = sleep } = {}) {
  if (!env.CLAWROUTER_NATIVE_ADMIN_TOKEN) throw new Error('Native cutover admin credential missing');
  if (Boolean(env.CF_ACCESS_CLIENT_ID) !== Boolean(env.CF_ACCESS_CLIENT_SECRET)) throw new Error('Native control Access credential pair incomplete');
  const headers = { authorization: 'Bearer ' + env.CLAWROUTER_NATIVE_ADMIN_TOKEN, 'content-type':'application/json' };
  if (env.CF_ACCESS_CLIENT_ID) Object.assign(headers, {'CF-Access-Client-Id':env.CF_ACCESS_CLIENT_ID,'CF-Access-Client-Secret':env.CF_ACCESS_CLIENT_SECRET});
  async function request(method, version, body) {
    let response;
    try { response = await fetchImpl('https://clawrouter.openclaw.ai/v1/admin/large-http', {
      method, headers, redirect:'error', signal:AbortSignal.timeout(20_000), ...(body ? {body:JSON.stringify(body)} : {}),
    }); } catch { throw new Error('Native control request failed; delivery may be unknown'); }
    if (!response.ok || version && response.headers.get('x-clawrouter-version-id') !== version) {
      await response.body?.cancel(); throw new Error('Native control HTTP ' + response.status + ' or selected-version mismatch');
    }
    return response.json();
  }
  return {
    async snapshot(version) { const result = await request('GET',version); if (result.status !== 200) throw new Error('Native control snapshot refused'); return { ...snapshotState(result.state), control: result.control, inspection: result.slots }; },
    async admission(accepting, version, { allowLegacy = false, runtimeSha } = {}) {
      const before = await this.snapshot(version);
      const fenced = controlReady(before,runtimeSha ?? before.control?.runtimeSha);
      if (!fenced && (!allowLegacy || accepting)) throw new Error('Native admission control protocol is not available');
      if (!fenced && before.accepting === false) return; // legacy is only ever closed, never reopened
      const expectedRevision = before.control?.revision;
      const body = fenced ? {accepting,expectedRevision,operationId:randomUUID()} : {accepting};
      let error;
      try { const result = await request('POST',version,body); if (result.status !== 200 || result.accepting !== accepting || fenced && result.revision !== expectedRevision + 1) throw new Error('Native admission acknowledgement differs'); }
      catch (cause) { error = cause; }
      // Never repeat an uncertain mutation. Reads reconcile a response lost after commit.
      for (let attempt=0; attempt<5; attempt++) {
        const after = await this.snapshot(version);
        if (after.accepting === accepting && (!fenced || after.control?.revision === expectedRevision + 1)) return;
        if (attempt<4) await wait(1000);
      }
      throw error || new Error('Native admission readback differs');
    },
  };
}
function sameOwner(remote, state) {
  return remote?.run === String(state.run) && remote.blue === state.blue && remote.green === state.green && remote.sha === state.sha &&
    remote.native?.runtimeSha === state.native?.runtimeSha && remote.cutover?.blueRuntimeSha === state.cutover?.blueRuntimeSha && remote.cutover?.recovery === state.cutover?.recovery && remote.cutover?.nativeSource === state.cutover?.nativeSource;
}
async function owned(api, state) {
  const latest = await api.latest(), remote = deploymentState(latest);
  if (!sameOwner(remote,state)) throw new Error('Native cutover latest deployment is not owned by this train');
  return {latest,remote};
}
async function journal(api,state,version,phase,save,status='rolling',immediate=false) {
  const next = {...state,status,exposed:true,cutover:{...state.cutover,phase}};
  const result = await api.deploy([{version_id:version,percentage:100}],deploymentMessage(next),state.deploymentId,{immediate});
  Object.assign(state,next,{deploymentId:result.id});save(state);
}
async function converge({api,state,control,version,kind,now,wait,timeoutMs}) {
  const deadline = now()+timeoutMs;
  for (;;) {
    const {latest} = await owned(api,state);
    if (stableVersion(latest) !== version || latest.id !== state.deploymentId) throw new Error('Native cutover deployment changed during convergence');
    const s = await control.snapshot(version);
    const runtimeSha = version === state.green ? state.native.runtimeSha : state.cutover.blueRuntimeSha;
    if (kind === 'drain' ? nativeDrained(s) : kind === 'control' ? controlReady(s,runtimeSha) : nativeWarm(s,runtimeSha)) return;
    if (s.slots.some(m=>m.phase==='blocked')) throw new Error('Native slot destruction is unresolved; preserve custody and inspect');
    if (now()>=deadline) throw new Error('Native ' + kind + ' deadline exceeded; preserve the remote recovery journal');
    await wait(Math.min(2000,deadline-now()));
  }
}
export async function runNativeCutover({api,state,control,smoke,save=()=>{},now=Date.now,wait=sleep,timeoutMs=NATIVE_PHASE_TIMEOUT_MS}) {
  await verifyCutoverRecovery(api,state);
  const latest = await api.latest();
  if (latest.id !== state.deploymentId || stableVersion(latest) !== state.blue ||
      new Set(latest.versions.map(v=>v.version_id)).size !== latest.versions.length ||
      latest.versions.some(v=>v.percentage !== (v.version_id===state.blue?100:0))) throw new Error('Native cutover requires unchanged stable blue deployment');
  // Ordinary completion retains its former blue at 0%. Prove those existing
  // entries share the selected payload/owners, then the first owned journal
  // removes them before admission closes. Never add the incompatible candidate.
  const blue = await api.version(state.blue);
  for (const entry of latest.versions.filter(v=>v.version_id!==state.blue)) {
    const previous = await api.version(entry.version_id);
    if (nativeReceipt(previous).runtimeSha !== state.cutover.blueRuntimeSha) throw new Error('Existing zero-percent version has an incompatible native runtime');
    assertNativeOwners(blue,previous);
  }
  if (!nativeWarm(await control.snapshot(state.blue))) throw new Error('Native cutover requires healthy accepting blue capacity');
  // Journal BEFORE the admission write. A runner lost at any subsequent point
  // leaves enough remote custody for recovery without its filesystem/artifacts.
  await verifyObservability(api,state,now());
  await journal(api,state,state.blue,'draining',save);
  await control.admission(false,state.blue,{allowLegacy:true,runtimeSha:state.cutover.blueRuntimeSha});
  await converge({api,state,control,version:state.blue,kind:'drain',now,wait,timeoutMs});
  await verifyCutoverRecovery(api,state);
  // A full traffic switch alone can leave active DOs on old code for five
  // minutes. Immediate adoption is scoped to the already-drained switch.
  await verifyObservability(api,state,now());
  await journal(api,state,state.green,'warming',save,'rolling',true);
  await converge({api,state,control,version:state.green,kind:'control',now,wait,timeoutMs:Math.min(timeoutMs,60_000)});
  await control.admission(true,state.green,{runtimeSha:state.native.runtimeSha});
  await converge({api,state,control,version:state.green,kind:'warm',now,wait,timeoutMs});
  await verifyObservability(api,state,now());
  await smoke(state.green);
  await owned(api,state);
  await journal(api,state,state.green,'warming',save,'done');
  return state;
}
export async function recoverNativeCutover({api,state,control,save=()=>{},now=Date.now,wait=sleep,timeoutMs=NATIVE_PHASE_TIMEOUT_MS}) {
  const {latest,remote} = await owned(api,state);
  await verifyCutoverRecovery(api,remote);
  Object.assign(state,remote,{deploymentId:latest.id});
  if (state.status==='done' || state.status==='rolled-back') return 'none';
  const active = stableVersion(latest);
  // Recovery is another ordered replacement, never the percentage rollback.
  // Re-entry uses the same read-backed admission value and durable actor intents.
  if (state.cutover.phase !== 'recover-warming') {
    const phase = active===state.blue?'recover-draining-blue':active===state.green?'recover-draining-green':'recover-draining-recovery';
    if (state.cutover.phase !== phase) await journal(api,state,active,phase,save);
    if (active !== state.blue) await converge({api,state,control,version:active,kind:'control',now,wait,timeoutMs:Math.min(timeoutMs,60_000)});
    await control.admission(false,active,{allowLegacy:active===state.blue,runtimeSha:active===state.green?state.native.runtimeSha:state.cutover.blueRuntimeSha});
    await converge({api,state,control,version:active,kind:'drain',now,wait,timeoutMs});
    await verifyCutoverRecovery(api,state);
    await journal(api,state,state.cutover.recovery,'recover-warming',save,'rolling',true);
  }
  await converge({api,state,control,version:state.cutover.recovery,kind:'control',now,wait,timeoutMs:Math.min(timeoutMs,60_000)});
  await control.admission(true,state.cutover.recovery,{runtimeSha:state.cutover.blueRuntimeSha});
  await converge({api,state,control,version:state.cutover.recovery,kind:'warm',now,wait,timeoutMs});
  await journal(api,state,state.cutover.recovery,'recover-warming',save,'rolled-back');
  state.recovery='compatible-native-restored'; save(state);
  return 'compatible-native-restored';
}
