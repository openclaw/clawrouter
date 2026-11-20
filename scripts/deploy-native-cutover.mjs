// Built-ins only: identical code is used by the fresh-runner recovery job.
import { randomUUID } from 'node:crypto';
import { nativeTarget } from './deploy-native-target.mjs';
import { setTimeout as sleep } from 'node:timers/promises';
import { deploymentMessage, deploymentState, stableVersion } from './deploy-train-policy.mjs';
import { verifyCutoverRecovery, nativeReceipt, assertNativeOwners } from './deploy-train-runtime.mjs';
import { verifyObservability } from './deploy-train-observability.mjs';

export const NATIVE_PHASE_TIMEOUT_MS = 10 * 60_000; // includes the existing 460s native drain
export class NativeControlVersionMismatch extends Error {
  constructor(expected, actual) {
    super('Native control selected-version mismatch: expected ' + expected + ', observed ' + actual);
    this.expected = expected; this.actual = actual;
  }
}
export class NativeControlHttpError extends Error {
  constructor(method, status, expected, actual) {
    super('Native control HTTP ' + status + (expected && actual !== expected ? '; selected-version mismatch (' + (actual === null ? 'missing' : 'invalid or unexpected') + ')' : ''));
    this.method = method; this.status = status; this.expected = expected;
    // Retain only a version ID, never arbitrary response headers or bodies.
    this.actual = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(actual ?? '') ? actual : null;
  }
}

// Convergence is explicit and bounded. A failed snapshot is never readiness,
// and neither this helper nor the HTTP client retries a mutation.
export async function observeNativeControl({ control, version, previousVersions = [], assertOwnership, isReady, validate = () => {},
  now = Date.now, wait = sleep, timeoutMs = NATIVE_PHASE_TIMEOUT_MS, pollMs = 2000, onPending = () => {}, onStatePending = () => {},
  deadlineMessage = 'Native control observation deadline exceeded; preserve custody' }) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(pollMs) || pollMs <= 0) throw new Error('Invalid native observation bounds');
  const deadline = now() + timeoutMs;
  const withinDeadline = () => { if (now() >= deadline) throw new Error(deadlineMessage); };
  for (;;) {
    withinDeadline();
    await assertOwnership();
    withinDeadline();
    let s;
    try { s = await control.snapshot(version); }
    catch (error) {
      const previous = error instanceof NativeControlVersionMismatch && error.expected === version && previousVersions.includes(error.actual);
      // HTTP500 alone cannot identify a reset. A GET stamped by the selected
      // or explicitly known previous version may remain pending only here;
      // ownership and the same deadline are checked on every observation.
      const unavailable = error instanceof NativeControlHttpError && error.method === 'GET' && error.status === 500 &&
        /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(version ?? '') && error.expected === version &&
        (error.actual === version || /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(error.actual ?? '') && previousVersions.includes(error.actual));
      if (!previous && !unavailable) throw error;
      onPending(previous ? {kind:'version',actual:error.actual} : {kind:'http',status:500,...(error.actual === version ? {} : {actual:error.actual})});
    }
    withinDeadline();
    if (s) {
      validate(s);
      if (isReady(s)) return s;
      onStatePending(s);
    }
    await wait(Math.min(pollMs, deadline - now()));
  }
}
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
export function nativeWarm(value, runtimeSha, { requireArtifactControl = false } = {}) {
  const s = snapshotState(value);
  const attested = (!requireArtifactControl || artifactControlReady(s)) && (runtimeSha === undefined || controlReady(s,runtimeSha) && Array.isArray(s.inspection) && s.inspection.length === 8 &&
    s.inspection.every((o,i) => o.slot === i && o.qualified === true && o.protocol === 1 && o.phase === 'ready' &&
      o.generation === s.slots[i].generation && o.boot === s.pool.members[i]?.boot && o.fingerprint === s.control.fingerprint &&
      o.runtimeSha === runtimeSha && o.config?.runtimeSha === runtimeSha && o.config?.fingerprint === s.control.fingerprint));
  return attested && s.accepting && s.phase === 'serving' && s.slots.every((m,i) => m.phase === 'ready' && m.generation > 0 &&
    m.fingerprint === s.slots[0].fingerprint && s.pool.members[i]?.quarantined === false &&
    /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(s.pool.members[i]?.boot ?? ''));
}
function artifactControlReady(s) {
  // Inspection comes from the actual slot controller, including while idle.
  // Equal native bytes cannot otherwise distinguish old and repaired control.
  return s.control?.artifactProtocol === 1 && Array.isArray(s.inspection) && s.inspection.length === 8 &&
    s.inspection.every((o,i) => o.slot === i && o.artifactProtocol === 1 && o.protocol === 1 &&
      o.config?.runtimeSha === s.control.runtimeSha && o.config?.fingerprint === s.control.fingerprint);
}
function controlReady(s,runtimeSha) {
  return s.control?.schema === 1 && Number.isSafeInteger(s.control.revision) && s.control.revision >= 0 &&
    s.control.runtimeSha === runtimeSha && /^[a-f0-9]{64}$/.test(s.control.fingerprint ?? '');
}
export function createNativeControl({ env = process.env, fetchImpl = fetch, wait = sleep, target } = {}) {
  const selected = nativeTarget(target, env);
  if (!env.CLAWROUTER_NATIVE_ADMIN_TOKEN) throw new Error('Native cutover admin credential missing');
  if (Boolean(env.CF_ACCESS_CLIENT_ID) !== Boolean(env.CF_ACCESS_CLIENT_SECRET)) throw new Error('Native control Access credential pair incomplete');
  const headers = { authorization: 'Bearer ' + env.CLAWROUTER_NATIVE_ADMIN_TOKEN, 'content-type':'application/json' };
  if (env.CF_ACCESS_CLIENT_ID) Object.assign(headers, {'CF-Access-Client-Id':env.CF_ACCESS_CLIENT_ID,'CF-Access-Client-Secret':env.CF_ACCESS_CLIENT_SECRET});
  async function request(method, version, body) {
    let response;
    try { response = await fetchImpl(selected.origin + '/v1/admin/large-http', {
      method, headers, redirect:'error', signal:AbortSignal.timeout(20_000), ...(body ? {body:JSON.stringify(body)} : {}),
    }); } catch { throw new Error('Native control request failed; delivery may be unknown'); }
    const actual = response.headers.get('x-clawrouter-version-id');
    if (!response.ok || version && actual !== version) {
      await response.body?.cancel();
      // Only a successful GET with a well-formed version can be an observation
      // of the previous deployment. Never classify a POST as safe to replay.
      if (method === 'GET' && response.status === 200 && version && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(actual ?? ''))
        throw new NativeControlVersionMismatch(version, actual);
      throw new NativeControlHttpError(method, response.status, version, actual);
    }
    return response.json();
  }
  return {
    async snapshot(version) { const result = await request('GET',version); if (result.status !== 200) throw new Error('Native control snapshot refused'); return { ...snapshotState(result.state), control: result.control, inspection: result.slots }; },
    async admission(accepting, version, { allowLegacy = false, runtimeSha, observe = () => this.snapshot(version) } = {}) {
      const before = await observe();
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
        const after = await observe();
        if (after.accepting === accepting && (!fenced || after.control?.revision === expectedRevision + 1)) return;
        if (attempt<4) await wait(1000);
      }
      throw error || new Error('Native admission readback differs');
    },
  };
}
function sameOwner(remote, state) {
  return remote?.run === String(state.run) && remote.blue === state.blue && remote.green === state.green && remote.sha === state.sha &&
    remote.native?.runtimeSha === state.native?.runtimeSha && remote.cutover?.blueRuntimeSha === state.cutover?.blueRuntimeSha && remote.cutover?.recovery === state.cutover?.recovery && remote.cutover?.nativeSource === state.cutover?.nativeSource && remote.cutover?.kind === state.cutover?.kind;
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
// Content-free operational evidence, only on the deployment observation path.
// Never include tokens, grant IDs, arbitrary inspection fields or response bodies.
export function nativeReadinessSummary(s) {
  const digest = v => /^[a-f0-9]{64}$/.test(v ?? '') ? v : null;
  const phase = v => ['idle','starting','ready','draining','stopping','blocked','failed','destroying','destroyed','stopped'].includes(v) ? v : 'unknown';
  return {accepting:s.accepting === true,phase:['serving','draining','closed'].includes(s.phase)?s.phase:'unknown',
    runtimeSha:digest(s.control?.runtimeSha),artifactProtocol:s.control?.artifactProtocol===1?1:null,
    slots:s.slots.map((m,i)=>{const o=s.inspection?.[i];return {slot:i,phase:phase(m.phase),generation:m.generation,owners:m.ids.length,
      observedPhase:phase(o?.phase),qualified:o?.qualified===true,artifactProtocol:o?.artifactProtocol===1?1:null,
      runtimeSha:digest(o?.runtimeSha),configuredRuntimeSha:digest(o?.config?.runtimeSha),
      generationMatches:o?.generation===m.generation,bootMatches:!!s.pool.members[i]&&o?.boot===s.pool.members[i].boot,
      fingerprintMatches:o?.fingerprint===s.control?.fingerprint&&o?.config?.fingerprint===s.control?.fingerprint,
      quarantined:s.pool.members[i]?.quarantined===true};}),
    grants:s.pool.grants.length,members:s.pool.members.filter(Boolean).length,issued:s.pool.issued,seen:Object.keys(s.pool.seen).length};
}
async function converge({api,state,control,version,kind,now,wait,timeoutMs}) {
  const observed = new Set(), runtimeSha = version === state.green ? state.native.runtimeSha : state.cutover.blueRuntimeSha;
  let lastPending;
  try { return await observeNativeControl({control,version,previousVersions:[state.blue,state.green,state.cutover.recovery],now,wait,timeoutMs,
    assertOwnership:async()=>{
      const {latest} = await owned(api,state);
      if (stableVersion(latest) !== version || latest.id !== state.deploymentId) throw new Error('Native cutover deployment changed during convergence');
    },
    validate:s=>{ if (s.slots.some(m=>m.phase==='blocked')) throw new Error('Native slot destruction is unresolved; preserve custody and inspect'); },
    isReady:s=>kind === 'snapshot' || (kind === 'drain' ? nativeDrained(s) : kind === 'control' ? controlReady(s,runtimeSha) && artifactControlReady(s) : nativeWarm(s,runtimeSha,{requireArtifactControl:true})),
    onStatePending:s=>{
        lastPending = nativeReadinessSummary(s);
        const key = JSON.stringify(lastPending);
        if (!observed.has(key) && observed.size < 24) {
          observed.add(key); console.log('Native ' + kind + ' pending ' + version + ': ' + key);
        }
    },
    onPending:observation=>{
      const key = observation.kind === 'version' ? observation.actual : 'http500:' + (observation.actual ?? version);
      if (observed.has(key) || observed.size >= 24) return;
      observed.add(key);
      console.log('Native control awaiting Worker ' + version + (observation.kind === 'version' ? '; observed owned version ' + observation.actual : '; snapshot returned HTTP 500' + (observation.actual ? '; observed owned version ' + observation.actual : '')));
    },
    deadlineMessage:'Native ' + kind + ' deadline exceeded; preserve the remote recovery journal',
  }); } catch (error) {
    if (lastPending) console.log('Native ' + kind + ' last pending ' + version + ': ' + JSON.stringify(lastPending));
    throw error;
  }
}
async function admission({api,state,control,version,accepting,allowLegacy=false,now,wait,timeoutMs}) {
  // A successful convergence GET does not pin the next edge request. Keep the
  // admission pre-read and post-write reconciliation under the same owned,
  // bounded observation policy. The admission POST remains single-shot.
  const deadline=now()+Math.min(timeoutMs,60_000);
  const observe=()=>{
    const remaining=deadline-now();
    if(remaining<=0)throw new Error('Native admission deadline exceeded; preserve the remote recovery journal');
    return converge({api,state,control,version,kind:allowLegacy?'snapshot':'control',now,wait,timeoutMs:remaining});
  };
  await control.admission(accepting,version,{allowLegacy,runtimeSha:version===state.green?state.native.runtimeSha:state.cutover.blueRuntimeSha,observe});
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
  await admission({api,state,control,version:state.blue,accepting:false,allowLegacy:true,now,wait,timeoutMs});
  await converge({api,state,control,version:state.blue,kind:'drain',now,wait,timeoutMs});
  await verifyCutoverRecovery(api,state);
  // A full traffic switch alone can leave active DOs on old code for five
  // minutes. Immediate adoption is scoped to the already-drained switch.
  await verifyObservability(api,state,now());
  await journal(api,state,state.green,'warming',save,'rolling',true);
  await converge({api,state,control,version:state.green,kind:'control',now,wait,timeoutMs:Math.min(timeoutMs,60_000)});
  await admission({api,state,control,version:state.green,accepting:true,now,wait,timeoutMs});
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
    await admission({api,state,control,version:active,accepting:false,allowLegacy:active===state.blue,now,wait,timeoutMs});
    await converge({api,state,control,version:active,kind:'drain',now,wait,timeoutMs});
    await verifyCutoverRecovery(api,state);
    await journal(api,state,state.cutover.recovery,'recover-warming',save,'rolling',true);
  }
  await converge({api,state,control,version:state.cutover.recovery,kind:'control',now,wait,timeoutMs:Math.min(timeoutMs,60_000)});
  await admission({api,state,control,version:state.cutover.recovery,accepting:true,now,wait,timeoutMs});
  await converge({api,state,control,version:state.cutover.recovery,kind:'warm',now,wait,timeoutMs});
  await journal(api,state,state.cutover.recovery,'recover-warming',save,'rolled-back');
  state.recovery='compatible-native-restored'; save(state);
  return 'compatible-native-restored';
}
