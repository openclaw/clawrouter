import { nativeTarget } from './deploy-native-target.mjs';
import { createVersionFetch } from './smoke-version.mjs';

// Native cutovers qualify provider behavior on isolated synthetic upstreams.
// Production verification must not issue real provider inference as a smoke.
export async function smokeNativeCutover({ version, target, env = process.env, fetchImpl = fetch }) {
  const selected = nativeTarget(target, env);
  const selectedFetch = createVersionFetch({ baseUrl: selected.origin, versionId: version, workerName: selected.worker, fetchImpl });
  for (const [path, method, expected] of [['/health','GET',200], ['/v1/providers','GET',200], ['/v1/responses','POST',401]]) {
    const response = await selectedFetch(selected.origin + path, { method, signal: AbortSignal.timeout(20_000), ...(method === 'POST' ? { headers: {'content-type':'application/json'}, body: '{}' } : {}) });
    try {
      if (response.status !== expected) throw new Error('Native non-inference smoke status mismatch');
      if (path === '/health' && (await response.json()).versionId !== version) throw new Error('Native health version mismatch');
      if (path === '/v1/providers' && !Array.isArray((await response.json()).providers)) throw new Error('Native provider catalogue missing');
    } finally { if (!response.bodyUsed) await response.body?.cancel(); }
  }
}
