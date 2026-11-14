import assert from "node:assert/strict";
import test from "node:test";
import { fixture, grantKey } from "./managed-runtime-fixture.mjs";
const { snapshot } = await import("../providers.ts");
const { putGrantCredentials, inspectGrantCredentials } = await import("../grant-credentials.ts");
const { overrideHotCacheConfig } = await import("../hot-cache.ts");
const { concreteOpenAiSelection, isSelectionFailure } = await import("../proxy-selection.ts");
const { configuredUpstream } = await import("../providers.ts");
const { authenticateProxyKey } = await import("../proxy-auth.ts");
const { prepareGmiOrganizationBinding } = await import("../gmi-organization-binding.ts");
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

for (const prefix of ["gmi/", "gmi-cloud/", "gmicloud/"]) {
  for (const accountId of [undefined, "synthetic-organization"]) {
    for (const stream of [false, true]) test(`GMI unified ${prefix} ${stream ? "SSE" : "JSON"} keeps original ${accountId ? "organization" : "Bearer-only"} binding`, async t => {
      const f = await setup(t, { accountId });
      f.provider.adapter.passthroughHeaders.push("X-Organization-ID");
      f.provider.adapter.injectHeaders["x-organization-id"] = "synthetic-static-organization";
      const wire = `data: ${JSON.stringify({ ...completion, object: "chat.completion.chunk", choices: [] })}\n\ndata: [DONE]\n\n`;
      f.upstream = async request => {
        assert.equal(request.url, "https://api.gmi-serving.com/v1/chat/completions");
        assert.equal(request.redirect, "manual");
        assert.equal(request.headers.get("authorization"), "Bearer synthetic-original-key");
        assert.equal(request.headers.get("x-organization-id"), accountId ?? null);
        assert.deepEqual(await request.json(), { ...chat, stream });
        return stream ? new Response(wire, { headers: { "content-type": "text/event-stream" } }) : Response.json(completion);
      };
      const response = await f.call("/v1/chat/completions", { ...chat, model: prefix + selected, stream },
        { headers: { "x-organization-id": "synthetic-caller-organization" } });
      assert.equal(response.status, 200, await response.clone().text());
      if (stream) assert.equal(await response.text(), wire); else assert.deepEqual(await response.json(), completion);
      assert.equal(f.sent.length, 1); await f.drain();
      const rows = await f.events(); assert.equal(rows.length, 1);
      assert.deepEqual([rows[0].input_tokens, rows[0].output_tokens, rows[0].total_tokens, rows[0].actual_cost_micros], [7, 3, 10, 700]);
      assert.doesNotMatch(JSON.stringify(rows), /synthetic-(original-key|organization|caller-organization|static-organization)/);
    });
  }
}

const badSelectors = [
  ["foreign model", selection => { selection.pathParams.model = hidden; }],
  ["foreign deployment", selection => { selection.pathParams.deployment = hidden; }],
  ["router ID instead of upstream", selection => { selection.pathParams.model = `gmi/${selected}`; }],
  ["missing deployment", selection => { delete selection.pathParams.deployment; }],
  ["missing model", selection => { delete selection.pathParams.model; }],
  ["extra parameter", selection => { selection.pathParams.extra = selected; }],
  ["numeric parameter", selection => { selection.pathParams.model = 7; }],
  ["null parameter", selection => { selection.pathParams.deployment = null; }],
  ["array parameter", selection => { selection.pathParams.model = [selected]; }],
  ["trailing newline", selection => { selection.pathParams.model += "\n"; }],
  ["foreign serialized model", selection => { selection.body.model = hidden; }],
  ["missing serialized model", selection => { delete selection.body.model; }],
  ["missing selected model", selection => { selection.model = null; }],
  ["declared path parameter", selection => { selection.endpoint = { ...selection.endpoint, path_params: ["model"] }; }],
];
for (const [name, mutate] of badSelectors) test(`GMI rejects malformed internal selector: ${name}`, async t => {
  const f = await setup(t, { pooled: false });
  const request = new Request("https://router.example/v1/chat/completions", { method: "POST",
    headers: { authorization: "Bearer clawrouter-live-fixture-fixture-secret" } });
  const auth = await authenticateProxyKey(request.headers, f.env); assert.ok(!(auth instanceof Response));
  const selection = concreteOpenAiSelection("/v1/chat/completions", { ...chat, model: `gmi/${selected}` }, f.env);
  assert.equal(isSelectionFailure(selection), false);
  assert.deepEqual(selection.pathParams, { model: selected, deployment: selected });
  const upstream = configuredUpstream(f.provider, null, f.env), url = new URL(upstream.baseUrl + "/chat/completions");
  // Prove the unchanged setup reaches the binding before changing one field.
  const check = await prepareGmiOrganizationBinding(request, f.env, auth, selection, upstream, url, new Headers(upstream.headers));
  await check(new AbortController().signal);
  mutate(selection);
  await assert.rejects(prepareGmiOrganizationBinding(request, f.env, auth, selection, upstream, url, new Headers(upstream.headers)),
    error => error.status === 503 && error.code === "gmi_organization_owner_unavailable");
  assert.equal(f.sent.length, 0);
});

for (const pathParams of [{ model: selected, deployment: selected }, { model: selected }, { extra: selected },
  { model: hidden, deployment: selected }, { model: 7, deployment: selected }]) test(`GMI manifest cannot supply internal selector metadata ${JSON.stringify(pathParams)}`, async t => {
  const f = await setup(t, { accountId: "synthetic-organization" });
  const response = await f.call("/v1/proxy/gmi/chat_completions", { body: { ...chat, model: `gmi/${selected}` }, pathParams });
  assert.ok(response.status >= 400); assert.equal(f.sent.length, 0); await response.text();
});

for (const route of ["/v1/chat/completions", "/v1/native/gmi/chat/completions"]) test(`GMI ${route} cannot turn caller query into model metadata`, async t => {
  const f = await setup(t, { accountId: "synthetic-organization" });
  const response = await f.call(`${route}?model=${encodeURIComponent(selected)}&deployment=${encodeURIComponent(selected)}`,
    { ...chat, model: route.startsWith("/v1/native/") ? selected : `gmi/${selected}` });
  assert.ok(response.status >= 400); assert.equal(f.sent.length, 0); await response.text();
});

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

for (const route of ["native-chat", "native-catalog"]) test(`GMI ${route} rejection never reselects another account or retries anonymously`, async t => {
  const f = await setup(t, { accountId: "synthetic-organization" });
  await putGrantCredentials(f.env, "oauth/fixture/gmi-other", { provider: "gmi", kind: "api_key", enabled: true,
    credential: "synthetic-other-key", accountId: "synthetic-other-organization", priority: 200 });
  f.policy.grantRouting = { failover: true, environmentFallback: true };
  await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
  f.upstream = () => new Response("synthetic upstream refusal", { status: 429 });
  const response = await f.request(route); assert.ok(response.status >= 400); await response.text();
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].headers.get("authorization"), "Bearer synthetic-original-key");
  assert.equal(f.sent[0].headers.get("x-organization-id"), "synthetic-organization");
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
  const response = await f.request(); assert.equal(response.status, 400); assert.equal((await response.json()).error.code, "pricing_required"); assert.equal(f.sent.length, 0);
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
for (const accountId of [undefined, "synthetic-organization"]) test(`GMI catalog preserves original organization while cancellation cleanup holds capacity (${accountId ?? "Bearer-only"})`, { timeout: 5000 }, async t => {
  const { BodyLease, bodyBudgetCharged } = await import("../body-budget.ts");
  const f = await setup(t, { accountId }), caller = new AbortController();
  let reached, release, cancelling, cancels = 0, physical;
  const readStarted = new Promise(resolve => { reached = resolve; }), cleanup = new Promise(resolve => { release = resolve; });
  const cancelStarted = new Promise(resolve => { cancelling = resolve; });
  f.upstream = request => {
    assert.equal(request.headers.get("authorization"), "Bearer synthetic-original-key");
    assert.equal(request.headers.get("x-organization-id"), accountId ?? null);
    physical = new ReadableStream({ pull() { reached(); }, async cancel() { cancels++; cancelling(); await cleanup; } }, { highWaterMark: 0 });
    return new Response(physical, { headers: { "content-type": "application/json" } });
  };
  try {
    const pending = f.call("/v1/native/gmi/models", null, { signal: caller.signal, headers: { "x-organization-id": "synthetic-foreign" } });
    await readStarted; caller.abort(); const response = await pending; assert.equal(response.status, 502); await response.text(); await cancelStarted;
    assert.equal(physical.locked, true); assert.equal(bodyBudgetCharged(), 32 * 1024 * 1024);
    const contender = new BodyLease(); assert.equal(contender.grow(33 * 1024 * 1024), false); contender.release();
    release(); await f.drain(); assert.equal(bodyBudgetCharged(), 0); assert.equal(physical.locked, false); assert.equal(cancels, 1);
    assert.equal(f.sent.length, 1); const events = await f.events(); assert.equal(events.length, 1); assert.equal(events[0].actual_cost_micros, 0);
    assert.doesNotMatch(JSON.stringify(events), /synthetic-(original-key|organization|foreign)/);
  } finally { release(); }
});
