import { registerHooks } from "node:module";
import { extname } from "node:path";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && context.parentURL && !extname(new URL(specifier, context.parentURL).pathname)) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

// Isolate hot caches are module state; every test starts from a cold isolate.
const { beforeEach } = await import("node:test");
const { clearHotCaches, setHotCacheClock, overrideHotCacheConfig, HOT_CACHE_DISABLED } = await import("../hot-cache.ts");
// Coalescing windows are wall-clock; keep suites fast, a dedicated test covers the real window.
(await import("../admission-cache.ts")).setCoalesceWindowMs(0);
if (process.env.CLAWROUTER_TEST_HOT_CACHE === "off") overrideHotCacheConfig(HOT_CACHE_DISABLED);
const { resetSharedHotCacheFence } = await import("../hot-cache.ts");
beforeEach(() => { clearHotCaches(); setHotCacheClock(); resetSharedHotCacheFence(); });
/** Suites that mutate authority state directly between requests test the per-request authority path. */
export function perRequestAuthority() { overrideHotCacheConfig(HOT_CACHE_DISABLED); }
