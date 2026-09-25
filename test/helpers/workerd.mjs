import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { adminRequest } from "../../scripts/admin-api.mjs";
import { acceptGrantPoolBaseline, recoverGrantPools } from "../../scripts/grant-pool-recovery.mjs";

// Reuse Wrangler's locked workerd and bundler; all outbound traffic stays in the fixture.
const require = createRequire(import.meta.resolve("wrangler/package.json"));
const { Miniflare, convertV4MiniflareOptions } = require("miniflare");
const { build } = require("esbuild");

export async function startWorkerdFixture(temporary, routerScript, upstreamScript, options) {
  const bundle = await build({ stdin: { contents: routerScript, resolveDir: process.cwd(), sourcefile: "websocket-fixture.ts", loader: "ts" }, write: false, bundle: true, format: "esm", platform: "browser", target: "es2022", logLevel: "silent" });
  return startBundledWorkerdFixture(temporary, bundle.outputFiles[0].text, upstreamScript, options);
}

export async function startBundledWorkerdFixture(temporary, routerScript, upstreamScript, { activate = true, persistencePath } = {}) {
  const adminToken = "fixture-activation-admin";
  const mf = new Miniflare(convertV4MiniflareOptions({ resourceTmpPath: temporary, resourcePersistencePath: persistencePath, workers: [{
    name: "router", modules: true, script: routerScript, compatibilityDate: "2026-06-05", compatibilityFlags: ["enable_request_signal"],
    bindings: { OPENAI_API_KEY: "fixture-upstream-key", CLAWROUTER_ADMIN_TOKEN_SHA256: createHash("sha256").update(adminToken).digest("hex") },
    kvNamespaces: ["POLICY_KV"],
    durableObjects: Object.fromEntries([["ACCESS_CONTROL", "PolicyBindingIndexObject"], ["BUDGET_LEDGER", "BudgetLedgerObject"], ["USAGE_LEDGER", "UsageLedgerObject"], ["GRANT_CREDENTIALS", "GrantCredentialObject"]].map(([binding, className]) => [binding, { className, useSQLite: true }])),
    queueProducers: { USAGE_QUEUE: "usage" }, queueConsumers: { usage: { maxBatchSize: 1, maxBatchTimeout: 0 } },
    outboundService: "upstream",
  }, { name: "upstream", modules: true, script: upstreamScript, compatibilityDate: "2026-06-05", compatibilityFlags: ["enable_request_signal"] }] }));
  try {
    await mf.ready;
    // This invocation created these isolated storage bindings. Exercise the
    // same authenticated activation driver before any fixture uses env auth.
    if (activate) {
      const request = (path, options) => adminRequest(path, { ...options, env: { CLAWROUTER_BASE_URL: "http://fixture.example", CLAWROUTER_ADMIN_TOKEN: adminToken }, fetchImpl: (url, init) => mf.dispatchFetch(url, init) });
      await acceptGrantPoolBaseline("fresh", { request });
      await recoverGrantPools({ request });
    }
    return mf;
  } catch (error) {
    await mf.dispose();
    throw error;
  }
}
