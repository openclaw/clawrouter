import assert from "node:assert/strict";
import test from "node:test";
import { fixture, contract, path, control } from "./managed-runtime-fixture.mjs";
const { managedLifecycleAdapter } = await import("../managed-lifecycle-adapters.ts");
const { assertWanStandardCredential } = await import("../managed-wan.ts");
const { managedHeaderIdentity, applyManagedHeaders, managedProbeId } = await import("../managed-dispatch.ts");
const { putGrantCredentials } = await import("../grant-credentials.ts");
const adapter = managedLifecycleAdapter("replicate.predictions");
const overrides = new WeakMap();
function override(t, name, value) {
  let originals = overrides.get(t);
  if (!originals) {
    originals = new Map(); overrides.set(t, originals);
    t.after(() => { for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(adapter, key, descriptor); else delete adapter[key]; } });
  }
  if (!originals.has(name)) originals.set(name, Object.getOwnPropertyDescriptor(adapter, name));
  Object.defineProperty(adapter, name, { configurable: true, writable: true, value });
}
function installGuard(t, visited) {
  override(t, "assertDispatch", request => {
    const authorization = request.headers.get("authorization"), origin = new URL(request.url).origin;
    assert.match(authorization, /^Bearer /); assertWanStandardCredential(authorization.slice(7), origin);
    visited.push({ url: request.url, authorization });
  });
}
function installHeaders(t, version = () => "2024-11-06") {
  const original = adapter.control;
  override(t, "control", (...args) => ({ ...original(...args), headers: new Headers({ "ai-trace-id": crypto.randomUUID(), "x-runway-version": version(), accept: "application/json" }), transientHeaders: ["ai-trace-id"] }));
}

for (const pooled of [false, true]) test(`selected regional credential guard runs before every ${pooled ? "pooled" : "environment"} create/public/collector/cancel dispatch`, async t => {
  const f = await fixture(t, { pooled, configure(provider) { provider.base_urls = { default: "https://dashscope-intl.aliyuncs.com" }; } });
  const visited = []; installGuard(t, visited); installHeaders(t);
  f.upstream = request => {
    assert.deepEqual(visited.at(-1), { url: request.url, authorization: request.headers.get("authorization") });
    return Response.json(request.url.endsWith("/cancel") ? contract.responses.canceled : request.method === "POST" ? contract.responses.created : contract.responses.partial);
  };
  const created = await f.call(); assert.equal(created.status, 200, await created.clone().text()); const state = f.state(created);
  const polled = await f.call(control, null, { headers: { "Ai-trace-id": "caller-trace", "X-Runway-Version": "caller-version" } }); assert.equal(polled.status, 200, await polled.clone().text());
  f.restart(); f.advance(5000); await state.alarm();
  const canceled = await f.call(control + "/cancel", null, { method: "POST" }); assert.equal(canceled.status, 200, await canceled.clone().text());
  assert.equal(f.sent.length, 5); assert.equal(visited.length, 6, "create preflight plus one guard for each actual dispatch");
  const controls = f.sent.slice(1); assert.equal(new Set(controls.map(request => request.headers.get("ai-trace-id"))).size, controls.length);
  for (const request of controls) { assert.equal(request.headers.get("x-runway-version"), "2024-11-06"); assert.notEqual(request.headers.get("ai-trace-id"), "caller-trace"); }
  assert.ok(f.sent.every(request => request.headers.get("authorization") === "Bearer " + (pooled ? "synthetic-original-key" : "synthetic-environment-key")));
  await state.alarm(); await f.drain(); const events = await f.events(); assert.equal(events.length, 1); assert.equal(events[0].actual_cost_micros, 700);
});

for (const scenario of ["plan-key", "plan-origin", "async-guard"]) test(`${scenario} is rejected before admission and never chooses another credential`, async t => {
  const f = await fixture(t, { configure(provider) { provider.base_urls = { default: scenario === "plan-origin" ? "https://coding.dashscope.aliyuncs.com" : "https://dashscope-intl.aliyuncs.com" }; } });
  if (scenario === "plan-key") f.env.REPLICATE_API_TOKEN = "sk-sp-synthetic-plan-key";
  const visited = []; installGuard(t, visited);
  if (scenario === "async-guard") override(t, "assertDispatch", async () => {});
  const response = await f.call(); assert.equal(response.status, 503); assert.equal((await response.json()).error.code, "managed_dispatch_unavailable");
  assert.equal(f.sent.length, 0); assert.equal(f.budgetCalls.length, 0); assert.equal((await f.events()).length, 0);
});

for (const pooled of [false, true]) test(`a control-only guard rejection holds the original ${pooled ? "pooled" : "environment"} job without cancel/failover`, async t => {
  const f = await fixture(t, { pooled, configure(provider) { provider.base_urls = { default: "https://dashscope-intl.aliyuncs.com" }; } }), visited = [];
  installGuard(t, visited); const created = await f.call(), state = f.state(created); assert.equal(created.status, 200);
  override(t, "assertDispatch", () => { throw new Error("synthetic private credential diagnostic must not escape"); });
  const response = await f.call(control, null); assert.equal(response.status, 503); assert.ok(!(await response.text()).includes("private credential"));
  assert.equal(f.sent.length, 1); assert.equal(state.job().managed.terminal, null); assert.equal(state.job().event, null);
});

test("stable control version changes invalidate the original binding while new trace UUIDs do not", async t => {
  const f = await fixture(t); let version = "2024-11-06"; installHeaders(t, () => version);
  const created = await f.call(); assert.equal(created.status, 200); assert.equal((await f.call(control, null)).status, 200);
  version = "2026-11-03"; const response = await f.call(control, null); assert.ok([409, 503].includes(response.status)); assert.equal(f.sent.length, 2);
});

test("regional and credential rotation cannot turn controls into current-pool requests", async t => {
  const f = await fixture(t, { pooled: true, configure(provider) { provider.base_urls = { default: "https://dashscope-intl.aliyuncs.com" }; } });
  installGuard(t, []); assert.equal((await f.call()).status, 200);
  f.provider.base_urls.default = "https://dashscope.aliyuncs.com";
  assert.ok([409, 503].includes((await f.call(control, null)).status)); assert.equal(f.sent.length, 1);
  f.provider.base_urls.default = "https://dashscope-intl.aliyuncs.com";
  await putGrantCredentials(f.env, "oauth/fixture/replicate", { provider: "replicate", kind: "api_key", enabled: true, credential: "synthetic-new-key" });
  assert.ok([409, 503].includes((await f.call(control, null)).status)); assert.equal(f.sent.length, 1);
});

test("adapter headers cannot inject authentication, tenancy, replay or framing, including custom credential names", () => {
  const provider = { auth: { schemes: [{ type: "api_key", header: "custom-credential" }] } };
  for (const name of ["authorization", "x-api-key", "cookie", "host", "content-length", "transfer-encoding", "idempotency-key", "openai-organization", "anthropic-workspace-id", "custom-credential"]) {
    assert.throws(() => applyManagedHeaders(provider, new Headers(), { headers: new Headers({ [name]: "synthetic-value" }) }));
  }
  const headers = new Headers({ "ai-trace-id": crypto.randomUUID(), "x-runway-version": "2024-11-06" });
  const first = managedHeaderIdentity(provider, { headers, transientHeaders: ["ai-trace-id"] }); headers.set("ai-trace-id", crypto.randomUUID());
  assert.deepEqual(managedHeaderIdentity(provider, { headers, transientHeaders: ["ai-trace-id"] }), first);
  headers.set("ai-trace-id", "not-a-uuid"); assert.throws(() => managedHeaderIdentity(provider, { headers, transientHeaders: ["ai-trace-id"] }));
  headers.set("ai-trace-id", crypto.randomUUID()); assert.throws(() => managedHeaderIdentity(provider, { headers, transientHeaders: ["x-runway-version"] }));
  assert.throws(() => applyManagedHeaders(provider, new Headers({ "x-runway-version": "other" }), { headers }));
});

test("protocol-owned identity probes support bounded decimal IDs without changing legacy Replicate pins", () => {
  assert.equal(managedProbeId(adapter), "owner-pin");
  assert.equal(managedProbeId({ protocol: "pixverse.video", identityProbe: "1000000000000001", validateId(value) { assert.match(value, /^[1-9][0-9]+$/); return value; } }), "1000000000000001");
});

test("Wan cannot dispatch from a registry entry missing Standard credential qualification", async t => {
  const { assertManagedDispatch } = await import("../managed-dispatch.ts");
  override(t, "protocol", "dashscope.video"); override(t, "assertDispatch", undefined);
  assert.throws(() => assertManagedDispatch("dashscope.video", new Request("https://dashscope-intl.aliyuncs.com/api/v1/tasks/fixture")), error => error.code === "managed_dispatch_unavailable");
});
