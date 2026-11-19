import { execFileSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { createRequire } from 'node:module';
import { fullSha, rollbackUnsafe } from './deploy-train-policy.mjs';
import { observabilityReconciliation } from './deploy-train-observability.mjs';
import { nativeControlDigest } from './deploy-native-qualification.mjs';

export function inspectSource({ blueSha, greenSha, cwd = process.cwd() }) {
  const require = createRequire(`${cwd}/package.json`);
  const { getStaticTOMLValue, parseTOML } = require('toml-eslint-parser');
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000 }).trim();
  fullSha(blueSha); fullSha(greenSha);
  if (git('rev-parse', 'HEAD') !== greenSha) throw new Error('Candidate checkout differs from selected SHA');
  git('merge-base', '--is-ancestor', blueSha, greenSha);
  const config = (sha) => getStaticTOMLValue(parseTOML(git('show', `${sha}:wrangler.toml`)));
  const old = config(blueSha), candidate = config(greenSha);
  const lifecycle = (c) => ({ migrations: c.migrations ?? [], exports: c.exports ?? null });
  const nonVersioned = (c) => ({ containers: c.containers ?? [], logpush: c.logpush ?? null, tails: c.tail_consumers ?? [], streamingTails: c.streaming_tail_consumers ?? [], triggers: c.triggers ?? null, consumers: c.queues?.consumers ?? [], routes: c.routes ?? [], workersDev: c.workers_dev ?? null, previewUrls: c.preview_urls ?? null });
  if (!isDeepStrictEqual(nonVersioned(old), nonVersioned(candidate))) throw new Error('Development error: non-versioned settings need an automated compatible transition in this feature PR; operator configuration steps are not supported');
  const reconciliation = observabilityReconciliation(old.observability ?? null, candidate.observability ?? null);
  const migration = !isDeepStrictEqual(lifecycle(old), lifecycle(candidate));
  if (old.migrations?.some(m => m.tag === 'v6-large-http')) {
    const native = c => ({ main: c.main, no_bundle: c.no_bundle, keep_vars: c.keep_vars, assets: c.assets, actors: c.durable_objects });
    if (migration || !isDeepStrictEqual(native(old), native(candidate))) throw new Error('Development error: lifecycle or actor changes need an automated compatible transition and old-state proof in this feature PR');
  }
  if (reconciliation && migration) throw new Error('Observability reconciliation requires a version-only candidate; apply lifecycle changes separately');
  const messages = git('log', '--format=%B%x00', `${blueSha}..${greenSha}`).split('\0');
  // The attachment-status migration predates this policy. Its exact original
  // boundary is recorded here so a legacy deployment cannot cross it blindly.
  const attachmentBoundary = '032b0dfa9aa963d4cd18dce48a6d1e9e48c4e7c3';
  const range = new Set(git('rev-list', `${blueSha}..${greenSha}`).split('\n'));
  let nativeControlChanged = true;
  try { nativeControlChanged = nativeControlDigest({source:blueSha,cwd}) !== nativeControlDigest({source:greenSha,cwd}); }
  catch { /* A deployment predating automatic qualification needs the full proof. */ }
  return { migration, unsafe: rollbackUnsafe(messages) || range.has(attachmentBoundary), nativeControlChanged, ...(reconciliation ? { observabilityReconciliation: reconciliation } : {}) };
}
