import { setTimeout as sleep } from 'node:timers/promises';

export function createApi({ env = process.env, fetchImpl = fetch } = {}) {
  const repository = env.GITHUB_REPOSITORY || 'openclaw/clawrouter';
  if (repository !== 'openclaw/clawrouter') throw new Error('Production train repository mismatch');
  const worker = env.CLAWROUTER_WORKER_NAME || 'clawrouter-edge';
  if (worker !== 'clawrouter-edge') throw new Error('Production train Worker mismatch');
  const account = env.CLOUDFLARE_ACCOUNT_ID;
  const workerPath = `/accounts/${account}/workers/scripts/${worker}`;
  async function request(origin, path, token, { method = 'GET', body, raw = false } = {}) {
    if (!token) throw new Error(`${origin === 'github' ? 'GitHub' : 'Cloudflare'} token missing`);
    const base = origin === 'github' ? 'https://api.github.com' : 'https://api.cloudflare.com/client/v4';
    const response = await fetchImpl(base + path, {
      method, redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: { authorization: `Bearer ${token}`, accept: 'application/json', 'content-type': 'application/json', ...(origin === 'github' ? { 'X-GitHub-Api-Version': '2022-11-28' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      await response.body?.cancel();
      const error = new Error(`${origin} ${method} failed with HTTP ${response.status}`);
      error.status = response.status;
      throw error; // Never include raw API payloads, which can contain private data.
    }
    const payload = await response.json();
    if (origin === 'cloudflare' && !raw && payload.success !== true) throw new Error('Cloudflare API operation was not successful');
    return origin === 'cloudflare' && !raw ? payload.result : payload;
  }
  const github = (path, options) => request('github', `/repos/${repository}${path}`, env.GH_TOKEN || env.GITHUB_TOKEN, options);
  const cloudflare = (path, options) => request('cloudflare', path, env.CLOUDFLARE_API_TOKEN, options);
  return {
    github, cloudflare, workerPath,
    latest: async () => (await cloudflare(`${workerPath}/deployments`)).deployments[0],
    version: (id) => cloudflare(`${workerPath}/versions/${id}`),
    async deploy(versions, message, expectedId) {
      const before = await this.latest();
      if (before?.id !== expectedId) throw new Error('Deployment changed outside this train; refusing mutation');
      let error;
      try {
        await cloudflare(`${workerPath}/deployments`, { method: 'POST', body: { strategy: 'percentage', versions, annotations: { 'workers/message': message } } });
      } catch (cause) { error = cause; }
      // A lost mutation response is ambiguous. Read back, never blindly retry POST.
      const actual = await this.latest();
      if (actual?.annotations?.['workers/message'] !== message || actual?.versions?.length !== versions.length || actual.versions.some((v, i) => v.version_id !== versions[i].version_id || v.percentage !== versions[i].percentage)) throw error || new Error('Deployment readback differs from requested split');
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
