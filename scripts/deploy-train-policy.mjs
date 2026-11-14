// Deployment policy is independent of the network and workflow expression language.
export const TRAIN_STEPS = Object.freeze([
  { percentage: 0, holdMs: 0 },
  { percentage: 10, holdMs: 2 * 60_000 },
  { percentage: 50, holdMs: 3 * 60_000 },
  { percentage: 100, holdMs: 0 },
]);
export const POLL_MS = 30_000;
export const LEGACY_DEPLOYMENT = Object.freeze({
  version: 'd06cab69-8847-46da-b6b6-cc1585b42371',
  sha: '478974c17edab8da283f4637ae706a4d63885a2e',
  run: 39813164865,
});
export function fullSha(value) {
  if (!/^[a-f0-9]{40}$/i.test(value ?? '')) throw new Error('Expected a full commit SHA');
  return value.toLowerCase();
}
export function versionId(value) {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value ?? '')) throw new Error('Invalid Worker version ID');
  return value.toLowerCase();
}
export function verifyDispatch({ event, expected, sha, ref }) {
  if (!['schedule', 'workflow_dispatch'].includes(event)) throw new Error('Unsupported train trigger');
  if (ref !== 'refs/heads/main') throw new Error('Production train must run from main');
  if (event === 'workflow_dispatch' && fullSha(expected) !== fullSha(sha)) throw new Error('Dispatched source differs from expected_sha');
}
export function stableVersion(deployment) {
  const active = deployment?.versions?.filter((v) => v.percentage > 0);
  if (active?.length !== 1 || active[0].percentage !== 100) throw new Error('Existing deployment is split or missing; reconcile before another train');
  return versionId(active[0].version_id);
}
export function versionSha(version) {
  const tag = version?.annotations?.['workers/tag'];
  if (/^[a-f0-9]{40}$/i.test(tag ?? '')) return fullSha(tag);
  return null;
}
export function greenPushRun(runs, sha) {
  // Newer attempts supersede older success. Never accept PR merge-ref checks.
  const latest = runs.filter((r) => r.head_sha === sha && r.event === 'push' && r.head_branch === 'main')
    .sort((a, b) => Number(b.id) - Number(a.id) || b.run_attempt - a.run_attempt)[0];
  return latest?.status === 'completed' && latest.conclusion === 'success' ? latest : null;
}
export function rollbackUnsafe(messages) {
  return messages.some((message) => /^ClawRouter-Rollback-Unsafe:\s*\S.*$/im.test(message));
}
export function splitVersions(blue, green, percentage) {
  if (![0, 10, 50, 100].includes(percentage)) throw new Error('Unsupported traffic step');
  // Green FIRST and blue SECOND throughout the rollout: DO assignments only advance.
  return [{ version_id: versionId(green), percentage }, { version_id: versionId(blue), percentage: 100 - percentage }];
}
export function analyticsDecision(rows, blue, green) {
  const tally = (id) => rows.filter((r) => r.dimensions?.scriptVersion === id).reduce((a, r) => {
    const { requests, errors } = r.sum ?? {};
    if (!Number.isFinite(requests) || !Number.isFinite(errors) || requests < 0 || errors < 0 || errors > requests) throw new Error('Invalid analytics counts');
    return { requests: a.requests + requests, errors: a.errors + errors };
  }, { requests: 0, errors: 0 });
  const b = tally(blue), g = tally(green);
  const blueRate = b.requests ? b.errors / b.requests : 0;
  const greenRate = g.requests ? g.errors / g.requests : 0;
  // No low-volume zero-error sample is represented as a statistical comparison.
  const comparison = b.requests >= 20 && g.requests >= 20;
  const breach = g.errors >= 3 && greenRate > 0.05 && (!comparison || greenRate > blueRate + 0.02);
  return { breach, comparison, blue: b, green: g, blueRate, greenRate };
}
export function recoveryDecision(state) {
  if (!state || ['done', 'rehearsed', 'rolled-back'].includes(state.status)) return 'none';
  if (state.migration || (state.unsafe && state.exposed)) return 'freeze';
  return state.green ? 'rollback' : 'none';
}
const PREFIX = 'clawrouter-train:v1:';
export function deploymentMessage(state) {
  return PREFIX + JSON.stringify({ run: String(state.run), blue: versionId(state.blue), green: versionId(state.green), sha: fullSha(state.sha), unsafe: Boolean(state.unsafe), exposed: Boolean(state.exposed), status: state.status, ...(state.native ? { native: state.native } : {}), ...(state.cutover ? { cutover: state.cutover } : {}) });
}
export function deploymentState(deployment) {
  const message = deployment?.annotations?.['workers/message'];
  if (!message?.startsWith(PREFIX)) return null;
  const state = JSON.parse(message.slice(PREFIX.length));
  if (!/^\d+$/.test(state.run) || typeof state.unsafe !== 'boolean' || typeof state.exposed !== 'boolean' || !['rolling', 'done', 'rehearsed', 'rolled-back'].includes(state.status)) throw new Error('Invalid remote train journal');
  versionId(state.blue); versionId(state.green); fullSha(state.sha);
  if (state.native && (state.native.schema !== 1 || !/^[a-f0-9]{64}$/.test(state.native.runtimeSha ?? '') || Object.keys(state.native).sort().join() !== 'runtimeSha,schema')) throw new Error('Invalid remote native compatibility receipt');
  if (state.cutover) {
    const c = state.cutover;
    if (!state.native || c.schema !== 1 || !/^[a-f0-9]{64}$/.test(c.blueRuntimeSha ?? '') ||
        c.blueRuntimeSha === state.native.runtimeSha || state.unsafe ||
        !['draining', 'warming', 'recover-draining-blue', 'recover-draining-green', 'recover-draining-recovery', 'recover-warming'].includes(c.phase) ||
        !/^[a-f0-9]{40}$/.test(c.nativeSource ?? '') || Object.keys(c).sort().join() !== 'blueRuntimeSha,nativeSource,phase,recovery,schema') throw new Error('Invalid remote native cutover receipt');
    versionId(c.recovery);
    if ([state.blue,state.green].includes(c.recovery)) throw new Error('Recovery must retain the compatible control protocol');
    const target = ['warming', 'recover-draining-green'].includes(c.phase) ? state.green : ['recover-warming','recover-draining-recovery'].includes(c.phase) ? c.recovery : state.blue;
    if (deployment.versions?.length !== 1 || deployment.versions[0].percentage !== 100 || deployment.versions[0].version_id !== target ||
        state.status === 'done' && c.phase !== 'warming' || state.status === 'rolled-back' && c.phase !== 'recover-warming' || state.status === 'rehearsed')
      throw new Error('Native cutover journal requires one exact full-traffic version');
  }
  const ids = deployment.versions.map((v) => v.version_id);
  if (ids.some((id) => ![state.blue, state.green, state.cutover?.recovery].includes(id))) throw new Error('Train journal does not match deployed versions');
  return state;
}
