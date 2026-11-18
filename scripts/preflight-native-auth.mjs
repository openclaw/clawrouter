// Read-only companion to qualification. No fixture, admission, deployment or inference writes.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { isolatedNativeTarget } from './deploy-native-target.mjs';
import { createApi } from './deploy-train-api.mjs';
import { createNativeControl } from './deploy-native-cutover.mjs';
import { stableVersion } from './deploy-train-policy.mjs';
import { nativeBindings, nativeReceipt } from './deploy-train-runtime.mjs';
import { verifyIsolatedOwners } from './qualify-native-cutover.mjs';

export function authSourceAccepted(env) {
  return env.GITHUB_REPOSITORY === 'openclaw/clawrouter' && env.GITHUB_EVENT_NAME === 'workflow_dispatch' &&
    env.GITHUB_REF === 'refs/heads/main' && /^[a-f0-9]{40}$/.test(env.EXPECTED_SHA ?? '') && env.EXPECTED_SHA === env.GITHUB_SHA;
}

export async function observeNativeAuthentication({ api, control, target, token, source, save = () => {} }) {
  if (!target.isolated) throw new Error('Authentication preflight requires an isolated target');
  const receipt = { schema: 1, readOnly: true, qualified: false, source, worker: target.worker,
    origin: target.origin, startedAt: new Date().toISOString(), result: 'blocked', stage: 'selected-version',
    limits: ['Authentication only; no readiness, fixture, cutover or session-continuity qualification.'] };
  save(receipt);
  try {
    const before = await api.latest(), selected = stableVersion(before), version = await api.version(selected);
    receipt.version = selected;
    receipt.stage = 'isolated-owners';
    await verifyIsolatedOwners(api, target, [version]);
    receipt.stage = 'credential-identity';
    const expected = nativeBindings(version).find(binding => binding.name === 'CLAWROUTER_ADMIN_TOKEN_SHA256');
    if (!token || expected?.type !== 'plain_text' || !/^[a-f0-9]{64}$/.test(expected.text ?? '') ||
        createHash('sha256').update(token).digest('hex') !== expected.text)
      throw new Error('Isolated admin credential identity differs');
    receipt.stage = 'admin-get';
    const snapshot = await control.snapshot(selected);
    if (snapshot.control?.runtimeSha !== nativeReceipt(version).runtimeSha)
      throw new Error('Admin snapshot runtime differs');
    receipt.stage = 'deployment-stability';
    const after = await api.latest();
    if (after.id !== before.id || stableVersion(after) !== selected)
      throw new Error('Selected deployment changed during authentication');
    receipt.result = 'authenticated';
    receipt.stage = 'complete';
    return receipt;
  } catch (error) {
    receipt.result = 'failed';
    if (Number.isInteger(error.status) && error.status >= 100 && error.status <= 599) receipt.httpStatus = error.status;
    // Do not publish raw errors, response bodies, token material or configuration.
    throw new Error('Isolated admin authentication failed at ' + receipt.stage +
      (receipt.httpStatus ? ' (HTTP ' + receipt.httpStatus + ')' : ''));
  } finally {
    receipt.finishedAt = new Date().toISOString();
    save(receipt);
  }
}

export async function main(env = process.env) {
  if (!authSourceAccepted(env) || execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== env.GITHUB_SHA)
    throw new Error('Authentication preflight requires exact reviewed main dispatch');
  const target = isolatedNativeTarget({ worker: env.QUALIFICATION_WORKER, origin: env.QUALIFICATION_ORIGIN, account: env.CLOUDFLARE_ACCOUNT_ID });
  const api = createApi({ env, target }), control = createNativeControl({ env, target });
  const receipt = await observeNativeAuthentication({ api, control, target, token: env.CLAWROUTER_NATIVE_ADMIN_TOKEN,
    source: env.GITHUB_SHA, save: value => writeFileSync(env.AUTH_RECEIPT, JSON.stringify({ ...value,
      actionsRun: env.GITHUB_RUN_ID, actionsAttempt: env.GITHUB_RUN_ATTEMPT }, null, 2) + '\n', { mode: 0o600 }) });
  console.log('Isolated admin authentication: ' + receipt.result + '; no qualification or activation performed.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
