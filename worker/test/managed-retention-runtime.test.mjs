import assert from "node:assert/strict";
import test from "node:test";
import { fixture, contract, path, grantKey } from "./managed-runtime-fixture.mjs";
import { adapter, override } from "./managed-omni-runtime-fixture.mjs";
const { authenticateProxyKey } = await import("../proxy-auth.ts");
const { prepareSelected } = await import("../proxy.ts");
const { putGrantCredentials } = await import("../grant-credentials.ts");
const permission = { version: "clawrouter.upstream-retention.v1", allow: [{ providerId: "replicate", protocol: "replicate.predictions" }] };
const id = contract.responses.succeeded.id;

async function setup(t, { pooled = false, policy = true, binding = true, fixed = 700 } = {}) {
  const f = await fixture(t, { pooled, fixed }), prepare = adapter.prepare;
  f.admitted = 0;
  // Exercise the admission seam, without registering a source-owned wrapper.
  override(t, "prepareAdmitted", (body, headers, params, query, admission) => {
    assert.deepEqual(admission, { upstreamRetention: "allowed" }); assert.equal(Object.isFrozen(admission), true); f.admitted++;
    return { ...prepare(body, headers, params, query), headers: new Headers() };
  });
  f.policy.upstreamRetention = policy ? structuredClone(permission) : null;
  await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
  // Derive the fixture receipt from the real configured original selection;
  // no caller-supplied hash or credential is accepted by the runtime.
  const request = new Request("https://router.example" + path, { method: "POST", headers: {
    authorization: "Bearer clawrouter-live-fixture-fixture-secret", "content-type": "application/json",
  }, body: JSON.stringify(contract.request.body) });
  const auth = await authenticateProxyKey(request.headers, f.env, [{ id: "replicate", tokenRef: "replicate" }]);
  assert.ok(!(auth instanceof Response));
  const endpoint = f.provider.endpoints.find(endpoint => endpoint.id === "predictions");
  const selected = { provider: f.provider, endpoint, model: null, capability: f.provider.capabilities.find(capability => capability.endpoint === endpoint.id)?.id ?? "image.generation",
    body: contract.request.body, method: "POST", pathParams: {} };
  const original = (await prepareSelected(request, f.env, selected, new URLSearchParams(), auth)).continuation;
  assert.ok(original);
  f.binding = { providerId: "replicate", protocol: "replicate.predictions", grantKey: original.grantKey, routeSha256: original.routeSha256,
    retention: "allow", expiresAt: new Date(Date.now() + 60_000).toISOString() };
  f.configure = entries => { f.env.CLAWROUTER_UPSTREAM_RETENTION_BINDINGS = JSON.stringify({ version: "clawrouter.upstream-retention-bindings.v1", bindings: entries }); };
  if (binding) f.configure([f.binding]);
  f.upstream = () => Response.json(contract.responses.succeeded);
  t.after(f.drain); return f;
}
async function denied(f, body = contract.request.body, expected = 403) {
  const response = await f.call(path, body), value = await response.json();
  assert.equal(response.status, expected, JSON.stringify(value));
  assert.equal(f.sent.length, 0); assert.equal(f.admitted, 0);
  assert.ok(f.budgetCalls.every(call => call.path === "/status"));
  assert.doesNotMatch(JSON.stringify(value), /synthetic-original-key|synthetic-environment-key/);
  return value;
}
for (const pooled of [false, true]) for (const missing of ["policy", "binding", "both"]) {
  test(`managed retention ${pooled ? "pooled" : "environment"} missing ${missing} denies before adapter admission, reservation or egress`, { timeout: 10_000 }, async t => {
    const f = await setup(t, { pooled, policy: missing === "binding", binding: missing === "policy" });
    assert.equal((await denied(f)).error.code, "upstream_retention_unqualified");
  });
}
for (const change of ["expired", "grant", "route", "duplicate", "caller-spoof"]) test(`managed retention ${change} cannot supply original-credential permission`, { timeout: 10_000 }, async t => {
  const f = await setup(t, { pooled: true });
  if (change === "expired") f.advance(60_000);
  if (change === "grant") f.binding.grantKey = "oauth/fixture/other";
  if (change === "route") f.binding.routeSha256 = "f".repeat(64);
  if (change === "caller-spoof") delete f.env.CLAWROUTER_UPSTREAM_RETENTION_BINDINGS;
  else f.configure(change === "duplicate" ? [f.binding, f.binding] : [f.binding]);
  await denied(f, change === "caller-spoof" ? { ...contract.request.body, retentionAllowed: true, upstreamRetention: permission } : undefined);
});
for (const pooled of [false, true]) test(`admitted ${pooled ? "pooled" : "environment"} job preserves original binding and one settlement through compaction`, { timeout: 10_000 }, async t => {
  const f = await setup(t, { pooled }), created = await f.call();
  assert.equal(created.status, 200, await created.clone().text()); await created.json();
  const state = f.state(created); await state.alarm(); f.restart(); await f.drain();
  assert.equal(state.job().phase, "complete"); const frozen = state.job();
  const response = await f.call(`${path}/${id}`, null); assert.equal(response.status, 200, await response.clone().text()); await response.json();
  assert.equal(f.admitted, 1); assert.equal(f.sent.length, 2);
  assert.ok(f.sent.every(request => request.headers.get("authorization") === (pooled ? "Bearer synthetic-original-key" : "Bearer synthetic-environment-key")));
  assert.deepEqual(state.job(), frozen); assert.equal((await f.events()).length, 1); assert.equal(frozen.amount, 700);
});
for (const change of ["server-expiry", "policy-permission", "original-grant"]) test(`retention ${change} prevents original job controls without replay or refund`, { timeout: 10_000 }, async t => {
  const f = await setup(t, { pooled: true }), created = await f.call(); assert.equal(created.status, 200, await created.clone().text()); await created.json();
  const state = f.state(created); await state.alarm(); await f.drain();
  if (change === "server-expiry") f.advance(60_000);
  if (change === "policy-permission") {
    f.policy.upstreamRetention = null; await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
  }
  if (change === "original-grant") await putGrantCredentials(f.env, grantKey, { provider: "replicate", kind: "api_key", enabled: true, credential: "synthetic-replacement" });
  const response = await f.call(`${path}/${id}`, null); await response.text(); assert.ok(response.status >= 400);
  assert.equal(f.sent.length, 1); assert.equal(state.job().amount, 700); assert.equal((await f.events()).length, 1);
});
