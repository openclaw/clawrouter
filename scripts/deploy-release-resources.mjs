// Built-ins only: cleanup must work in a fresh runner without candidate installs.
import { createHash } from 'node:crypto';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { fullSha } from './deploy-train-policy.mjs';
import { isolatedNativeTarget } from './deploy-native-target.mjs';

export async function saveReceipt(path, value) {
  await mkdir(resolve(path, '..'), { recursive: true, mode: 0o700 });
  await writeFile(path + '.next', JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await rename(path + '.next', path);
}
export function qualificationIdentity(env, stage = 'release') {
  fullSha(env.GITHUB_SHA);
  if (env.GITHUB_REPOSITORY !== 'openclaw/clawrouter' || !/^\d+$/.test(env.GITHUB_RUN_ID ?? '') ||
      !/^\d+$/.test(env.GITHUB_RUN_ATTEMPT ?? '') || !['release','bridge'].includes(stage) || !/^[a-f0-9]{32}$/.test(env.CLOUDFLARE_ACCOUNT_ID ?? ''))
    throw new Error('Invalid qualification owner');
  const suffix = createHash('sha256').update([env.GITHUB_REPOSITORY, env.GITHUB_RUN_ID, env.GITHUB_RUN_ATTEMPT, env.GITHUB_SHA, stage].join(':')).digest('hex').slice(0,12);
  const worker = 'clawrouter-native-qualification-' + suffix;
  return { account: env.CLOUDFLARE_ACCOUNT_ID, worker, kv: worker + '-policy', usage: worker + '-usage', dlq: worker + '-dlq', bucket: worker + '-content', container: worker + '-large-http' };
}
export async function observeResource(read, { now = Date.now, wait = sleep, timeoutMs = 60_000 } = {}) {
  const deadline = now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (now() >= deadline) throw new Error('Isolated resource observation deadline; mutation was not replayed');
    await wait(Math.min(1000, deadline - now()));
  }
}
export function createIsolatedResources({ env = process.env, identity = qualificationIdentity(env), fetchImpl = fetch, wait = sleep, now = Date.now, save = async () => {} } = {}) {
  const expected = ['release','bridge'].map(stage => qualificationIdentity(env, stage));
  if (!expected.some(row => JSON.stringify(row) === JSON.stringify(identity))) throw new Error('Unowned qualification resources');
  const base = '/accounts/' + identity.account;
  const owner={schema:1,repository:env.GITHUB_REPOSITORY,run:env.GITHUB_RUN_ID,attempt:env.GITHUB_RUN_ATTEMPT,source:env.GITHUB_SHA,worker:identity.worker};
  let claimedKv;
  if (!env.CLOUDFLARE_API_TOKEN) throw new Error('Cloudflare API credential missing');
  // No generic mutation API escapes this owner-scoped adapter. Production paths
  // cannot be passed by a caller, even one holding broad deployment credentials.
  async function request(path, { method = 'GET', body, absent = false, container = false, raw = false } = {}) {
    const response = await fetchImpl('https://api.cloudflare.com/client/v4' + base + path, {
      method, redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: { authorization: 'Bearer ' + env.CLOUDFLARE_API_TOKEN, 'content-type': 'application/json' },
      ...(body === undefined ? {} : {body: JSON.stringify(body)}),
    });
    if (absent && response.status === 404) { await response.body?.cancel(); return null; }
    if (!response.ok) { await response.body?.cancel(); const error = new Error('Isolated Cloudflare resource ' + method + ' failed: HTTP ' + response.status); error.status = response.status; throw error; }
    if (response.status === 204) return true;
    if (raw) return response.text();
    const value = await response.json();
    // Container API is a distinct, unwrapped API; Workers APIs use envelopes.
    if (container) return value;
    if (value.success !== true) throw new Error('Isolated resource API envelope failed');
    return value.result;
  }
  async function rows(path, pick = x => x, container = false) {
    const all = [];
    for (let page=1; page<=100; page++) {
      const value = await request(path + (path.includes('?') ? '&' : '?') + 'per_page=100&page=' + page, {container});
      const items = pick(value);
      if (!Array.isArray(items)) throw new Error('Incomplete isolated resource inventory');
      all.push(...items);
      if (items.length < 100) return all;
    }
    throw new Error('Isolated resource inventory exceeded bounded pagination');
  }
  const one = (items, predicate) => {
    const selected = items.filter(predicate);
    if (selected.length > 1) throw new Error('Ambiguous isolated resource identity');
    return selected[0] ?? null;
  };
  const kv = async () => one(await rows('/storage/kv/namespaces'), x => x.title === identity.kv);
  const queue = async name => one(await rows('/queues'), x => x.queue_name === name);
  const bucket = () => request('/r2/buckets/' + identity.bucket, {absent:true});
  const worker = () => request('/workers/scripts/' + identity.worker + '/settings', {absent:true});
  const application = async () => {
    const value = await request('/containers/applications?name='+encodeURIComponent(identity.container), {container:true});
    if (!Array.isArray(value)) throw new Error('Incomplete isolated container inventory');
    return one(value, x => x.name === identity.container);
  };
  async function mutation(label, write, observed) {
    await save({operation:label,state:'pending',at:now()});
    let failed = false;
    try { await write(); } catch { failed = true; }
    // Also reconcile HTTP errors: the server may have committed before a proxy
    // failed. No write is ever retried, even after a lost acknowledgement.
    const value = await observeResource(observed, {now,wait});
    await save({operation:label,state:'observed',acknowledgementLost:failed,at:now()});
    return value;
  }
  return {
    identity,
    async target() {
      const subdomain = (await request('/workers/subdomain')).subdomain;
      return isolatedNativeTarget({ worker:identity.worker, account:identity.account, origin:'https://' + identity.worker + '.' + subdomain + '.workers.dev' });
    },
    async provision() {
      if (await kv() || await queue(identity.usage) || await queue(identity.dlq) || await bucket() || await worker() || await application())
        throw new Error('Fresh qualification identity already exists; no resources were adopted');
      const policy = await mutation('create-policy', () => request('/storage/kv/namespaces', {method:'POST',body:{title:identity.kv}}), kv);
      claimedKv=policy.id;
      const ownerPath='/storage/kv/namespaces/'+policy.id+'/values/release-owner';
      await mutation('claim-policy',()=>request(ownerPath,{method:'PUT',body:owner}),async()=>{
        const text=await request(ownerPath,{absent:true,raw:true});return text===JSON.stringify(owner);
      });
      for (const name of [identity.usage,identity.dlq]) await mutation('create-' + (name === identity.usage ? 'usage' : 'dlq'), () => request('/queues', {method:'POST',body:{queue_name:name}}), () => queue(name));
      await mutation('create-bucket', () => request('/r2/buckets', {method:'POST',body:{name:identity.bucket}}), bucket);
      if (!/^[a-f0-9]{32}$/.test(policy.id ?? '')) throw new Error('Invalid isolated policy namespace');
      return {kvId:policy.id};
    },
    async installSecret(secret) {
      const read = async () => {
        const settings = await worker();
        return settings?.bindings?.some(b => b.name === 'LARGE_HTTP_TOKEN' && b.type === 'secret_text');
      };
      if (await read()) throw new Error('Isolated control secret already exists; never rotate during qualification');
      await mutation('install-secret', () => request('/workers/scripts/' + identity.worker + '/secrets', {method:'PUT',body:{name:'LARGE_HTTP_TOKEN',type:'secret_text',text:secret}}), read);
    },
    async cleanup() {
      const outcomes = [];
      const policy=await kv();
      if(policy){
        const text=await request('/storage/kv/namespaces/'+policy.id+'/values/release-owner',{absent:true,raw:true});
        if(text!==JSON.stringify(owner)&&claimedKv!==policy.id)return {worker:identity.worker,complete:false,outcomes:[{resource:'ownership',outcome:'unresolved'}]};
      }else if(await worker()||await application()||await queue(identity.usage)||await queue(identity.dlq)||await bucket()){
        return {worker:identity.worker,complete:false,outcomes:[{resource:'ownership',outcome:'unresolved'}]};
      }
      // Delete the owned application first: its synthetic-only native processes
      // must not survive Worker removal. This is cleanup, not a continuity pass.
      for (const [label, read, path] of [
        ['container', application, item => '/containers/applications/' + encodeURIComponent(item.id)],
        ['worker', worker, () => '/workers/scripts/' + identity.worker],
        ['usage', () => queue(identity.usage), item => '/queues/' + encodeURIComponent(item.queue_id)],
        ['dlq', () => queue(identity.dlq), item => '/queues/' + encodeURIComponent(item.queue_id)],
        ['bucket', bucket, () => '/r2/buckets/' + identity.bucket],
        ['policy', kv, item => '/storage/kv/namespaces/' + encodeURIComponent(item.id)],
      ]) {
        try {
          // Keep the durable owner marker until every other resource is absent;
          // a fresh cleanup runner must retain authority after a partial failure.
          if(label==='policy'&&outcomes.some(x=>x.outcome==='unresolved')){outcomes.push({resource:label,outcome:'unresolved'});continue;}
          const item = await read();
          if (item) await mutation('delete-' + label, () => request(path(item), {method:'DELETE',container:label === 'container'}), async () => !await read());
          outcomes.push({resource:label,outcome:item?'removed':'absent'});
        } catch { outcomes.push({resource:label,outcome:'unresolved'}); }
      }
      return {worker:identity.worker,outcomes,complete:outcomes.every(x => x.outcome !== 'unresolved')};
    },
  };
}
export async function cleanupQualifications(env = process.env) {
  const directory = resolve(env.TRAIN_EVIDENCE_DIRECTORY || 'release-evidence','public');
  const results = [];
  for (const stage of ['release','bridge']) {
    const identity = qualificationIdentity(env,stage), operations = [];
    const resources = createIsolatedResources({env,identity,save:async operation => {
      operations.push(operation); await saveReceipt(join(directory,'cleanup-' + stage + '.json'), {identity,operations});
    }});
    const result = await resources.cleanup(); results.push(result);
    await saveReceipt(join(directory,'cleanup-' + stage + '.json'), {identity,operations,...result});
  }
  if (results.some(x => !x.complete)) throw new Error('Qualification cleanup incomplete; deployment outcome is recorded separately. Do not redeploy to clean up.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] !== 'cleanup') throw new Error('Only owner-scoped cleanup is a standalone operation');
  await cleanupQualifications();
}
