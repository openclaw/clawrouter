import { admitIdentityHeaders, admitAdmission, admitIdentity, identityJson, identitySourceBudget, isIdentityFailure, readIdentityResponse, type IdentitySourceBudget } from "./identity-admission.ts";
import type { AdmissionResult } from "./authority-admission.ts";
import { hotCacheNow, tryRunInBackground, sharedHotCacheFence, type HotCacheConfig } from "./hot-cache.ts";
import { sha256Hex } from "./utils.ts";

// Per-colo layer under the isolate hot cache, backed by the Workers Cache API:
// a cold isolate can adopt a snapshot another isolate in the same location just
// fetched. Only secretless snapshots belong here; credentials never do. Entries
// keep their original fetch time, so the hot-cache max age still bounds them.
const ORIGIN = "https://hot-cache.clawrouter.internal";
const VERSION = 1;

function sharedCache(): Cache | undefined {
  try { return typeof caches === "undefined" ? undefined : (caches as unknown as { default?: Cache }).default; }
  catch { return undefined; }
}

async function entryUrl(namespace: string, key: string): Promise<string> {
  return `${ORIGIN}/v${VERSION}/${namespace}/${await sha256Hex(`${namespace}\n${key}`)}`;
}

export async function coloGet<V>(namespace: string, key: string, config: HotCacheConfig, source?: IdentitySourceBudget): Promise<{ value: V; fetchedAt: number } | undefined> {
  const cache = sharedCache();
  if (!cache || !config.maxAgeMs) return undefined;
  try {
    const url = await entryUrl(namespace, key);
    // Register before invocation, retaining ordinary lookup-failure-as-miss.
    // Once a body arrives, read/cleanup denial is terminal below.
    const actual = Promise.resolve().then(() => cache.match(url)); void actual.catch(() => undefined);
    const response = await actual;
    if (!response) return undefined;
    if (namespace === "admission" && response.body === null) { admitIdentityHeaders(response.headers); return undefined; }
    const entry = namespace === "admission" ? await readIdentityResponse<{ version: number; fetchedAt: number; value: V }>(() => Promise.resolve(response), source ?? identitySourceBudget(), undefined, undefined, "colo")
      : await response.json<{ version: number; fetchedAt: number; value: V }>();
    if (namespace === "admission") admitAdmission(entry.value as AdmissionResult);
    const age = hotCacheNow() - entry.fetchedAt;
    if (entry.version !== VERSION || !Number.isFinite(age) || age < 0 || age >= config.maxAgeMs || entry.fetchedAt <= sharedHotCacheFence()) return undefined;
    return { value: entry.value, fetchedAt: entry.fetchedAt };
  } catch (error) { if (isIdentityFailure(error)) throw error; return undefined; } // The colo layer is an optimization; failures fall through to the authority.
}

export function coloPut(namespace: string, key: string, value: unknown, fetchedAt: number, config: HotCacheConfig): void {
  const cache = sharedCache();
  if (!cache || !config.maxAgeMs) return;
  if (namespace === "admission") admitIdentity({ version: VERSION, fetchedAt, value });
  tryRunInBackground(async () => {
    const ttl = Math.max(1, Math.ceil((config.maxAgeMs - (hotCacheNow() - fetchedAt)) / 1_000));
    await cache.put(await entryUrl(namespace, key), new Response(namespace === "admission" ? identityJson({ version: VERSION, fetchedAt, value }) : JSON.stringify({ version: VERSION, fetchedAt, value }), {
      headers: { "content-type": "application/json", "cache-control": `max-age=${ttl}` },
    }));
  });
}
