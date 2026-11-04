import assert from "node:assert/strict";
import test from "node:test";
import { fixture, grantKey } from "./managed-runtime-fixture.mjs";
const { snapshot } = await import("../providers.ts");
const { putGrantCredentials, inspectGrantCredentials } = await import("../grant-credentials.ts");
const { overrideHotCacheConfig } = await import("../hot-cache.ts");
const selected = "deepseek-ai/DeepSeek-V4-Pro", hidden = "synthetic-hidden";
const chat = { model: selected, messages: [{ role: "user", content: "Synthetic prompt." }] };
const completion = { model: selected, choices: [{ message: { role: "assistant", content: "Synthetic answer." }, finish_reason: "stop" }], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } };
const catalog = { object: "list", data: [selected, hidden].map(id => ({ id, object: "model", created: 1 })) };

async function setup(t, { pooled = true, accountId, fixed = 700 } = {}) {
  const source = structuredClone(snapshot.providers.find(provider => provider.id === "gmi")); assert.ok(source);
  const models = structuredClone(snapshot.providers.find(provider => provider.id === "openai").endpoints.find(endpoint => endpoint.id === "models_list"));
  const f = await fixture(t, { providerId: "gmi", pooled, fixed, configure(provider) {
    Object.assign(provider, source);
    provider.endpoints = provider.endpoints.filter(endpoint => endpoint.id !== "models_list");
    provider.endpoints.push({ ...models, path: "/models", path_params: [], query: {}, headers: {}, request_headers: [], auth: null });
    provider.capabilities = provider.capabilities.filter(capability => capability.id !== "models.list");
    provider.capabilities.push({ id: "models.list", endpoint: "models_list", methods: ["GET"] });
  } });
  f.env.GMI_API_KEY = "synthetic-environment-key";
  f.env.GMI_ORGANIZATION_ID = "ignored-environment-organization";
  if (pooled && accountId !== undefined) await putGrantCredentials(f.env, grantKey, { provider: "gmi", kind: "api_key", enabled: true, credential: "synthetic-original-key", accountId });
  f.request = (route = "native-chat", headers = {}) => route.endsWith("catalog")
    ? f.call(route.startsWith("native") ? "/v1/native/gmi/models" : "/v1/proxy/gmi/models_list", null, { headers })
    : f.call(route.startsWith("native") ? "/v1/native/gmi/chat/completions" : "/v1/proxy/gmi/chat_completions",
      route.startsWith("native") ? chat : { body: { ...chat, model: `gmi/${selected}` } }, { headers });
  f.upstream = request => Response.json(request.method === "GET" ? catalog : completion);
  f.replace = delta => putGrantCredentials(f.env, grantKey, { provider: "gmi", kind: "api_key", enabled: true, credential: "synthetic-original-key", ...delta });
  return f;
}

for (const route of ["native-chat", "manifest-chat", "native-catalog", "manifest-catalog"]) {
  for (const accountId of [undefined, "synthetic-organization"]) test(`GMI ${route} optional organization ${accountId ?? "absent"} uses the original key`, async t => {
    const f = await setup(t, { accountId });
    f.provider.adapter.passthroughHeaders.push("X-Organization-ID");
    f.provider.adapter.injectHeaders["x-organization-id"] = "synthetic-static-organization";
    for (const endpoint of f.provider.endpoints) endpoint.headers["X-Organization-ID"] = "synthetic-endpoint-organization";
    const response = await f.request(route, { "x-organization-id": "synthetic-caller-organization" });
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(await response.json(), route.endsWith("catalog") ? catalog : completion);
    assert.equal(f.sent.length, 1); const request = f.sent[0];
    assert.equal(request.headers.get("authorization"), "Bearer synthetic-original-key");
    assert.equal(request.headers.get("x-organization-id"), accountId ?? null);
    assert.equal(request.url, `https://api.gmi-serving.com/v1/${route.endsWith("catalog") ? "models" : "chat/completions"}`);
    assert.equal(request.redirect, "manual");
    if (route.endsWith("catalog")) assert.equal(request.body, null);
    await f.drain(); const rows = await f.events(); assert.equal(rows.length, 1);
    assert.equal(rows[0].actual_cost_micros, route.endsWith("catalog") ? 0 : 700);
    assert.doesNotMatch(JSON.stringify(rows), /synthetic-(original-key|organization|caller-organization|static-organization)/);
  });
}

test("GMI fresh environment Chat cannot borrow an organization", async t => {
  const f = await setup(t, { pooled: false });
  f.provider.adapter.injectHeaders["X-Organization-ID"] = "synthetic-static-organization";
  const response = await f.request("native-chat", { "x-organization-id": "synthetic-caller-organization" });
  assert.equal(response.status, 200, await response.clone().text()); await response.text();
  assert.equal(f.sent[0].headers.get("authorization"), "Bearer synthetic-environment-key");
  assert.equal(f.sent[0].headers.has("x-organization-id"), false);
});

test("GMI keyed catalog preserves the existing original-grant requirement", async t => {
  const f = await setup(t, { pooled: false });
  const response = await f.request("native-catalog"); assert.ok(response.status >= 400); await response.text();
  assert.equal(f.sent.length, 0);
});

for (const value of ["", "synthetic\r\nInjected: bad", "synthetic,other", "x".repeat(513), 7]) test(`GMI rejects malformed owner organization (${typeof value}/${String(value).length})`, async t => {
  const f = await setup(t, { accountId: value });
  const response = await f.request(); assert.equal(response.status, 503); assert.equal(f.sent.length, 0);
  const body = await response.text(); assert.doesNotMatch(body, /synthetic-original-key|Injected/);
});

for (const change of ["account", "key", "disabled", "policy", "caller", "environment", "grant-policy", "environment-policy"]) test(`GMI ${change} change after admitted dispatch ACK denies the warm original request`, async t => {
  const f = await setup(t, { pooled: !change.startsWith("environment"), accountId: "synthetic-organization" });
  overrideHotCacheConfig({ admissionMaxAgeMs: 30000, credentialMaxAgeMs: 60000 });
  const warm = await f.request(); assert.equal(warm.status, 200); await warm.text(); await f.drain();
  const namespace = f.env.BUDGET_LEDGER; let changed = false;
  f.env.BUDGET_LEDGER = { ...namespace, get(id) { const owner = namespace.get(id); return { async fetch(url, init) {
    const response = await owner.fetch(url, init);
    if (new URL(url).pathname === "/dispatch" && !changed) {
      changed = true;
      if (change === "account") await f.replace({ accountId: "synthetic-new-organization" });
      if (change === "key") await f.replace({ credential: "synthetic-new-key", accountId: "synthetic-organization" });
      if (change === "disabled") await f.replace({ enabled: false, accountId: "synthetic-organization" });
      if (change === "policy") { f.policy.models = [`gmi/${hidden}`]; await f.authority("/policies/put", { policyId: "fixture", policy: f.policy }); }
      if (change === "caller") await f.authority("/credentials/mutate", { scope: "admin", actor: { auth: "admin_token", email: "fixture@example.com", role: "admin" }, operation: "revoke", credentialId: "fixture" });
      if (change === "environment") f.env.GMI_API_KEY = "synthetic-new-environment-key";
      if (change.endsWith("-policy")) { f.policy.grantRouting = { eligibleGrants: { gmi: [] }, environmentFallback: false }; await f.authority("/policies/put", { policyId: "fixture", policy: f.policy }); }
    }
    return response;
  } }; } };
  const response = await f.request(); assert.ok(response.status >= 400); await response.text();
  assert.equal(changed, true); assert.equal(f.sent.length, 1);
  await f.drain(); assert.deepEqual((await f.events()).map(row => row.actual_cost_micros).sort((a, b) => a - b), [0, 700]);
});

for (const change of ["account", "key", "disabled", "caller"]) test(`GMI keyed catalog ${change} during the complete read prevents publication`, async t => {
  const f = await setup(t, { accountId: "synthetic-organization" });
  f.upstream = () => new Response(new ReadableStream({ async pull(controller) {
    if (change === "account") await f.replace({ accountId: "synthetic-new-organization" });
    if (change === "key") await f.replace({ credential: "synthetic-new-key", accountId: "synthetic-organization" });
    if (change === "disabled") await f.replace({ enabled: false });
    if (change === "caller") await f.authority("/credentials/mutate", { scope: "admin", actor: { auth: "admin_token", email: "fixture@example.com", role: "admin" }, operation: "revoke", credentialId: "fixture" });
    controller.enqueue(new TextEncoder().encode(JSON.stringify(catalog))); controller.close();
  } }, { highWaterMark: 0 }), { headers: { "content-type": "application/json" } });
  const response = await f.request("native-catalog"); assert.ok(response.status >= 400);
  assert.doesNotMatch(await response.text(), /synthetic-hidden|DeepSeek-V4-Pro|synthetic-original-key/);
  assert.equal(f.sent.length, 1); await f.drain(); assert.ok((await f.events()).every(row => row.actual_cost_micros === 0));
});

for (const models of [[`gmi/${selected}`], []]) test(`GMI final current policy filters the keyed catalog after read (${models.length})`, async t => {
  const f = await setup(t, { accountId: "synthetic-organization" });
  f.upstream = async () => { f.policy.models = models; await f.authority("/policies/put", { policyId: "fixture", policy: f.policy }); return Response.json(catalog); };
  const response = await f.request("manifest-catalog"); assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(await response.json(), { object: "list", data: models.length ? [catalog.data[0]] : [] });
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].headers.get("x-organization-id"), "synthetic-organization");
});

test("GMI organization removal is authoritative and does not inherit static metadata", async t => {
  const f = await setup(t, { accountId: "synthetic-organization" });
  const before = await inspectGrantCredentials(f.env, grantKey);
  await f.replace({ accountId: null }); const after = await inspectGrantCredentials(f.env, grantKey);
  assert.notEqual(before.credentialLineage, after.credentialLineage);
  f.provider.adapter.injectHeaders["x-organization-id"] = "synthetic-static-organization";
  const response = await f.request(); assert.equal(response.status, 200); await response.text();
  assert.equal(f.sent[0].headers.has("x-organization-id"), false);
});

test("GMI preserves the registered API-key bundle source and defeats forged routing account metadata", async t => {
  const f = await setup(t, { accountId: "synthetic-organization" });
  await putGrantCredentials(f.env, grantKey, { provider: "gmi", kind: "api_key", enabled: true,
    credentials: { api_key: "synthetic-bundled-key" }, accountId: "synthetic-organization" });
  const projection = await f.env.POLICY_KV.get(grantKey, "json");
  await f.env.POLICY_KV.put(grantKey, JSON.stringify({ ...projection, accountId: "synthetic-forged-organization" }));
  const response = await f.request(); assert.equal(response.status, 200, await response.clone().text()); await response.text();
  assert.equal(f.sent[0].headers.get("authorization"), "Bearer synthetic-bundled-key");
  assert.equal(f.sent[0].headers.get("x-organization-id"), "synthetic-organization");
});

test("GMI selected grant cannot borrow an unselected account or environment key", async t => {
  const f = await setup(t);
  await putGrantCredentials(f.env, "oauth/fixture/gmi-other", { provider: "gmi", kind: "api_key", enabled: true,
    credential: "synthetic-other-key", accountId: "synthetic-other-organization", priority: 200 });
  f.policy.grantRouting = { eligibleGrants: { gmi: ["replicate"] }, environmentFallback: false };
  await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
  const response = await f.request(); assert.equal(response.status, 200, await response.clone().text()); await response.text();
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].headers.get("authorization"), "Bearer synthetic-original-key");
  assert.equal(f.sent[0].headers.has("x-organization-id"), false);
});

for (const failure of ["origin", "path", "authorization", "owner"]) test(`GMI rejects ${failure} substitution without egress`, async t => {
  const f = await setup(t, { accountId: "synthetic-organization" });
  if (failure === "origin") f.provider.base_urls.default = "https://other.example/v1";
  if (failure === "path") f.provider.endpoints.find(endpoint => endpoint.id === "chat_completions").upstreamPath = "/other/chat/completions";
  if (failure === "authorization") f.provider.adapter.injectHeaders.Authorization = "Bearer synthetic-static-key";
  if (failure === "owner") { const namespace = f.env.GRANT_CREDENTIALS; f.env.GRANT_CREDENTIALS = { ...namespace, get(id) { const owner = namespace.get(id); return { fetch(url, init) {
    return new URL(url).pathname === "/inspect" ? new Response(null, { status: 503 }) : owner.fetch(url, init);
  } }; } }; }
  const response = await f.request(); assert.ok(response.status >= 400); assert.equal(f.sent.length, 0); await response.text();
});

test("GMI generation errors never reselect another account or retry an anonymous catalog", async t => {
  const f = await setup(t, { accountId: "synthetic-organization" });
  f.policy.grantRouting = { failover: true, environmentFallback: true };
  await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
  f.upstream = () => new Response("synthetic upstream refusal", { status: 429 });
  for (const route of ["native-chat", "native-catalog"]) { const response = await f.request(route); assert.ok(response.status >= 400); await response.text(); }
  assert.equal(f.sent.length, 2); assert.ok(f.sent.every(request => request.headers.get("authorization") === "Bearer synthetic-original-key"));
});

for (const manifest of [false, true]) test(`GMI ${manifest ? "manifest" : "native"} streaming preserves original organization and token observation`, async t => {
  const f = await setup(t, { accountId: "synthetic-organization" });
  const wire = `data: ${JSON.stringify({ ...completion, object: "chat.completion.chunk", choices: [] })}\n\ndata: [DONE]\n\n`;
  f.upstream = () => new Response(wire, { headers: { "content-type": "text/event-stream" } });
  const body = { ...chat, stream: true, model: manifest ? `gmi/${selected}` : selected };
  const response = await f.call(manifest ? "/v1/proxy/gmi/chat_completions" : "/v1/native/gmi/chat/completions", manifest ? { body } : body);
  assert.equal(response.status, 200); assert.equal(await response.text(), wire);
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].headers.get("x-organization-id"), "synthetic-organization");
  assert.equal(f.sent[0].headers.get("authorization"), "Bearer synthetic-original-key");
  await f.drain(); const rows = await f.events(); assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].input_tokens, rows[0].output_tokens, rows[0].total_tokens, rows[0].actual_cost_micros], [7, 3, 10, 700]);
});

test("GMI organization binding does not qualify unknown-dollar inference", async t => {
  const f = await setup(t, { accountId: "synthetic-organization" });
  delete f.policy.requestCostMicros; await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
  const response = await f.request(); assert.equal(response.status, 402); await response.text(); assert.equal(f.sent.length, 0);
});

test("GMI binding does not alter another provider's original auth or configured headers", async t => {
  const source = structuredClone(snapshot.providers.find(provider => provider.id === "openai"));
  const model = source.models.find(model => model.capabilities.includes("llm.chat")); assert.ok(model);
  const f = await fixture(t, { providerId: "openai", pooled: true, configure(provider) { Object.assign(provider, source); } });
  f.provider.adapter.injectHeaders["x-organization-id"] = "synthetic-other-provider-value";
  f.upstream = () => Response.json({ ...completion, model: model.upstream });
  const response = await f.call("/v1/native/openai/v1/chat/completions", { ...chat, model: model.upstream });
  assert.equal(response.status, 200, await response.clone().text()); await response.text(); assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].headers.get("authorization"), "Bearer synthetic-original-key");
  assert.equal(f.sent[0].headers.get("x-organization-id"), "synthetic-other-provider-value");
});
