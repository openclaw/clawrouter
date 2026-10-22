import { execFileSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { createRequire } from 'node:module';
import { fullSha, rollbackUnsafe } from './deploy-train-policy.mjs';

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
  const nonVersioned = (c) => ({ observability: c.observability ?? null, logpush: c.logpush ?? null, tails: c.tail_consumers ?? [], streamingTails: c.streaming_tail_consumers ?? [], triggers: c.triggers ?? null, consumers: c.queues?.consumers ?? [], routes: c.routes ?? [], workersDev: c.workers_dev ?? null, previewUrls: c.preview_urls ?? null });
  if (!isDeepStrictEqual(nonVersioned(old), nonVersioned(candidate))) throw new Error('Non-versioned Worker settings changed; use a separately authorized configuration deployment, not the version train');
  const messages = git('log', '--format=%B%x00', `${blueSha}..${greenSha}`).split('\0');
  // The attachment-status migration predates this policy. Its exact original
  // boundary is recorded here so a legacy deployment cannot cross it blindly.
  const attachmentBoundary = '032b0dfa9aa963d4cd18dce48a6d1e9e48c4e7c3';
  const range = new Set(git('rev-list', `${blueSha}..${greenSha}`).split('\n'));
  return { migration: !isDeepStrictEqual(lifecycle(old), lifecycle(candidate)), unsafe: rollbackUnsafe(messages) || range.has(attachmentBoundary) };
}
