import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { posix } from 'node:path';

export const nativeControlFiles = Object.freeze(['archive-deployment-source.mjs','deploy-command.mjs','check-deployment-compatibility.mjs','deploy-authorization.mjs','deploy-release-resources.mjs','deploy-release-qualification.mjs','deploy-release-plan.mjs','build-native-baseline.mjs','native-session-continuity.mjs','prepare-native-rehearsal.mjs','native-rehearsal-client.mjs','native-rehearsal-actions.mjs','../worker/native-rehearsal-entry.ts','../worker/native-rehearsal/contract.ts','../worker/native-rehearsal/input.ts','../worker/native-rehearsal/startup.ts','../worker/native-rehearsal/bootstrap.ts','../worker/native-rehearsal/egress.ts','../worker/native-rehearsal/state.ts','../test/helpers/native-codex.mjs','codex-catalog.mjs','deploy-train-select.mjs','deploy-native-target.mjs','qualify-native-cutover.mjs','smoke-native-cutover.mjs','smoke-version.mjs','smoke-access-gate.mjs','../.github/workflows/qualify-native-cutover.yml','../.github/workflows/ci.yml','deploy-native-qualification.mjs','deploy-native-cutover.mjs','deploy-train.mjs','deploy-train-recover.mjs','deploy-train-api.mjs','deploy-train-artifacts.mjs','deploy-train-policy.mjs','deploy-train-runtime.mjs','deploy-train-secrets.mjs','deploy-train-source.mjs','deploy-train-observability.mjs','prepare-large-http-release.mjs','build-native-recovery.mjs','build-large-http.mjs','large-http-provider-snapshot.mjs','../worker/large-http/config.ts','../worker/large-http/provider-config.ts','../worker/large-http/epoch.ts','../worker/large-http/pool-state.ts','../worker/large-http/lifecycle-client.ts','../worker/large-http/continuous.ts','../worker/large-http/lifecycle.ts','../worker/large-http/service.ts','../worker/large-http/native-slot.ts','../.github/workflows/deploy-cloudflare.yml']);

export function nativeControlDigest({ source, cwd = process.cwd() } = {}) {
  if (source !== undefined && !/^[a-f0-9]{40}$/.test(source)) throw new Error('Invalid qualification source');
  const hash = createHash('sha256');
  for (const file of nativeControlFiles)
    hash.update(file + '\0').update(source === undefined ? readFileSync(new URL(file, import.meta.url)) :
      execFileSync('git', ['show', source + ':' + posix.normalize('scripts/' + file)], {cwd,timeout:30_000,maxBuffer:4*1024*1024,stdio:['ignore','pipe','ignore']})).update('\0');
  return hash.digest('hex');
}
import { assertCutoverReceipt } from './deploy-train-runtime.mjs';

// Produced by the canonical Action's isolated campaign. No source-controlled
// approval registry, arbitrary path/URL, or operator waiver can authorize a pair.
export function assertNativeQualification(state, receipt) {
  assertCutoverReceipt(state);
  if (receipt?.schema !== 2 || receipt.qualified !== true || receipt.source !== state.sha ||
      receipt.controlSha256 !== nativeControlDigest() || receipt.kind !== (state.cutover.kind ?? 'payload') ||
      receipt.blueRuntimeSha !== state.cutover.blueRuntimeSha || receipt.greenRuntimeSha !== state.native.runtimeSha ||
      receipt.nativeSource !== state.cutover.nativeSource || receipt.productionBlue !== state.blue ||
      !/^[a-f0-9]{64}$/.test(receipt.releaseSha256 ?? '') || receipt.releaseSha256 !== state.releaseManifestSha256 ||
      !/^[a-f0-9]{64}$/.test(receipt.recoverySha256 ?? '') || receipt.recoverySha256 !== state.recoveryReleaseManifestSha256 ||
      !['deployment','continuity','payload','accounting','recovery','cleanup'].every(k => receipt.cases?.[k]?.outcome === 'passed'))
    throw new Error('Exact release lacks automatic isolated deployment, continuity, payload, accounting, recovery or cleanup evidence');
  return receipt;
}
