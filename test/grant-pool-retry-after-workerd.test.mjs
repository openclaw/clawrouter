import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startWorkerdFixture } from "./helpers/workerd.mjs";

// The actual Worker in workerd with its SQL authority. A pooled grant cooling down
// must surface as a timed 429, and the upstream must never be contacted.
test("workerd answers a cooling grant pool with 429 and Retry-After, and exhausted or failed-credential pools with 503", { timeout: 60_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-pool-retry-"));
  let mf;
  try {
    mf = await startWorkerdFixture(temporary, `
      import handler from "./worker/index.ts";
      export * from "./worker/index.ts";
      export default handler;
    `, `export default { async fetch() { throw new Error("an unavailable pool must not reach upstream"); } };`);
    const kv = await mf.getKVNamespace("POLICY_KV", "router");
    const secret = "pool-retry-fixture-secret";
    for (const id of ["cooling", "exhausted", "unauthorized"]) {
      await kv.put(`policies/${id}`, JSON.stringify({ enabled: true, generation: "g1", providers: ["anthropic"], tenantId: id, monthlyBudgetMicros: null, requestCostMicros: null, retainRequestContent: false }));
      await kv.put(`credentials/${id}`, JSON.stringify({ enabled: true, secretSha256: createHash("sha256").update(secret).digest("hex"), policyId: id, policyGeneration: "g1" }));
      await kv.put(`oauth/${id}/anthropic`, JSON.stringify({ provider: "anthropic", kind: "api_key", enabled: true, credential: "fixture-pool-anthropic-key", updatedAt: "2026-01-01T00:00:00Z" }));
    }
    await kv.put("connections/anthropic", JSON.stringify({ providerId: "anthropic", enabled: true, monthlyBudgetMicros: null }));
    const origin = await mf.ready;
    const authority = await mf.getDurableObjectNamespace("ACCESS_CONTROL", "router");
    const owner = authority.get(authority.idFromName("policy-bindings"));
    const observedAt = new Date().toISOString();
    const feedback = (key, state) => owner.fetch("https://clawrouter.internal/grant-pools/feedback", { method: "POST", body: JSON.stringify({ key, state: { observedAt, source: "provider_response", grantRevision: "2026-01-01T00:00:00Z", ...state } }) });
    // One policy's only grant is rate limited for a minute; another's model-scoped
    // quota is exhausted without a published reset; the third's credential failed.
    assert.equal((await feedback("oauth/cooling/anthropic", { status: "cooldown", cooldownUntil: new Date(Date.now() + 60_000).toISOString(), lastSignal: "rate_limited", windows: [] })).status, 200);
    assert.equal((await feedback("oauth/exhausted/anthropic", { status: "cooldown", cooldownUntil: null, lastSignal: "quota", windows: [{ id: "week-sonnet", kind: "requests", remaining: 0, limit: 100, resetAt: null, models: ["sonnet"] }] })).status, 200);
    assert.equal((await feedback("oauth/unauthorized/anthropic", { status: "cooldown", cooldownUntil: new Date(Date.now() + 300_000).toISOString(), lastSignal: "authentication", windows: [] })).status, 200);
    const send = (id) => fetch(new URL("/v1/messages", origin), { method: "POST", headers: { authorization: `Bearer clawrouter-live-${id}-${secret}`, "content-type": "application/json" }, body: JSON.stringify({ model: "anthropic/claude-sonnet-5", max_tokens: 16, messages: [{ role: "user", content: "hello" }] }), signal: AbortSignal.timeout(10_000) });
    const body = { error: { code: "upstream_grant_pool_unavailable", message: "provider anthropic has no available scoped upstream grant" } };

    const cooling = await send("cooling");
    assert.equal(cooling.status, 429);
    assert.ok(["59", "60"].includes(cooling.headers.get("retry-after")), cooling.headers.get("retry-after"));
    assert.ok(cooling.headers.get("access-control-expose-headers").split(",").includes("retry-after"));
    assert.deepEqual(await cooling.json(), body);

    const exhausted = await send("exhausted");
    assert.equal(exhausted.status, 503);
    assert.equal(exhausted.headers.get("retry-after"), null);
    assert.deepEqual(await exhausted.json(), body);

    const unauthorized = await send("unauthorized");
    assert.equal(unauthorized.status, 503);
    assert.equal(unauthorized.headers.get("retry-after"), null);
    assert.deepEqual(await unauthorized.json(), body);
  } finally {
    await mf?.dispose();
    await rm(temporary, { recursive: true, force: true });
  }
});
