import { fixture, grantKey } from "./managed-runtime-fixture.mjs";
import assert from "node:assert/strict";
import { byteBody, syntheticTransport } from "./minimax-search-byte-fixture.mjs";
const { default: worker } = await import("../index.ts");
const { snapshot } = await import("../providers.ts");
const { putGrantCredentials } = await import("../grant-credentials.ts");
const { miniMaxSearchBinding } = await import("../../shared/minimax-search-binding.ts");
export { grantKey };
export const actor = { auth: "cloudflare_access", email: "admin@example.invalid", role: "admin" };
export const nativePath = "/v1/native/minimax/v1/coding_plan/search", manifestPath = "/v1/proxy/minimax/search";
export const result = { base_resp: { status_code: 0 }, organic: [{ title: "Synthetic", link: "https://example.invalid/result", snippet: "Synthetic search result" }], related_searches: [{ query: "related" }] };
export const originalKey = "synthetic-search-key";
import { configureSearch } from "./minimax-search-declaration-fixture.mjs";
export { configureSearch };
export async function setup(t, options = {}) {
  const prior = snapshot.providers;
  snapshot.providers = prior.filter(row => row.id !== "minimax").map(row => row.id === "replicate" ? structuredClone(row) : row);
  t.after(() => { snapshot.providers = prior; });
  const f = await fixture(t, { providerId: "minimax", fixed: options.fixed === undefined ? 700 : options.fixed,
    configure: p => configureSearch(p, options.region) });
  // Emulate Node's in-process fake RPC transport using known synthetic bytes;
  // actual transport/backing qualification belongs only to the workerd fixture.
  for (const name of ["ACCESS_CONTROL", "BUDGET_LEDGER", "GRANT_CREDENTIALS", "USAGE_LEDGER"]) {
    const namespace = f.env[name], get = namespace.get.bind(namespace);
    namespace.get = id => { const stub = get(id); return { async fetch(...args) { return syntheticTransport(await stub.fetch(...args)); } }; };
  }
  const upstreamFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (...args) => syntheticTransport(await upstreamFetch(...args)));
  f.env.MINIMAX_API_KEY = "synthetic-forbidden-environment-key";
  f.user = (enabled = true, role = "admin") => f.authority("/users/put", { email: actor.email,
    record: { role, enabled, tenantId: "tenant", groups: [], contentRetentionDisabled: false } });
  await f.user();
  f.put = (body, intent, replace = false) => putGrantCredentials(f.env, grantKey, body, !replace, replace ? "replace" : undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, intent, actor);
  if (!options.environment) await f.put({ provider: "minimax", kind: "api_key", enabled: true, credential: originalKey, accountId: "synthetic-account" },
    options.qualify === false ? undefined : miniMaxSearchBinding(options.region ?? "global"));
  f.policy.grantRouting = { eligibleGrants: options.environment ? {} : { minimax: ["replicate"] }, environmentFallback: true, failover: true };
  await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
  const pending = [], drain = f.drain;
  f.drain = async () => { while (pending.length) await Promise.all(pending.splice(0)); await drain(); };
  f.request = (manifest = false, body = { q: "synthetic query" }, extra = {}) => worker.fetch(new Request(
    "https://router.example" + (manifest ? manifestPath : nativePath), { method: "POST", ...extra, duplex: "half",
      headers: { authorization: "Bearer clawrouter-live-fixture-fixture-secret", "content-type": "application/json", ...extra.headers },
      body: byteBody(JSON.stringify(manifest ? { body } : body)) }), f.env, { waitUntil: p => pending.push(p) });
  f.upstream = () => Response.json(result); f.materializations = 0;
  const get = f.env.GRANT_CREDENTIALS.get;
  f.env.GRANT_CREDENTIALS.get = id => { const stub = get(id); return { fetch(url, init) {
    if (new URL(url).pathname === "/materialize") f.materializations++;
    return stub.fetch(url, init);
  } }; };
  f.afterBudget = change => { const get = f.env.BUDGET_LEDGER.get; let once = false;
    f.env.BUDGET_LEDGER.get = id => { const stub = get(id); return { async fetch(url, init) {
      const response = await stub.fetch(url, init);
      if (new URL(url).pathname === "/dispatch" && !once) { once = true; await change(); }
      return response;
    } }; };
  };
  f.record = () => f.env.GRANT_CREDENTIALS.objects.get(grantKey).values.get("credential");
  t.after(f.drain); return f;
}
export async function denied(f, response) {
  const text = await response.text(); assert.notEqual(response.status, 200, text);
  assert.doesNotMatch(text, /synthetic-(?:search|replacement|forbidden-environment)-key/);
  await f.drain(); assert.equal(f.sent.length, 0);
}
