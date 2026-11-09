import "../../test/helpers/typescript-resolver.mjs";
import { tracingChannel } from "node:diagnostics_channel";

// Workers provides FixedLengthStream for known-length streamed bodies; Node does not.
globalThis.FixedLengthStream ??= class FixedLengthStream extends TransformStream {
  constructor(length) {
    let seen = 0;
    super({
      transform(chunk, controller) { seen += chunk.byteLength; if (seen > length) throw new TypeError("FixedLengthStream received too many bytes"); controller.enqueue(chunk); },
      flush() { if (seen !== length) throw new TypeError("FixedLengthStream received too few bytes"); },
    });
  }
};

// Isolate hot caches are module state; every test starts from a cold isolate.
const { beforeEach, getTestContext } = await import("node:test");
const { clearHotCaches, setHotCacheClock, overrideHotCacheConfig, HOT_CACHE_DISABLED } = await import("../hot-cache.ts");
// Coalescing windows are wall-clock; keep suites fast, a dedicated test covers the real window.
(await import("../admission-cache.ts")).setCoalesceWindowMs(0);
if (process.env.CLAWROUTER_TEST_HOT_CACHE === "off") overrideHotCacheConfig(HOT_CACHE_DISABLED);
const { resetSharedHotCacheFence } = await import("../hot-cache.ts");
beforeEach(() => { clearHotCaches(); setHotCacheClock(); resetSharedHotCacheFence(); });
/** Suites that mutate authority state directly between requests test the per-request authority path. */
export function perRequestAuthority() { overrideHotCacheConfig(HOT_CACHE_DISABLED); }

// Partial execution tracing only: files that do not import this setup, earlier
// imports and before-hook execution are outside this observer. End is not PASS,
// I/O retirement or process exit. Native visibility still requires hosted proof.
if (typeof getTestContext === "function") {
  let disabled = false;
  try {
    const ordinals = new WeakMap(), maximum = 65535;
    let observed = 0, started = 0, ended = 0, errors = 0, active = 0;
    const observe = (phase, metadata) => {
      if (disabled) return;
      try {
        if (observed === maximum) { disabled = true; return; }
        observed++;
        if (!metadata || typeof metadata !== "object") return;
        let ordinal = null;
        if (phase === "start") {
          ordinal = ++started; active++; ordinals.set(metadata, ordinal);
        } else if (phase === "end") {
          ended++; ordinal = ordinals.get(metadata) ?? null;
          if (ordinal !== null) { ordinals.delete(metadata); active--; }
        } else {
          // Node publishes error with copied metadata, possibly before start. Never
          // borrow an inherited parent context's ordinal or inspect the raw error.
          errors++;
        }
        // Only the bounded public repository-relative suffix enters the payload.
        const path = metadata.file;
        const file = typeof path === "string" && path.length <= 4096
          ? /(?:^|[/\\])(worker[/\\]test[/\\][A-Za-z0-9][A-Za-z0-9._-]{0,127}\.test\.mjs)$/.exec(path)?.[1].replaceAll("\\", "/") ?? "unknown"
          : "unknown";
        const nesting = Number.isInteger(metadata.nesting) && metadata.nesting >= 0 && metadata.nesting <= maximum ? metadata.nesting : null;
        const type = metadata.type === "test" ? 1 : metadata.type === "suite" ? 2 : 0;
        // The current context is only an immediate output sink, never an identity
        // source or a retained root. In particular, errors remain uncorrelated.
        const sink = getTestContext();
        if (!sink) return;
        if (typeof sink.log !== "function") { disabled = true; return; }
        sink.log("worker-test-phase " + JSON.stringify({ phase, file, ordinal, nesting, type, observed, started, ended, errors, active }));
      } catch { disabled = true; } // Observer failure disables diagnostics only.
    };
    tracingChannel("node.test").subscribe({
      start(metadata) { observe("start", metadata); },
      end(metadata) { observe("end", metadata); },
      error(metadata) { observe("error", metadata); },
    });
  } catch { disabled = true; }
}
