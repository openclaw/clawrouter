import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { posix } from 'node:path';

export const nativeControlFiles = Object.freeze(['deploy-native-qualification.mjs','deploy-native-cutover.mjs','deploy-train.mjs','deploy-train-recover.mjs','deploy-train-api.mjs','deploy-train-artifacts.mjs','deploy-train-policy.mjs','deploy-train-runtime.mjs','deploy-train-secrets.mjs','deploy-train-source.mjs','deploy-train-observability.mjs','prepare-large-http-release.mjs','build-native-recovery.mjs','build-large-http.mjs','large-http-provider-snapshot.mjs','../worker/large-http/continuous.ts','../worker/large-http/lifecycle.ts','../worker/large-http/native-slot.ts','../.github/workflows/deploy-cloudflare.yml']);

export function nativeControlDigest({ source, cwd = process.cwd() } = {}) {
  if (source !== undefined && !/^[a-f0-9]{40}$/.test(source)) throw new Error('Invalid qualification source');
  const hash = createHash('sha256');
  for (const file of nativeControlFiles)
    hash.update(file + '\0').update(source === undefined ? readFileSync(new URL(file, import.meta.url)) :
      execFileSync('git', ['show', source + ':' + posix.normalize('scripts/' + file)], {cwd,timeout:30_000,maxBuffer:4*1024*1024,stdio:['ignore','pipe','ignore']})).update('\0');
  return hash.digest('hex');
}
import { assertCutoverReceipt } from './deploy-train-runtime.mjs';

// Reviewed hosted evidence, not a flag that converts offline tests into a
// rehearsal. Empty until the exact payload pair passes the documented gates.
export function assertNativeQualification(state, receipt = JSON.parse(readFileSync(new URL('../config/native-cutovers.json', import.meta.url), 'utf8')), {cwd = process.cwd()} = {}) {
  assertCutoverReceipt(state);
  if (receipt?.schema !== 1 || !Array.isArray(receipt.qualified)) throw new Error('Invalid native qualification registry');
  const rows = receipt.qualified.filter(q => q.blueRuntimeSha === state.cutover.blueRuntimeSha && q.greenRuntimeSha === state.native.runtimeSha);
  if (rows.length !== 1 || !/^https:[/][/]github[.]com[/]openclaw[/]clawrouter[/]actions[/]runs[/][0-9]+$/.test(rows[0].evidence ?? '') ||
      !/^[a-f0-9]{40}$/.test(rows[0].source ?? '') || rows[0].controlSha256 !== nativeControlDigest())
    throw new Error('Exact native payload pair lacks reviewed hosted cutover/recovery qualification');
  const qualified = rows[0];
  if (!/^[a-f0-9]{40}$/.test(state.sha ?? '')) throw new Error('Invalid candidate source');
  // The evidence commit predates the reviewed registry entry, so requiring
  // self-reference to the registry commit would be impossible. Require ancestry
  // and byte-identical determining code instead; native bytes are pinned above.
  try {
    execFileSync('git',['merge-base','--is-ancestor',qualified.source,state.sha],{cwd,timeout:30_000,stdio:'ignore'});
    if (nativeControlDigest({source:qualified.source,cwd}) !== qualified.controlSha256) throw new Error('source drift');
  } catch { throw new Error('Native qualification source is not an unchanged tested ancestor'); }
  return qualified;
}
