// Read-only companion to qualification. No fixture, admission, deployment or inference writes.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { isolatedNativeTarget } from './deploy-native-target.mjs';
import { createApi } from './deploy-train-api.mjs';
import { stableVersion } from './deploy-train-policy.mjs';
import { nativeBindings, NATIVE_CLASSES } from './deploy-train-runtime.mjs';

export function authSourceAccepted(env) {
  return env.GITHUB_REPOSITORY === 'openclaw/clawrouter' && env.GITHUB_EVENT_NAME === 'workflow_dispatch' &&
    env.GITHUB_REF === 'refs/heads/main' && /^[a-f0-9]{40}$/.test(env.EXPECTED_SHA ?? '') && env.EXPECTED_SHA === env.GITHUB_SHA;
}

// Metadata identity only: a disabled bootstrap need not have enabled flags or
// native artifact lineage. The cutover/readiness validators remain unchanged.
export async function verifyAuthenticationOwners(api, target, version) {
  const productionPath = '/accounts/' + target.account + '/workers/scripts/clawrouter-edge';
  const deployed = await api.cloudflare(productionPath + '/deployments');
  const production = await api.cloudflare(productionPath + '/versions/' + stableVersion(deployed.deployments[0]));
  const identities = value => {
    const bindings = nativeBindings(value), byName = new Map(bindings.map(b => [b.name, b]));
    for (const [name, className] of Object.entries(NATIVE_CLASSES)) {
      const b = byName.get(name);
      if (b?.type !== 'durable_object_namespace' || b.class_name !== className || !b.namespace_id || b.script_name)
        throw new Error('Canonical actor identity unavailable');
    }
    for (const [name, type, key] of [['POLICY_KV', 'kv_namespace', 'namespace_id'],
      ['CONTENT_ARCHIVE', 'r2_bucket', 'bucket_name'], ['USAGE_QUEUE', 'queue', 'queue_name']]) {
      const b = byName.get(name);
      if (b?.type !== type || !b[key]) throw new Error('Persistent owner identity unavailable');
    }
    if (bindings.some(b => b.type === 'service' || b.type === 'durable_object_namespace' && (!b.namespace_id || b.script_name)))
      throw new Error('Remote or unknown actor identity is not admitted');
    return bindings.flatMap(b => ['namespace_id', 'bucket_name', 'queue_name'].filter(k => b[k]).map(k => k + ':' + b[k]));
  };
  const forbidden = new Set(identities(production)), owned = identities(version), bindings = nativeBindings(version);
  if (bindings.find(b => b.name === 'LARGE_HTTP_ORIGIN')?.text !== target.origin || owned.some(id => forbidden.has(id)) ||
      bindings.find(b => b.name === 'LARGE_HTTP_TOKEN')?.type !== 'secret_text')
    throw new Error('Authentication target shares or lacks isolated owners');
}

// The existing router authenticates HEAD before its unsupported-method 404.
// Both statuses and version headers are mandatory; never fall back to GET,
// whose lifecycle snapshot can initialize state and schedule native starts.
export function createAuthenticationProbe({ env, target, fetchImpl = fetch }) {
  if (Boolean(env.CF_ACCESS_CLIENT_ID) !== Boolean(env.CF_ACCESS_CLIENT_SECRET)) throw new Error('Access credential pair incomplete');
  return async version => {
    for (const authenticated of [false, true]) {
      const headers = {};
      if (authenticated) headers.authorization = 'Bearer ' + env.CLAWROUTER_NATIVE_ADMIN_TOKEN;
      if (env.CF_ACCESS_CLIENT_ID) Object.assign(headers, { 'CF-Access-Client-Id': env.CF_ACCESS_CLIENT_ID, 'CF-Access-Client-Secret': env.CF_ACCESS_CLIENT_SECRET });
      let response;
      try { response = await fetchImpl(target.origin + '/v1/admin/large-http', {
        method: 'HEAD', headers, redirect: 'error', signal: AbortSignal.timeout(20_000),
      }); } catch { throw new Error('Authentication transport failed'); }
      const status = response.status, actual = response.headers.get('x-clawrouter-version-id');
      await response.body?.cancel();
      if (status !== (authenticated ? 404 : 401) || actual !== version) {
        const error = new Error('Authentication probe response differs'); error.status = status; throw error;
      }
    }
  };
}

export async function observeNativeAuthentication({ api, probe, target, token, source, save = () => {} }) {
  if (!target.isolated) throw new Error('Authentication preflight requires an isolated target');
  const receipt = { schema: 1, readOnly: true, qualified: false, source, worker: target.worker,
    origin: target.origin, startedAt: new Date().toISOString(), result: 'blocked', stage: 'selected-version',
    limits: ['Authentication only; no readiness, fixture, cutover or session-continuity qualification.'] };
  save(receipt);
  try {
    const before = await api.latest(), selected = stableVersion(before), version = await api.version(selected);
    receipt.version = selected;
    receipt.stage = 'isolated-owners';
    await verifyAuthenticationOwners(api, target, version);
    receipt.stage = 'credential-identity';
    const expected = nativeBindings(version).find(binding => binding.name === 'CLAWROUTER_ADMIN_TOKEN_SHA256');
    if (!token || expected?.type !== 'plain_text' || !/^[a-f0-9]{64}$/i.test(expected.text ?? '') ||
        createHash('sha256').update(token).digest('hex') !== expected.text.toLowerCase())
      throw new Error('Isolated admin credential identity differs');
    receipt.stage = 'admin-head';
    await probe(selected);
    receipt.probe = { method: 'HEAD', anonymousStatus: 401, authenticatedStatus: 404 };
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
  const api = createApi({ env, target }), probe = createAuthenticationProbe({ env, target });
  const receipt = await observeNativeAuthentication({ api, probe, target, token: env.CLAWROUTER_NATIVE_ADMIN_TOKEN,
    source: env.GITHUB_SHA, save: value => writeFileSync(env.AUTH_RECEIPT, JSON.stringify({ ...value,
      actionsRun: env.GITHUB_RUN_ID, actionsAttempt: env.GITHUB_RUN_ATTEMPT }, null, 2) + '\n', { mode: 0o600 }) });
  console.log('Isolated admin authentication: ' + receipt.result + '; no qualification or activation performed.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
