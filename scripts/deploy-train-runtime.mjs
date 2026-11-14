// Built-ins only: the fresh-runner recovery job must not install the candidate.
import { isDeepStrictEqual } from 'node:util';
import { fullSha, versionId } from './deploy-train-policy.mjs';
import { assertSecretLineage, uploadMessage } from './deploy-train-secrets.mjs';

// Separately launched, ingress-enabled version. Never use its ingress-closed blue.
export const NATIVE_ANCHOR = Object.freeze({
  version: 'c5fd84d0-0767-4df5-83d3-78c0588c8689',
  sha: '434a526a37fff4d91e04cc1caa5cd6aa2eff2d82',
  runtimeSha: '6475f07303ec02b2a981825e95224b0e89e38d2d7ab0079279d839beb31e3671',
});
export const NATIVE_CLASSES = Object.freeze({
  ACCESS_CONTROL: 'PolicyBindingIndexObject', BUDGET_LEDGER: 'BudgetLedgerObject',
  CONTENT_CLEANUP: 'ContentArchiveCleanupObject', GRANT_CREDENTIALS: 'GrantCredentialObject',
  USAGE_LEDGER: 'UsageLedgerObject', LARGE_HTTP_POOL: 'LargeHttpPool', LARGE_HTTP_SLOTS: 'LargeHttpSlot',
});
export function assertNativeReceipt(receipt) {
  if (receipt?.schema !== 1 || !/^[a-f0-9]{64}$/.test(receipt.runtimeSha ?? '') ||
      Object.keys(receipt).sort().join() !== 'runtimeSha,schema') throw new Error('Missing or invalid native compatibility receipt');
  return receipt;
}
export function nativeBindings(version) {
  const bindings = version?.resources?.bindings;
  if (!Array.isArray(bindings) || bindings.some(b => !b || typeof b.name !== 'string' || typeof b.type !== 'string') ||
      new Set(bindings.map(b => b.name)).size !== bindings.length) throw new Error('Native version bindings unavailable or ambiguous');
  return bindings;
}
export function nativeReceipt(version) {
  versionId(version?.id); fullSha(version.annotations?.['workers/tag']);
  const bindings = nativeBindings(version), byName = new Map(bindings.map(b => [b.name, b]));
  for (const [name, className] of Object.entries(NATIVE_CLASSES)) {
    const binding = byName.get(name);
    if (binding?.type !== 'durable_object_namespace' || binding.class_name !== className || !binding.namespace_id || binding.script_name)
      throw new Error('Native canonical actor identity is missing or incompatible');
  }
  for (const [name, type] of Object.entries({ ASSETS: 'assets', LARGE_HTTP_TOKEN: 'secret_text', POLICY_KV: 'kv_namespace', CONTENT_ARCHIVE: 'r2_bucket', USAGE_QUEUE: 'queue' })) {
    if (byName.get(name)?.type !== type) throw new Error('Native assets, control secret or persistent owner missing');
  }
  if (!byName.get('POLICY_KV').namespace_id || !byName.get('CONTENT_ARCHIVE').bucket_name || !byName.get('USAGE_QUEUE').queue_name)
    throw new Error('Native persistent owner identity unavailable');
  for (const name of ['LARGE_HTTP_ENABLED', 'LARGE_HTTP_INGRESS_ENABLED']) {
    if (byName.get(name)?.type !== 'plain_text' || byName.get(name).text !== '1') throw new Error('Native lifecycle and ingress must stay enabled');
  }
  let runtimeSha;
  if (version.id === NATIVE_ANCHOR.version && version.annotations['workers/tag'] === NATIVE_ANCHOR.sha) runtimeSha = NATIVE_ANCHOR.runtimeSha;
  else {
    const match = /^clawrouter-(?:candidate|migration):\d+:([a-f0-9]{40}):preserve-secrets:([a-f0-9-]{36}):native-v1:([a-f0-9]{64})(?::native-source:([a-f0-9]{40}))?$/.exec(version.annotations?.['workers/message'] ?? '');
    if (!match || match[1] !== version.annotations['workers/tag']) throw new Error('Native artifact lineage is not attested');
    versionId(match[2]); runtimeSha = match[3];
  }
  return { schema: 1, runtimeSha };
}
export function nativeSource(version) {
  nativeReceipt(version);
  const match = /:native-source:([a-f0-9]{40})$/.exec(version.annotations?.['workers/message'] ?? '');
  return match?.[1] ?? fullSha(version.annotations['workers/tag']);
}
export function assertRuntimePair(blue, green, state) {
  const expected = assertNativeReceipt(state.native);
  if (blue.id !== state.blue || green.id !== state.green || green.annotations?.['workers/tag'] !== state.sha ||
      green.annotations?.['workers/message'] !== uploadMessage(state)) throw new Error('Native version receipt differs from train identity');
  if (!isDeepStrictEqual(nativeReceipt(blue), expected) || !isDeepStrictEqual(nativeReceipt(green), expected))
    throw new Error('Different native runtime fingerprints require a separately rehearsed cutover');
  assertNativeOwners(blue, green);
}
export function assertNativeOwners(blue, green) {
  // Include all fields, not just actor names: namespace IDs, vars, queue/bucket
  // ownership, extra bindings and secret names must survive the version upload.
  const ordered = v => nativeBindings(v).toSorted((a, b) => a.name.localeCompare(b.name));
  if (!isDeepStrictEqual(ordered(blue), ordered(green))) throw new Error('Native owner, configuration or secret bindings changed');
}
export function assertCutoverReceipt(state) {
  const c = state.cutover;
  assertNativeReceipt(state.native);
  if (!c || c.schema !== 1 || !/^[a-f0-9]{64}$/.test(c.blueRuntimeSha ?? '') ||
      c.blueRuntimeSha === state.native.runtimeSha || state.unsafe || state.migration ||
      !['prepared', 'draining', 'warming', 'recover-draining-blue', 'recover-draining-green', 'recover-draining-recovery', 'recover-warming'].includes(c.phase) ||
      !/^[a-f0-9]{40}$/.test(c.nativeSource ?? '') ||
      Object.keys(c).sort().join() !== (c.recovery ? 'blueRuntimeSha,nativeSource,phase,recovery,schema' : 'blueRuntimeSha,nativeSource,phase,schema')) throw new Error('Invalid native cutover receipt');
  if (c.recovery) { versionId(c.recovery); if ([state.blue,state.green].includes(c.recovery)) throw new Error('Recovery version must retain current control code'); }
  return c;
}
export function assertCutoverPair(blue, green, state) {
  const c = assertCutoverReceipt(state);
  if (blue.id !== state.blue || green.id !== state.green || green.annotations?.['workers/tag'] !== state.sha ||
      green.annotations?.['workers/message'] !== uploadMessage(state) ||
      nativeReceipt(blue).runtimeSha !== c.blueRuntimeSha || nativeSource(blue) !== c.nativeSource || nativeReceipt(green).runtimeSha !== state.native.runtimeSha)
    throw new Error('Native cutover artifact lineage differs from train');
  assertNativeOwners(blue, green);
  const bindings = new Map(nativeBindings(blue).map(b => [b.name,b]));
  if (['LARGE_HTTP_RUNTIME_SHA','LARGE_HTTP_RUNTIME_BYTES','LARGE_HTTP_DEADLINE'].some(name => bindings.has(name)) ||
      bindings.get('LARGE_HTTP_CAPACITY')?.text !== '8') throw new Error('Native cutover requires the bundled runtime and continuous eight-slot capacity');
}
export async function verifyCutoverRecovery(api, state) {
  versionId(state.cutover?.recovery);
  const [blue, green, recovery, versions] = await Promise.all([api.version(state.blue), api.version(state.green), api.version(state.cutover.recovery), api.versions()]);
  assertCutoverPair(blue, green, state);
  if (recovery.id !== state.cutover.recovery || recovery.annotations?.['workers/tag'] !== state.sha ||
      nativeReceipt(recovery).runtimeSha !== state.cutover.blueRuntimeSha ||
      recovery.annotations?.['workers/message'] !== uploadMessage({ ...state, nativeSource: state.cutover.nativeSource, native: { schema: 1, runtimeSha: state.cutover.blueRuntimeSha } })) throw new Error('Compatible recovery artifact is not bound to current source');
  assertNativeOwners(blue,recovery);
  assertSecretLineage(versions, state.blue);
}
export async function verifyRuntimeRecovery(api, state) {
  assertNativeReceipt(state.native);
  const [blue, green, versions] = await Promise.all([api.version(state.blue), api.version(state.green), api.versions()]);
  assertRuntimePair(blue, green, state);
  assertSecretLineage(versions, state.blue);
}
