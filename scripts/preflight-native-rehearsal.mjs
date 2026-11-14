// Built-ins only. Deliberately not the mutation-capable deployment API client.
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { nativeBindings, nativeReceipt, nativeSource, NATIVE_CLASSES } from './deploy-train-runtime.mjs';
import { productionNativeTarget } from './deploy-native-target.mjs';

const SHA = /^[a-f0-9]{40}$/, UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const ID = /^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/;
const OWN = /^clawrouter-native-qualification-[a-z0-9-]{1,80}$/;
const hash = value => createHash('sha256').update(value).digest('hex');
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const need = (condition) => { if (!condition) throw new Error('invalid_metadata'); };
export const MAPPINGS = Object.freeze([
  'NATIVE_QUALIFICATION_CF_API_TOKEN', 'NATIVE_QUALIFICATION_CF_ACCOUNT_ID',
  'NATIVE_QUALIFICATION_ADMIN_TOKEN', 'NATIVE_QUALIFICATION_ACCESS_CLIENT_ID',
  'NATIVE_QUALIFICATION_ACCESS_CLIENT_SECRET', 'CLAWROUTER_NATIVE_ADMIN_TOKEN',
  'CLAWROUTER_NATIVE_ACCESS_CLIENT_ID', 'CLAWROUTER_NATIVE_ACCESS_CLIENT_SECRET',
]);
const BOUNDS = Object.freeze({ pages: 5, items: 500, bodyBytes: 2 * 1024 * 1024, requestMs: 10_000, totalMs: 180_000 });
const failure = (status, reason) => ({ status, reason });

export function sourceAccepted(env) {
  return env.GITHUB_REPOSITORY === 'openclaw/clawrouter' && env.GITHUB_EVENT_NAME === 'workflow_dispatch' &&
    env.GITHUB_REF === 'refs/heads/main' && SHA.test(env.EXPECTED_SHA ?? '') && env.EXPECTED_SHA === env.GITHUB_SHA;
}

// No arbitrary URLs, methods, options, redirects, retries, or raw exceptions leave this module.
function reader({ token, fetchImpl, limits }) {
  const deadline = AbortSignal.timeout(limits.totalMs);
  return async (path) => {
    let response;
    try {
      const signal = AbortSignal.any([deadline, AbortSignal.timeout(limits.requestMs)]);
      response = await fetchImpl('https://api.cloudflare.com/client/v4' + path, {
        method: 'GET', redirect: 'error', signal,
        headers: { authorization: 'Bearer ' + token, accept: 'application/json' },
      });
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        return failure(response.status === 403 ? 'forbidden' : response.status === 401 ? 'unauthorized' : 'unavailable',
          'http_' + response.status);
      }
      const stream = response.body?.getReader();
      if (!stream) return failure('unavailable', 'missing_body');
      let bytes = 0;
      const chunks = [];
      for (;;) {
        const { done, value } = await stream.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > limits.bodyBytes) {
          void stream.cancel().catch(() => {});
          return failure('partial', 'body_limit');
        }
        chunks.push(value);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (body?.success !== true) return failure('unavailable', 'api_unsuccessful');
      return { status: 'ok', body };
    } catch {
      return failure('unavailable', deadline.aborted ? 'total_deadline' : 'transport_or_invalid_json');
    }
  };
}

// Scan metadata only, with explicit completion per endpoint's documented pagination.
async function inventory(get, path, { mode = 'page', rows = b => b.result, project }, limits) {
  const result = { status: 'partial', complete: false, observedCount: 0, omittedCount: 0, matches: [] };
  const seen = new Set();
  let cursor = '';
  for (let page = 1; page <= limits.pages; page++) {
    const query = new URLSearchParams();
    if (mode !== 'single') query.set('per_page', '100');
    if (mode === 'page') query.set('page', String(page));
    if (cursor) query.set(mode === 'token' ? 'page_token' : 'cursor', cursor);
    const reply = await get(path + (query.size ? '?' + query : ''));
    if (reply.status !== 'ok') return { ...result, ...reply, status: result.observedCount ? 'partial' : reply.status };
    try {
      const list = rows(reply.body);
      need(Array.isArray(list));
      for (const item of list) {
        if (result.observedCount >= limits.items) return { ...result, reason: 'item_limit' };
        const projected = project(item);
        // Detect repeated pages without retaining unrelated names or IDs.
        const key = hash(JSON.stringify(item.id ?? item.queue_id ?? item.name ?? item));
        need(!seen.has(key)); seen.add(key);
        result.observedCount++;
        if (projected) result.matches.push(projected); else result.omittedCount++;
      }
      const info = reply.body.result_info;
      if (mode === 'single') {
        need(!info?.cursor && !info?.next_page_token && !(info?.total_pages > 1) && !(info?.total_count > list.length));
        return { ...result, status: 'ok', complete: true };
      }
      if (mode === 'token' || mode === 'cursor') {
        need(info && typeof info === 'object');
        const next = info[mode === 'token' ? 'next_page_token' : 'cursor'];
        if (next === undefined || next === null || next === '') {
          need(info.total_count === undefined || info.total_count === result.observedCount);
          return { ...result, status: 'ok', complete: true };
        }
        need(typeof next === 'string' && next.length <= 2048 && next !== cursor && list.length > 0);
        cursor = next;
      } else {
        need(info && info.page === page);
        if (info.total_count !== undefined) need(Number.isSafeInteger(info.total_count) && info.total_count >= result.observedCount);
        if (info.total_pages !== undefined) {
          need(Number.isSafeInteger(info.total_pages) && info.total_pages >= 0);
          if (page >= info.total_pages) {
            need(info.total_count === undefined || info.total_count === result.observedCount);
            return { ...result, status: 'ok', complete: true };
          }
          need(list.length > 0);
        } else if (info.total_count === result.observedCount || list.length === 0) {
          need(info.total_count === undefined || info.total_count === result.observedCount);
          return { ...result, status: 'ok', complete: true };
        }
      }
    } catch { return { ...result, reason: 'invalid_or_incomplete_metadata' }; }
  }
  return { ...result, reason: 'page_limit' };
}

function owned(item, name, id = item?.id) {
  need(item && typeof item === 'object' && typeof name === 'string');
  if (!name.startsWith('clawrouter-native-qualification-')) return null;
  need(OWN.test(name) && (id === undefined || ID.test(id) || id === name));
  return { name, ...(id === undefined ? {} : { id }) };
}

export function projectProduction(version) {
  const receipt = nativeReceipt(version), source = nativeSource(version);
  const bindings = new Map(nativeBindings(version).map(b => [b.name, b]));
  const owners = {};
  for (const name of Object.keys(NATIVE_CLASSES)) owners[name] = hash(bindings.get(name).namespace_id);
  owners.POLICY_KV = hash(bindings.get('POLICY_KV').namespace_id);
  owners.CONTENT_ARCHIVE = hash(bindings.get('CONTENT_ARCHIVE').bucket_name);
  owners.USAGE_QUEUE = hash(bindings.get('USAGE_QUEUE').queue_name);
  return { id: version.id, source: version.annotations['workers/tag'], nativeSource: source,
    runtimeSha256: receipt.runtimeSha, owners, bindingCount: bindings.size };
}

async function production(get, path) {
  const reply = await get(path + '/deployments?per_page=1&page=1');
  if (reply.status !== 'ok') return reply;
  try {
    const deployments = reply.body.result?.deployments;
    need(Array.isArray(deployments));
    if (!deployments.length) return failure('absent', 'no_deployment');
    const latest = deployments[0];
    need(UUID.test(latest.id) && Array.isArray(latest.versions) && latest.versions.length > 0 && latest.versions.length <= 2);
    need(new Set(latest.versions.map(v => v.version_id)).size === latest.versions.length &&
      latest.versions.every(v => UUID.test(v.version_id) && number(v.percentage) !== null && v.percentage <= 100) &&
      latest.versions.reduce((sum, v) => sum + v.percentage, 0) === 100);
    const versions = [];
    for (const deployed of latest.versions) {
      const version = await get(path + '/versions/' + deployed.version_id);
      if (version.status !== 'ok') return version;
      need(version.body.result?.id === deployed.version_id);
      versions.push({ ...projectProduction(version.body.result), percentage: deployed.percentage });
    }
    const after = await get(path + '/deployments?per_page=1&page=1');
    if (after.status !== 'ok') return after;
    need(JSON.stringify(after.body.result?.deployments?.[0]) === JSON.stringify(latest));
    return { status: 'ok', deployment: latest.id, stableDuringRead: true, versions };
  } catch { return failure('unavailable', 'invalid_native_receipt_or_deployment_drift'); }
}

async function capacity(get, path) {
  const reply = await get(path + '/containers/usage');
  if (reply.status !== 'ok') return reply;
  const value = reply.body.result, maximum = {}, usage = {};
  for (const key of ['vcpus', 'memory_mib', 'disk_mb']) maximum[key] = number(value?.maximum?.[key]);
  for (const key of ['instances', 'vcpus', 'memory_mib', 'disk_mb']) usage[key] = number(value?.usage?.[key]);
  const complete = [...Object.values(maximum), ...Object.values(usage)].every(v => v !== null);
  return { status: complete ? 'ok' : 'partial', maximum, usage, kind: 'live_not_billable',
    ...(complete ? {} : { reason: 'missing_capacity_metric' }) };
}

export async function preflight({ env = process.env, fetchImpl = fetch, limits = BOUNDS } = {}) {
  const receipt = { schema: 1, readOnly: true, qualified: false, provisioningAllowed: false, status: 'blocked',
    source: SHA.test(env.EXPECTED_SHA ?? '') ? env.EXPECTED_SHA : null,
    mappings: Object.fromEntries(MAPPINGS.map(name => [name, env['PRESENT_' + name] === 'true'])),
    limits, observations: {}, blockers: [] };
  if (!sourceAccepted(env)) { receipt.blockers.push('source_guard'); return receipt; }
  const account = env.CLOUDFLARE_ACCOUNT_ID, token = env.CLOUDFLARE_API_TOKEN;
  if (!/^[a-f0-9]{32}$/.test(account ?? '') || !token) { receipt.blockers.push('missing_or_invalid_credentials'); return receipt; }
  receipt.accountFingerprint = hash(account);
  const get = reader({ token, fetchImpl, limits }), path = '/accounts/' + account;
  const obs = receipt.observations;
  // Account resource access itself tests this credential/account pair, without assuming token kind.
  const accountRead = await get(path);
  obs.account = accountRead.status !== 'ok' ? accountRead : accountRead.body.result?.id === account
    ? { status: 'ok', consistent: true } : failure('unavailable', 'account_identity_mismatch');
  obs.production = await production(get, path + '/workers/scripts/' + productionNativeTarget.worker);
  const specs = [
    ['workers', '/workers/scripts', { mode: 'single', project: v => owned(v, v?.id) }],
    ['durableObjects', '/workers/durable_objects/namespaces', { project: v => {
      need(typeof v?.script === 'string');
      const p = owned(v, v.script);
      return p ? { ...p, namespaceFingerprint: hash(v.id) } : null;
    } }],
    ['kv', '/storage/kv/namespaces', { project: v => owned(v, v?.title) }],
    ['queues', '/queues', { project: v => owned(v, v?.queue_name, v?.queue_id) }],
    ['bucketsDefaultJurisdiction', '/r2/buckets', { mode: 'cursor', rows: b => b.result?.buckets, project: v => owned(v, v?.name, undefined) }],
    ['containers', '/containers/applications', { mode: 'token', project: v => {
      const p = v?.name === productionNativeTarget.worker + '-large-http'
        ? { production: true, identityFingerprint: hash(v.id) } : owned(v, v?.name);
      if (!p) return null;
      need(v.account_id === account);
      return { ...p, accountConsistent: true, maxInstances: number(v.max_instances),
        activeInstances: number(v.health?.instances?.active), assignedInstances: number(v.health?.instances?.assigned),
        startingInstances: number(v.health?.instances?.starting),
        namespaceFingerprint: typeof v.durable_objects?.namespace_id === 'string' ? hash(v.durable_objects.namespace_id) : null };
    } }],
  ];
  for (const [key, endpoint, spec] of specs) obs[key] = await inventory(get, path + endpoint, spec, limits);
  const apps = obs.containers.matches.filter(v => v.production);
  obs.productionContainer = !obs.containers.complete || obs.production.status !== 'ok'
    ? failure('unavailable', 'incomplete_owner_observation')
    : apps.length === 1 && obs.production.versions.every(v => v.owners.LARGE_HTTP_SLOTS === apps[0].namespaceFingerprint)
      ? { status: 'ok', namespaceConsistent: true } : failure('unavailable', 'missing_or_mismatched_production_container');
  obs.capacity = await capacity(get, path);
  // Subscription details are not metered billing usage. Unrelated plans stay counts only.
  obs.subscriptions = await inventory(get, path + '/subscriptions', { mode: 'single', project: v => {
    need(v && typeof v === 'object' && typeof v.rate_plan?.id === 'string');
    const plan = v.rate_plan.id;
    if (plan.length > 80 || !/^(workers|containers)(?:[-_][a-z0-9]+)*$/.test(plan)) return null;
    return { plan, priceUSD: number(v.price), state: ['Trial','Provisioned','Paid','AwaitingPayment','Cancelled','Failed','Expired'].includes(v.state) ? v.state : null, frequency: ['weekly','monthly','quarterly','yearly'].includes(v.frequency) ? v.frequency : null };
  } }, limits);
  obs.billableUsage = await inventory(get, path + '/billable/usage', { mode: 'single', project: v => {
    need(v && typeof v === 'object');
    const product = v.x_ProductFamilyId;
    if (!['workers', 'containers', 'r2', 'queues', 'durable_objects', 'workers_kv'].includes(product)) return null;
    need(v.BillingAccountId === account && typeof v.x_BillableMetricId === 'string');
    const unit = ['Requests', 'GB', 'GB-Months', 'GB-Seconds', 'vCPU-Hours', 'vCPU-Seconds', 'Operations', 'Bytes'].includes(v.ConsumedUnit) ? v.ConsumedUnit : null;
    const date = x => typeof x === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(x) ? x : null;
    const start = date(v.ChargePeriodStart), end = date(v.ChargePeriodEnd), quantity = number(v.ConsumedQuantity);
    need(unit !== null && start && end && quantity !== null);
    return { product, metricFingerprint: hash(v.x_BillableMetricId), unit, quantity, start, end, accountConsistent: true };
  } }, limits);
  obs.billableUsage.period = 'current_month_through_today_api_default';
  obs.billableUsage.cost = 'unknown_get_does_not_return_rated_costs';
  receipt.unknowns = ['non_default_r2_jurisdictions_not_scanned',
    'non_container_quotas_not_established', 'placement_availability_not_established', 'write_permissions_not_tested',
    'prefix_matches_are_not_ownership_authority', 'mapping_presence_does_not_verify_credentials_or_environment_secrets'];
  receipt.blockers = Object.entries(obs).filter(([, v]) => v.status !== 'ok').map(([key]) => key);
  receipt.status = receipt.blockers.length ? 'blocked' : 'observed';
  return receipt;
}

// Defence in depth: never let even an allowlisted field echo an injected credential.
export function serializeReceipt(receipt, secrets = []) {
  const output = JSON.stringify(receipt, null, 2) + '\n';
  if (secrets.some(secret => secret && (output.includes(secret) || output.includes(JSON.stringify(secret).slice(1, -1)))))
    return JSON.stringify({ schema: 1, readOnly: true, qualified: false, provisioningAllowed: false,
      status: 'blocked', blockers: ['output_secret_collision'] }) + '\n';
  return output;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let receipt;
  try { receipt = await preflight(); }
  catch { receipt = { schema: 1, readOnly: true, qualified: false, provisioningAllowed: false, status: 'blocked', blockers: ['internal_failure'] }; }
  const output = serializeReceipt(receipt, [process.env.CLOUDFLARE_API_TOKEN, process.env.CLOUDFLARE_ACCOUNT_ID]);
  try {
    if (process.env.PREFLIGHT_RECEIPT) await writeFile(process.env.PREFLIGHT_RECEIPT, output, { mode: 0o600 });
    process.stdout.write(output);
  } catch { process.stderr.write('Safe preflight receipt could not be written.\n'); process.exitCode = 1; }
  if (JSON.parse(output).status !== 'observed') process.exitCode = 1;
}
