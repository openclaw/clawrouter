import { perRequestAuthority } from "./typescript-setup.mjs";
perRequestAuthority();
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { createGrantAuthority } from "./grant-authority-fixture.mjs";
import { sqlBudgetNamespace } from "./sql-budget-namespace.mjs";
const { snapshot, configuredUpstream } = await import("../providers.ts");
const { authorityCall } = await import("../authority.ts");
const { sha256Hex } = await import("../utils.ts");
const { default: worker } = await import("../index.ts");

const compiled = JSON.parse(execFileSync(process.execPath, ["scripts/compile-providers.mjs", "providers/copilot-proxy.provider.yaml"], { encoding: "utf8" }));
const provider = compiled.providers[0];
const existing = snapshot.providers.findIndex(row => row.id === provider.id);
if (existing < 0) snapshot.providers.push(provider); else snapshot.providers[existing] = provider;
Object.assign(snapshot.model_index, compiled.model_index);
for (const [id, entries] of Object.entries(compiled.capability_index)) {
  snapshot.capability_index[id] = [...(snapshot.capability_index[id] ?? []).filter(row => row.provider !== provider.id), ...entries];
}

test("Copilot Proxy requires its explicit base and keeps its optional credential separate", () => {
  assert.throws(() => configuredUpstream(provider, null, { GITHUB_TOKEN: "synthetic-foreign" }), error => error.code === "provider_not_configured");
  const auth = configuredUpstream(provider, null, { COPILOT_PROXY_BASE_URL: "https://proxy.example/v1", GITHUB_TOKEN: "synthetic-foreign" });
  assert.equal(auth.baseUrl, "https://proxy.example/v1");
  assert.equal(auth.headers.has("authorization"), false);
  assert.equal(provider.models[0].pricing, null);
  assert.equal(provider.models[0].nativeCapabilities, undefined);
});

for (const authenticated of [false, true]) for (const route of ["native", "manifest", "unified"]) test(`Copilot Proxy real Worker: auth=${authenticated}, ${route} SSE and SQL settlement`, async t => {
  const pending = [], events = [], records = new Map();
  const env = {
    COPILOT_PROXY_BASE_URL: "https://proxy.example/v1", COPILOT_PROXY_MODEL: "configured-model",
    GITHUB_TOKEN: "synthetic-foreign-github", OPENAI_API_KEY: "synthetic-foreign-openai",
    ...(authenticated ? { COPILOT_PROXY_API_KEY: "synthetic-selected" } : {}),
    POLICY_KV: {
      async get(key) { return Array.isArray(key) ? new Map(key.map(k => [k, records.get(k) ?? null])) : records.get(key) ?? null; },
      async put(key, value) { records.set(key, JSON.parse(value)); },
      async list() { return { keys: [], list_complete: true }; },
    },
    BUDGET_LEDGER: sqlBudgetNamespace(t),
    USAGE_QUEUE: { async send(event) { events.push(event); } },
  };
  const authority = createGrantAuthority(undefined, env);
  env.ACCESS_CONTROL = { idFromName: name => name, get: () => authority };
  const policy = { enabled: true, generation: "fixture", providers: ["copilot-proxy"], models: null, tenantId: "fixture", monthlyBudgetMicros: 100, requestCostMicros: 7, budgetMode: "reserve", retainRequestContent: false };
  await authorityCall(env, "/policies/initialize-all", [
    { policyId: "paid", policy },
    { policyId: "unpriced", policy: { ...policy, requestCostMicros: null } },
    { policyId: "foreign", policy: { ...policy, providers: ["openai"] } },
  ]);
  await authorityCall(env, "/credentials/initialize-all", await Promise.all(["paid", "unpriced", "foreign"].map(async credentialId => ({ credentialId, credential: { enabled: true, secretSha256: await sha256Hex("fixture-secret"), policyId: credentialId, policyGeneration: "fixture" } }))));
  await authorityCall(env, "/connections/initialize-all", [{ providerId: "copilot-proxy", enabled: true }]);
  const request = (key, path, body) => worker.fetch(new Request(`https://router.example${path}`, {
    method: body ? "POST" : "GET",
    headers: { authorization: `Bearer clawrouter-live-${key}-fixture-secret`, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }), env, { waitUntil: promise => pending.push(promise) });
  const upstream = t.mock.method(globalThis, "fetch", () => { throw new Error("unexpected provider I/O"); });
  const catalog = await request("paid", "/v1/catalog");
  assert.equal(catalog.status, 200);
  const row = (await catalog.json()).providers.find(row => row.id === "copilot-proxy");
  assert.ok(row.offers.some(offer => offer.eligible));
  const path = route === "native" ? row.nativeBaseUrl + row.routes.find(route => route.endpoint === "chat_completions").path : route === "manifest" ? "/v1/proxy/copilot-proxy/chat_completions" : "/v1/chat/completions";
  const body = { model: "configured-model", stream: true, stream_options: { include_usage: true },
    messages: [{ role: "assistant", content: null, reasoning_content: "synthetic-reasoning", tool_calls: [{ id: "call_fixture", type: "function", function: { name: "lookup", arguments: "{}" } }] }, { role: "tool", tool_call_id: "call_fixture", content: "synthetic-result" }] };
  const selectedBody = route === "native" ? body : { ...body, model: "copilot-proxy/configured" };
  const input = route === "manifest" ? { body: selectedBody } : selectedBody;
  for (const [key, status, code] of [["invalid", 401, null], ["unpriced", 400, "pricing_required"], ["foreign", 403, "provider_not_allowed"]]) {
    const response = await request(key, path, input);
    assert.equal(response.status, status, await response.clone().text());
    if (code) assert.equal((await response.json()).error.code, code);
  }
  assert.equal(upstream.mock.callCount(), 0);
  const wire = `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: { content: "synthetic-output" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "fixture", choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })}\n\ndata: [DONE]\n\n`;
  upstream.mock.mockImplementation(async (url, init) => {
    assert.equal(String(url), "https://proxy.example/v1/chat/completions");
    const headers = new Headers(init.headers);
    assert.equal(headers.get("authorization"), authenticated ? "Bearer synthetic-selected" : null);
    assert.equal(headers.has("x-api-key"), false);
    assert.deepEqual(JSON.parse(init.body), body);
    let offset = 0;
    const bytes = new TextEncoder().encode(wire);
    return new Response(new ReadableStream({ pull(controller) {
      if (offset === bytes.length) { controller.close(); return; }
      const end = Math.min(offset + 7, bytes.length); controller.enqueue(bytes.slice(offset, end)); offset = end;
    } }), { headers: { "content-type": "text/event-stream" } });
  });
  const response = await request("paid", path, input);
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(await response.text(), wire);
  while (pending.length) await Promise.all(pending.splice(0));
  assert.equal(upstream.mock.callCount(), 1);
  const success = events.filter(event => event.type === "clawrouter.usage.v1" && event.status === "success");
  assert.equal(success.length, 1);
  const [event] = success;
  assert.equal(event.provider, "copilot-proxy");
  assert.equal(event.credential_id, "paid");
  assert.equal(event.policy_id, "paid");
  assert.deepEqual([event.input_tokens, event.output_tokens, event.total_tokens], [100, 20, 120]);
  assert.equal(event.cost_basis, "policy_fixed");
  assert.equal(event.actual_cost_micros, 7);
  const reservations = env.BUDGET_LEDGER.get("fixture:paid").reservations();
  assert.equal(reservations.length, 1);
  assert.equal(reservations[0].settled, 1);
  assert.equal(reservations[0].reserved_micros, 7);
  assert.doesNotMatch(JSON.stringify(event), /synthetic-reasoning|synthetic-result|synthetic-output|synthetic-selected|synthetic-foreign|fixture-secret/);
});
