import { execFileSync } from 'node:child_process';
import { fullSha } from './deploy-train-policy.mjs';
import { pathToFileURL } from 'node:url';

// Read the selected immutable source, never the control checkout or an env override.
export function deploymentHold(sha, cwd = process.cwd()) {
  fullSha(sha);
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000 }).trim();
  const path = 'config/deployment-hold.json';
  if (!git('ls-tree', '--name-only', sha, '--', path)) return null;
  const value = JSON.parse(git('show', `${sha}:${path}`));
  if (value?.schema !== 1 || typeof value.hold !== 'boolean' || typeof value.reason !== 'string' || !value.reason.trim())
    throw new Error('Invalid source deployment hold');
  return value.hold ? value.reason : null;
}
export function assertNoDeploymentHold(sha, cwd) {
  if (deploymentHold(sha, cwd)) throw new Error('Selected source is held for a separately authorized staged release');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  assertNoDeploymentHold(execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 30_000 }).trim());
