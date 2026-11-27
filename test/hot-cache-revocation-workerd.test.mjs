import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startWorkerdFixture } from "./helpers/workerd.mjs";

const sha = value => createHash("sha256").update(value).digest("hex");
const MAX_AGE_SECONDS = 4;

// The real Worker in workerd with its SQLite authority and the isolate hot cache
// on. Concurrent clients keep a warm isolate busy while the policy is disabled
// directly at the authority, as another isolate's admin write would. Successes
// may continue for at most the max age; afterwards every request is denied.
test("workerd: authority-side revocation reaches a warm isolate within the hot-cache max age under load", { timeout: 90_000 }, async t => {
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-hot-revoke-"));
  const admin = "synthetic-admin", secret = "hotrevokesecret", key = `clawrouter-live-hotcache-${secret}`;
  let mf;
  try {
    mf = await startWorkerdFixture(temporary, `
      import handler from "./worker/index.ts";
      export * from "./worker/index.ts";
      export default { ...handler, fetch(request, env, ctx) {
        return handler.fetch(request, { ...env, CLAWROUTER_ADMIN_TOKEN_SHA256: "${sha(admin)}", CLAWROUTER_HOT_CACHE_MAX_AGE_SECONDS: "${MAX_AGE_SECONDS}" }, ctx);
      } };
    `, `export default { async fetch(request) {
      const body = await request.json();
      return Response.json({ id: "msg_fixture", type: "message", role: "assistant", model: body.model, content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 3, output_tokens: 1 } });
    } };`, { hotCache: true });
    const origin = String(await mf.ready).replace(/\/$/, "");
    const bindings = await mf.getBindings("router");
    const authority = bindings.ACCESS_CONTROL.get(bindings.ACCESS_CONTROL.idFromName("policy-bindings"));
    const call = async (path, body) => { const response = await authority.fetch(`https://clawrouter.internal${path}`, { method: "POST", body: JSON.stringify(body) }); assert.ok(response.ok, `${path}: ${await response.text()}`); };
    const policy = { enabled: true, generation: "hot-v1", providers: ["anthropic"], models: ["anthropic/claude-sonnet-5"], tenantId: "hot", tokenRole: "service", monthlyBudgetMicros: null, requestCostMicros: 1, retainRequestContent: false };
    await call("/policies/initialize-all", [{ policyId: "hot", policy }]);
    await call("/credentials/initialize-all", [{ credentialId: "hotcache", credential: { enabled: true, secretSha256: sha(secret), policyId: "hot", policyGeneration: "hot-v1" } }]);
    await call("/connections/initialize-all", [{ providerId: "anthropic", enabled: true }]);
    for (const ref of ["grant-a", "grant-b"]) {
      const response = await fetch(`${origin}/v1/admin/upstream-grants/policies/hot/${ref}`, { method: "PUT", headers: { authorization: `Bearer ${admin}`, "content-type": "application/json" }, body: JSON.stringify({ provider: "anthropic", kind: "subscription", accessToken: `synthetic-${ref}`, maintenance: { keepWarm: false } }) });
      assert.equal(response.status, 200, await response.text());
    }
    const send = async () => {
      const response = await fetch(`${origin}/v1/messages`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ model: "anthropic/claude-sonnet-5", max_tokens: 8, messages: [{ role: "user", content: "hi" }] }) });
      await response.arrayBuffer();
      return { status: response.status, cache: response.headers.get("server-timing")?.match(/cr-cache;desc=(\w+)/)?.[1] ?? null, at: performance.now() };
    };
    const warm = [];
    for (let n = 0; n < 3; n++) warm.push(await send());
    assert.deepEqual(warm.map(row => row.status), [200, 200, 200]);
    assert.ok(warm.slice(1).some(row => row.cache === "hit"), JSON.stringify(warm));

    const rows = [];
    let revokedAt = Infinity;
    const stopAt = performance.now() + 1_000 + (MAX_AGE_SECONDS + 3) * 1_000;
    const client = async () => { while (performance.now() < stopAt) rows.push(await send()); };
    const revoke = (async () => {
      await new Promise(resolve => setTimeout(resolve, 1_000));
      await call("/policies/put", { policyId: "hot", policy: { ...policy, enabled: false } });
      revokedAt = performance.now();
    })();
    await Promise.all([revoke, ...Array.from({ length: 16 }, client)]);

    const before = rows.filter(row => row.at < revokedAt), after = rows.filter(row => row.at >= revokedAt);
    assert.ok(before.length > 50 && before.every(row => row.status === 200), `warm load before revocation: ${before.length}`);
    assert.ok(after.every(row => row.status === 200 || row.status === 403), JSON.stringify([...new Set(after.map(row => row.status))]));
    const lastSuccess = Math.max(revokedAt, ...after.filter(row => row.status === 200).map(row => row.at)) - revokedAt;
    t.diagnostic(`requests ${rows.length}; successes after revocation ${after.filter(row => row.status === 200).length}; last success ${lastSuccess.toFixed(0)} ms after revocation`);
    // One request in flight at the boundary can finish just after the bound.
    assert.ok(lastSuccess <= MAX_AGE_SECONDS * 1_000 + 1_500, `last success ${lastSuccess.toFixed(0)} ms after revocation`);
    const tail = after.filter(row => row.at - revokedAt > MAX_AGE_SECONDS * 1_000 + 1_500);
    assert.ok(tail.length > 0 && tail.every(row => row.status === 403), `post-bound statuses: ${JSON.stringify(tail.map(row => row.status))}`);
  } finally {
    await mf?.dispose();
    await rm(temporary, { recursive: true, force: true });
  }
});
