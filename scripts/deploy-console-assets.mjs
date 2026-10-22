import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const pattern = /^[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8,}\.(js|css|woff2?|png|jpe?g|svg|webp|gif|ico)$/;
const types = { js: 'text/javascript', css: 'text/css', woff: 'font/woff', woff2: 'font/woff2', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', svg: 'image/svg+xml', webp: 'image/webp', gif: 'image/gif', ico: 'image/x-icon' };
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

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

export async function verifyConsoleAssets({ assets, baseUrl, version, legacy = false, fetchImpl = fetch }) {
  for (const asset of assets) {
    if (legacy && asset.probe) continue; // legacy blue has no shared fallback yet
    const response = await fetchImpl(`${baseUrl}${asset.path}`, { headers: { 'Cloudflare-Workers-Version-Overrides': `clawrouter-edge="${version}"` }, redirect: 'error', signal: AbortSignal.timeout(30_000) });
    const actualVersion = response.headers.get('x-clawrouter-version-id');
    if (!response.ok || (actualVersion !== version && !(legacy && actualVersion === null))) { await response.body?.cancel(); throw new Error('Cross-version console asset response failed'); }
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length !== asset.bytes || digest(body) !== asset.sha256) throw new Error('Cross-version console asset bytes differ');
  }
}
