import { setTimeout as sleep } from 'node:timers/promises';
import { nativeTarget } from './deploy-native-target.mjs';

const READBACK_ATTEMPTS = 5, READBACK_STEP_MS = 1_000;
const ERROR_NAMES = new Set(['Error', 'TypeError', 'SyntaxError', 'AggregateError', 'AbortError', 'TimeoutError']);
const TRANSPORT_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'EPIPE', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH', 'EAI_AGAIN', 'ENOTFOUND',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_ABORTED', 'UND_ERR_DESTROYED',
  'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID', 'ERR_STREAM_PREMATURE_CLOSE',
]);
function requestContext(service, method, path, workerPath) {
  // Static route labels only: arbitrary paths, queries and resource names are private.
  const context = { service, method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(method) ? method : 'other', operation: 'other' };
  if (service !== 'cloudflare') return context;
  if (path === '/graphql') context.operation = 'analytics';
  else if (/^\/accounts\/[^/?]+$/.test(path)) context.operation = 'account';
  const worker = path.match(/^(\/accounts\/[^/?]+\/workers\/scripts\/([^/?]+))\/(deployments|versions|script-settings)(?:\/([^/?]+))?(?:\?.*)?$/);
  if (worker) {
    context.operation = worker[3] === 'versions' ? (worker[4] ? 'worker-version' : 'worker-versions') : 'worker-' + worker[3];
    context.worker = worker[1] === workerPath ? 'selected' : worker[2] === 'clawrouter-edge' ? 'production' : 'other';
    if (worker[3] === 'versions' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(worker[4] ?? '')) context.version = worker[4];
  }
  return context;
}
function requestFailure(context, stage, cause, status) {
  const failures = [], pending = [cause], seen = new Set();
  // Node fetch may nest AggregateError/cause. Never retain their raw objects or messages.
  while (pending.length && seen.size < 8) {
    const error = pending.shift();
    if (!error || typeof error !== 'object' || seen.has(error)) continue;
    seen.add(error);
    failures.push({ name: ERROR_NAMES.has(error.name) ? error.name : 'unknown', ...(TRANSPORT_CODES.has(error.code) ? { code: error.code } : {}) });
    if (error.cause) pending.push(error.cause);
    if (error instanceof AggregateError) pending.push(...error.errors.slice(0, 4));
  }
  const diagnostic = { ...context, stage, ...(status === undefined ? {} : { status }), ...(failures.length ? { failures } : {}) };
  const error = new Error(`${context.service} ${context.method} ${context.operation} failed during ${stage}${status === undefined ? '' : ` with HTTP ${status}`}; diagnostic=${JSON.stringify(diagnostic)}`);
  error.diagnostic = diagnostic;
  if (status !== undefined) error.status = status;
  return error;
}
export function createApi({ env = process.env, fetchImpl = fetch, wait = sleep, target } = {}) {
  const repository = env.GITHUB_REPOSITORY || 'openclaw/clawrouter';
  if (repository !== 'openclaw/clawrouter') throw new Error('Production train repository mismatch');
  const selected = nativeTarget(target, env), worker = selected.worker;
  const account = env.CLOUDFLARE_ACCOUNT_ID;
  const workerPath = `/accounts/${account}/workers/scripts/${worker}`;
  async function request(origin, path, token, { method = 'GET', body, raw = false } = {}) {
    if (!token) throw new Error(`${origin === 'github' ? 'GitHub' : 'Cloudflare'} token missing`);
    if (selected.isolated && method !== 'GET' && !(origin === 'cloudflare' && method === 'POST' && path === workerPath + '/deployments'))
      throw new Error('Qualification API may mutate only its isolated deployments');
    const base = origin === 'github' ? 'https://api.github.com' : 'https://api.cloudflare.com/client/v4';
    const context = requestContext(origin, method, path, workerPath);
    let response;
    try {
      response = await fetchImpl(base + path, {
        method, redirect: 'error', signal: AbortSignal.timeout(30_000),
        headers: { authorization: `Bearer ${token}`, accept: 'application/json', 'content-type': 'application/json', ...(origin === 'github' ? { 'X-GitHub-Api-Version': '2022-11-28' } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (cause) { throw requestFailure(context, 'fetch', cause); }
    if (!response.ok) {
      try { await response.body?.cancel(); } catch { /* Preserve the HTTP failure even if cancellation fails. */ }
      throw requestFailure(context, 'http', undefined, response.status);
    }
    let payload;
    try { payload = await response.json(); }
    catch (cause) { throw requestFailure(context, 'response-body', cause, response.status); }
    if (origin === 'cloudflare' && !raw && payload?.success !== true) throw requestFailure(context, 'api-envelope', undefined, response.status);
    return origin === 'cloudflare' && !raw ? payload.result : payload;
  }
  const github = (path, options) => request('github', `/repos/${repository}${path}`, env.GH_TOKEN || env.GITHUB_TOKEN, options);
  const cloudflare = (path, options) => request('cloudflare', path, env.CLOUDFLARE_API_TOKEN, options);
  let acceptedDeploymentId;
  const priorDeploymentIds = new Set();
  const readLatest = async () => (await cloudflare(`${workerPath}/deployments`)).deployments[0];
  async function latest() {
    let actual = await readLatest();
    // A successful readback does not make later list reads monotonic. Observe
    // known predecessors again, never substitute cached state for a live read.
    // Unknown deployments remain visible immediately to the caller's ownership
    // guard, including while an accepted mutation is being reconciled.
    for (let attempt = 1; attempt <= READBACK_ATTEMPTS && actual?.id !== acceptedDeploymentId && priorDeploymentIds.has(actual?.id); attempt++) {
      await wait(READBACK_STEP_MS * attempt);
      actual = await readLatest();
    }
    if (actual?.id !== acceptedDeploymentId && priorDeploymentIds.has(actual?.id)) throw new Error('Deployment readback remains at a known previous deployment');
    return actual;
  }
  return {
    github, cloudflare, workerPath, latest,
    versions: async () => (await cloudflare(`${workerPath}/versions?per_page=100`)).items,
    version: (id) => cloudflare(`${workerPath}/versions/${id}`),
    async deploy(versions, message, expectedId, { immediate = false } = {}) {
      const before = await this.latest();
      if (before?.id !== expectedId) throw new Error('Deployment changed outside this train; refusing mutation');
      if (immediate && (versions.length !== 1 || versions[0].percentage !== 100)) throw new Error('Immediate native cutover requires one full-traffic version');
      let error;
      try {
        await cloudflare(`${workerPath}/deployments`, { method: 'POST', body: { strategy: 'percentage', versions, annotations: { 'workers/message': message }, ...(immediate ? { code_update_strategy: { mode: 'immediate' } } : {}) } });
      } catch (cause) { error = cause; }
      // code_update_strategy is write-only. Reconcile the owned journal and
      // version allocation; the native controller separately proves adoption.
      // A lost mutation response is ambiguous: never blindly retry POST.
      const matches = (deployment) => deployment?.annotations?.['workers/message'] === message && deployment?.versions?.length === versions.length && deployment.versions.every((v, i) => v.version_id === versions[i].version_id && v.percentage === versions[i].percentage);
      let actual = await this.latest();
      // The deployments list can trail an accepted POST. Re-read only while it
      // still shows the deployment that existed before; any other split fails now.
      for (let attempt = 1; attempt <= READBACK_ATTEMPTS && !matches(actual) && actual?.id === before?.id; attempt++) {
        await wait(READBACK_STEP_MS * attempt);
        actual = await this.latest();
      }
      if (!matches(actual)) throw error || new Error('Deployment readback differs from requested split');
      priorDeploymentIds.add(before.id);
      acceptedDeploymentId = actual.id;
      priorDeploymentIds.delete(actual.id);
      console.log(`deployment ${actual.id}: ${versions.map((v) => `${v.version_id}=${v.percentage}%`).join(' ')}`);
      return actual;
    },
    async analytics({ start, end }) {
      const body = {
        query: `query($account: string!, $worker: string!, $start: Time!, $end: Time!) { viewer { accounts(filter: {accountTag: $account}) { workersInvocationsAdaptive(limit: 100, filter: {scriptName: $worker, datetime_geq: $start, datetime_leq: $end}) { dimensions { scriptVersion } sum { requests errors } } } } }`,
        variables: { account, worker, start, end },
      };
      const result = await cloudflare('/graphql', { method: 'POST', body, raw: true });
      if (result.errors?.length) {
        const text = result.errors.map((e) => e.message).join(' ');
        if (/permission|not authorized|access denied|cannot query field|unknown field|not entitled/i.test(text)) return { disabled: 'Account Analytics Read or per-version GraphQL dataset unavailable' };
        throw new Error('Cloudflare analytics query failed');
      }
      const rows = result.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive;
      if (!Array.isArray(rows) || rows.length >= 100 || rows.some((r) => typeof r.dimensions?.scriptVersion !== 'string')) throw new Error('Incomplete per-version analytics response');
      return { rows };
    },
  };
}

export async function observeAnalytics(api, state, now = Date.now()) {
  if (state.analyticsDisabled) return { disabled: state.analyticsDisabled };
  try {
    // Exclude the newest minute because analytics ingestion is not instantaneous.
    return await api.analytics({ start: new Date(state.startedAt).toISOString(), end: new Date(now - 60_000).toISOString() });
  } catch (error) {
    if ([401, 403].includes(error.status)) return { disabled: 'CLOUDFLARE_API_TOKEN lacks Account Analytics Read' };
    // An established gate cannot disappear silently mid-rollout. Transient failure gets
    // one delayed read-only retry; if still unavailable the train fails and recovers.
    await sleep(5_000);
    return api.analytics({ start: new Date(state.startedAt).toISOString(), end: new Date(now - 60_000).toISOString() });
  }
}
