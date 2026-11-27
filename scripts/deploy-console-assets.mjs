import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const pattern = /^[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8,}\.(js|css|woff2?|png|jpe?g|svg|webp|gif|ico)$/;
const types = { js: 'text/javascript', css: 'text/css', woff: 'font/woff', woff2: 'font/woff2', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', svg: 'image/svg+xml', webp: 'image/webp', gif: 'image/gif', ico: 'image/x-icon' };
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const versionPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export function assertAssetBootstrap(blueSha, cwd = process.cwd()) {
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000 }).trim();
  // The first train adds the fallback to a legacy blue. It is safe only when its
  // asset inputs are unchanged. Later trains have fallback on BOTH versions.
  if (git('ls-tree', '--name-only', blueSha, 'worker/console-assets.ts')) return;
  if (git('diff', '--name-only', `${blueSha}..HEAD`, '--', 'admin', 'shared', 'pnpm-lock.yaml')) throw new Error('Legacy blue lacks shared assets: first deploy must not change admin/shared/lockfile inputs');
}
export async function publishConsoleAssets({ sha, env = process.env, directory = 'admin/dist/assets', fetchImpl = fetch, log = console.log } = {}) {
  const bucket = env.CLAWROUTER_CONTENT_BUCKET || 'clawrouter-content';
  if (bucket !== 'clawrouter-content' || !env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_API_TOKEN) throw new Error('Production console asset target or credentials missing');
  const base = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/r2/buckets/${bucket}/objects/console-assets/v1/assets/`;
  async function request(name, init = {}) {
    const response = await fetchImpl(base + name, { ...init, redirect: 'error', signal: AbortSignal.timeout(30_000), headers: { authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, ...init.headers } });
    if (!response.ok && response.status !== 404) { await response.body?.cancel(); throw new Error(`Console asset storage HTTP ${response.status}`); }
    return response;
  }
  const receipts = [];
  const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  if (sha) {
    if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Invalid asset probe source SHA');
    const bytes = Buffer.from('/* ClawRouter shared-asset deployment probe. */\n');
    entries.push({ name: `train-probe-${digest(bytes).slice(0, 16)}.js`, isFile: () => true, bytes });
  }
  for (const entry of entries) {
    const match = entry.name.match(pattern);
    if (!entry.isFile() || !match) throw new Error('Console build contains an unsupported or non-hashed asset');
    const bytes = entry.bytes || readFileSync(join(directory, entry.name));
    if (bytes.length > 10 * 1024 * 1024) throw new Error('Console asset exceeds bounded publication size');
    const expected = digest(bytes);
    let response = await request(entry.name);
    if (response.status === 404) {
      await response.body?.cancel();
      // No mutation retries. Readback reconciles an ambiguous PUT instead.
      let error;
      try {
        response = await request(entry.name, { method: 'PUT', headers: { 'content-type': types[match[1]], 'cache-control': 'public, max-age=31536000, immutable' }, body: bytes });
        if (!response.ok) throw new Error('Console asset bucket unavailable');
        await response.body?.cancel();
      } catch (cause) { error = cause; }
      response = await request(entry.name);
      if (!response.ok) { await response.body?.cancel(); throw error || new Error('Console asset publication not visible'); }
    }
    const actual = Buffer.from(await response.arrayBuffer());
    if (actual.length !== bytes.length || digest(actual) !== expected) throw new Error('Immutable console asset collision or readback mismatch');
    receipts.push({ path: `/assets/${entry.name}`, sha256: expected, bytes: bytes.length, ...(entry.bytes ? { probe: true } : {}) });
  }
  if (!receipts.length) throw new Error('Console build has no assets');
  log(`Shared console assets verified: ${receipts.length}`);
  return receipts;
}

export async function verifyConsoleAssets({ assets, baseUrl, version, legacy = false, fetchImpl = fetch,
  readinessTimeoutMs = 30_000, now = () => performance.now(), wait = sleep, log = console.log }) {
  if (!Number.isInteger(readinessTimeoutMs) || readinessTimeoutMs < 1 || readinessTimeoutMs > 30_000) throw new Error('Invalid console asset readiness timeout');
  for (const asset of assets) {
    if (legacy && asset.probe) continue; // legacy blue has no shared fallback yet
    if (typeof asset.path !== 'string' || !asset.path.startsWith('/assets/') || !pattern.test(asset.path.slice('/assets/'.length))) throw new Error('Invalid console asset receipt path');
    const deadline = now() + readinessTimeoutMs;
    let attempt = 0;
    while (true) {
      const details = { path: asset.path, expectedVersion: version, actualVersion: null, status: null, attempt: ++attempt };
      const failure = (reason, extra = {}, kind = 'response failed') => new Error(`Cross-version console asset ${kind}: ${JSON.stringify({ ...details, reason, ...extra })}`);
      const remaining = Math.ceil(deadline - now());
      if (remaining <= 0) throw failure('request_deadline', { failure: 'readiness_timeout' });
      let response;
      try {
        response = await fetchImpl(`${baseUrl}${asset.path}`, { method: 'GET', headers: { 'Cloudflare-Workers-Version-Overrides': `clawrouter-edge="${version}"` }, redirect: 'error', signal: AbortSignal.timeout(remaining) });
      } catch { throw failure('request_failed'); } // Never expose transport messages, headers or response bodies.
      const actualVersion = response.headers.get('x-clawrouter-version-id');
      details.status = response.status;
      details.actualVersion = actualVersion === null ? null : versionPattern.test(actualVersion) ? actualVersion : 'invalid';
      if (!response.ok || (actualVersion !== version && !(legacy && actualVersion === null))) {
        await response.body?.cancel().catch(() => {});
        const reason = response.ok ? 'version_mismatch' : 'http_status';
        // An override can converge independently for each asset after health passes.
        // Retry only successful responses proving another runtime, never missing
        // proof, HTTP errors, corrupt bytes, or a mutation.
        if (response.ok && versionPattern.test(actualVersion ?? '')) {
          const delayMs = Math.min(1_000, Math.max(0, deadline - now()));
          if (delayMs > 0) {
            log(failure(reason, { retryInMs: delayMs }).message);
            await wait(delayMs);
            if (now() < deadline) continue;
          }
          throw failure(reason, { failure: 'readiness_timeout' });
        }
        throw failure(reason);
      }
      let body;
      try { body = Buffer.from(await response.arrayBuffer()); }
      catch { throw failure('body_read_failed'); }
      const sha256 = digest(body);
      if (body.length !== asset.bytes || sha256 !== asset.sha256) throw failure('bytes_mismatch', { expectedBytes: asset.bytes, actualBytes: body.length, expectedSha256: asset.sha256, actualSha256: sha256 }, 'bytes differ');
      break;
    }
  }
}
