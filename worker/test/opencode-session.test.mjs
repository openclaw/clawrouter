import assert from "node:assert/strict";
import test from "node:test";
import { fixture, grantKey } from "./managed-runtime-fixture.mjs";
const { openCodeSessionHeader } = await import("../opencode-session.ts");
const { correlateIngressRequest } = await import("../correlation.ts");
const { snapshot } = await import("../providers.ts");
const { putGrantCredentials, revokeGrantCredentials } = await import("../grant-credentials.ts");
const session = "conversation:fixture/project+turn@scope=1";
const request = (value = session, extra = {}) => {
  const valueRequest = new Request("https://router.example/v1/native/opencode/chat", { headers: { ...(value === null ? {} : { "x-clawrouter-session-id": value }), ...extra } });
  const correlated = correlateIngressRequest(valueRequest); assert.equal(correlated.error, null); return correlated.request;
};
const auth = () => ({ credentialId: "fixture-key", principalId: "synthetic@example.com", authType: "proxy_key", policyId: "fixture", policy: { tenantId: "fixture-tenant" }, contentRetentionDisabled: false });
const selection = () => ({ provider: { id: "opencode" }, endpoint: { request_format: "openai.chat_completions", response_format: "openai.chat_completions" }, method: "POST", model: { upstream: "fixture-one" } });
const upstream = () => ({ grant: null, grantKey: null, baseUrl: "https://opencode.ai/inference/openai/v1", headers: new Headers({ authorization: "Bearer synthetic-original-key" }), query: new URLSearchParams() });
const destination = () => new URL("https://opencode.ai/inference/openai/v1/chat/completions");
const value = async (r = request(), a = auth(), s = selection(), u = upstream(), d = destination()) => (await openCodeSessionHeader(r, a, s, u, d))?.value;

test("OpenCode conversation identity is stable across request IDs, model paths, cache settings and preparation", async () => {
  const r = request(), expected = await value(r); assert.match(expected, /^crs_[a-f0-9]{64}$/);
  assert.equal(await value(r), expected);
  const selected = selection(); selected.model.upstream = "fixture-two";
  selected.endpoint = { request_format: "anthropic.messages", response_format: "anthropic.messages", path: "/v1/messages" };
  const identity = auth(); identity.policy.generation = "changed";
  assert.equal(await value(request(session, { "x-request-id": "different", "cache-control": "no-cache" }), identity, selected, upstream(), new URL("https://opencode.ai/inference/anthropic/v1/messages")), expected);
  assert.doesNotMatch(expected, /synthetic|fixture|conversation|@|original-key/);
});
test("OpenCode scope separates each authenticated identity, provider, original grant and credential lineage", async () => {
  const base = await value();
  for (const change of [a => { a.credentialId = "other-key"; }, a => { a.principalId = "other@example.com"; }, a => { a.policyId = "other-policy"; }, a => { a.policy.tenantId = "other-tenant"; }, a => { a.authType = "access"; }]) {
    const identity = auth(); change(identity); assert.notEqual(await value(request(), identity), base);
  }
  assert.notEqual(await value(request("other-conversation")), base);
  const selected = selection(); selected.provider.id = "opencode-go"; assert.notEqual(await value(request(), auth(), selected), base);
  const env = upstream(); env.headers.set("authorization", "Bearer synthetic-replacement-key"); assert.notEqual(await value(request(), auth(), selection(), env), base);
  const grant = { ...upstream(), grantKey: "original-grant", grant: { credentialLineage: "original-lineage" } };
  const granted = await value(request(), auth(), selection(), grant); assert.notEqual(granted, base);
  assert.notEqual(await value(request(), auth(), selection(), { ...grant, grantKey: "other-grant" }), granted);
  assert.notEqual(await value(request(), auth(), selection(), { ...grant, grant: { credentialLineage: "new-lineage" } }), granted);
  grant.grant.updatedAt = "2026-11-04T00:00:00Z"; grant.grant.credentialGeneration = 9;
  assert.equal(await value(request(), auth(), selection(), grant), granted, "metadata and generation do not replace the owner lineage");
});
test("OpenCode standalone preparation never falls back to caller request IDs or shared static headers", async () => {
  const first = request(null, { "x-request-id": "reused", "X-OpenCode-Session": "raw-caller" });
  const once = await value(first); assert.equal(await value(first), once);
  assert.notEqual(await value(request(null, { "x-request-id": "reused", "x-opencode-session": "raw-caller" })), once);
  const configured = upstream(); configured.headers.set("X-OpenCode-Session", "raw-static");
  assert.equal(await value(request(), auth(), selection(), configured), await value());
});
test("OpenCode literal origin and original owner are mandatory; unrelated routes do not gain a session", async () => {
  for (const url of ["http://opencode.ai/v1/chat/completions", "https://opencode.ai.evil.example/v1/chat/completions", "https://opencode.ai./v1/chat/completions", "https://opencode.ai:8443/v1/chat/completions", "https://user:secret@opencode.ai/v1/chat/completions", "https://opencode.ai/v1/chat/completions#fragment"])
    await assert.rejects(value(request(), auth(), selection(), upstream(), new URL(url)), error => error.code === "invalid_opencode_session_destination");
  for (const configured of [{ ...upstream(), baseUrl: "https://other.example" }, { ...upstream(), baseUrl: "https://opencode.ai?next=1" }])
    await assert.rejects(value(request(), auth(), selection(), configured));
  await assert.rejects(value(request(), auth(), selection(), { ...upstream(), grantKey: "unowned", grant: {} }), error => error.code === "opencode_session_owner_unavailable");
  await assert.rejects(value(request(), auth(), selection(), { ...upstream(), grant: { credentialLineage: "detached" } }));
  for (const selected of [{ ...selection(), provider: { id: "other" } }, { ...selection(), method: "GET" }, { ...selection(), endpoint: { request_format: "google.generate_content", response_format: "google.generate_content" } }])
    assert.equal(await value(request(), auth(), selected), undefined);
});

async function setup(t, { providerId = "opencode", ...options } = {}) {
  const original = snapshot.providers, source = structuredClone(original.find(provider => provider.id === providerId));
  snapshot.providers = original.filter(provider => provider.id !== providerId); t.after(() => { snapshot.providers = original; });
  const f = await fixture(t, { ...options, providerId, configure(provider) {
    Object.assign(provider, source); provider.base_urls.default = "https://opencode.ai";
    const prefix = `/inference${providerId === "opencode-go" ? "/go" : ""}`;
    const chat = { ...structuredClone(provider.endpoints[0]), path: "/v1/chat/completions", upstreamPath: `${prefix}/openai/v1/chat/completions`, modelPassthrough: undefined, request_headers: ["x-opencode-session"] };
    const messages = { ...chat, id: "messages", path: "/v1/messages", upstreamPath: `${prefix}/anthropic/v1/messages`, request_format: "anthropic.messages", response_format: "anthropic.messages", streaming: null };
    provider.endpoints = [chat, messages]; provider.capabilities = [chat, messages].map(endpoint => ({ id: endpoint.id === "messages" ? "llm.messages" : "llm.chat", endpoint: endpoint.id, methods: ["POST"] }));
    // Two synthetic models prove stable identity across supported transports.
    provider.models = ["fixture-one", "fixture-two"].map(upstream => ({ ...structuredClone(provider.models[0]), id: `${providerId}/${upstream}`, upstream, capabilities: ["llm.chat", "llm.messages"], pricing: null, pricing_ref: null }));
  } });
  if (options.pooled) {
    f.policy.grantRouting = { eligibleGrants: { [providerId]: ["replicate"] }, environmentFallback: false };
    await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
  }
  f.env[source.config_keys[0]] = "synthetic-environment-key";
  f.request = ({ conversation = session, manifest = false, messages = false, model = "fixture-one", headers = {} } = {}) => {
    const endpoint = f.provider.endpoints[messages ? 1 : 0];
    const body = { model: manifest ? `${providerId}/${model}` : model, messages: [{ role: "user", content: "Synthetic" }], max_tokens: 16 };
    return f.call(manifest ? `/v1/proxy/${providerId}/${endpoint.id}` : `/v1/native/${providerId}${endpoint.path}`, manifest ? { body } : body,
      { headers: { ...(conversation === null ? {} : { "x-clawrouter-session-id": conversation }), ...headers } });
  };
  f.handles = []; f.upstream = request => {
    f.handles.push(request.headers.get("x-opencode-session"));
    return request.url.includes("anthropic")
      ? Response.json({ id: "msg_fixture", type: "message", role: "assistant", content: [{ type: "text", text: "Synthetic" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } })
      : Response.json({ id: "chat_fixture", choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Synthetic" } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
  };
  f.success = async options => { const response = await f.request(options); const text = await response.text(); assert.equal(response.status, 200, text); await f.drain(); return f.handles.at(-1); };
  t.after(f.drain); return f;
}
for (const providerId of ["opencode", "opencode-go"]) for (const pooled of [false, true]) {
  test(`OpenCode real ${providerId}/${pooled ? "grant" : "environment"} conversation is stable across native/manifest, models, formats and disabled cache`, { timeout: 15_000 }, async t => {
    const f = await setup(t, { providerId, pooled }); f.env.CLAWROUTER_HOT_CACHE_MAX_AGE_SECONDS = "0";
    const first = await f.success();
    assert.match(first, /^crs_[a-f0-9]{64}$/);
    for (const options of [{ model: "fixture-two" }, { manifest: true, model: "fixture-two" }, { messages: true }, { messages: true, manifest: true, model: "fixture-two", headers: { "cache-control": "no-cache", "x-request-id": "other-request" } }])
      assert.equal(await f.success(options), first);
    assert.equal(f.sent.length, 5);
    for (const sent of f.sent) {
      assert.equal(new URL(sent.url).origin, "https://opencode.ai"); assert.equal(sent.redirect, "manual");
      assert.equal(sent.headers.get("authorization"), `Bearer synthetic-${pooled ? "original" : "environment"}-key`);
      assert.equal(sent.headers.get("x-clawrouter-session-id"), null); assert.equal(sent.headers.get("x-request-id"), null);
      assert.doesNotMatch(sent.headers.get("x-opencode-session"), /conversation|original-key|environment-key|@/);
    }
    const events = await f.events(); assert.equal(events.length, 5); assert.ok(events.every(event => event.actual_cost_micros === 700));
  });
}
test("OpenCode caller/static native session overrides cannot forge or change the derived conversation", { timeout: 10_000 }, async t => {
  const f = await setup(t), first = await f.success();
  f.provider.adapter.passthroughHeaders.push("x-opencode-session", "x-clawrouter-session-id", "x-claude-code-session-id", "session-id"); f.provider.adapter.injectHeaders["X-OpenCode-Session"] = "synthetic-static";
  f.provider.endpoints[0].headers["X-OpenCode-Session"] = "synthetic-endpoint";
  assert.equal(await f.success({ headers: { "X-OpenCode-Session": "synthetic-caller", "x-claude-code-session-id": "raw-alias", "session-id": "raw-legacy" } }), first);
  for (const name of ["x-clawrouter-session-id", "x-claude-code-session-id", "session-id"]) assert.equal(f.sent.at(-1).headers.get(name), null);
  f.provider.adapter.injectHeaders["X-OpenCode-Session"] = "changed-static";
  assert.equal(await f.success({ headers: { "x-opencode-session": "changed-caller" } }), first);
  assert.notEqual(await f.success({ conversation: null, headers: { "x-opencode-session": "synthetic-caller", "x-request-id": "reused" } }), await f.success({ conversation: null, headers: { "x-opencode-session": "synthetic-caller", "x-request-id": "reused" } }));
});
test("OpenCode real grant lineage separates reconnection and revocation cannot fall back to environment credentials", { timeout: 10_000 }, async t => {
  const f = await setup(t, { pooled: true }), first = await f.success();
  await revokeGrantCredentials(f.env, grantKey);
  const denied = await f.request(); const text = await denied.text(); assert.equal(denied.status, 503, text); await f.drain(); assert.equal(f.sent.length, 1);
  await putGrantCredentials(f.env, grantKey, { provider: "opencode", kind: "api_key", enabled: true, credential: "synthetic-reconnected-key" });
  assert.notEqual(await f.success(), first); assert.equal(f.sent.at(-1).headers.get("authorization"), "Bearer synthetic-reconnected-key");
});
test("OpenCode real environment credential changes separate sessions without accepting a caller key", { timeout: 10_000 }, async t => {
  const f = await setup(t), first = await f.success();
  f.env.OPENCODE_API_KEY = "synthetic-new-environment";
  const second = await f.success({ headers: { "x-api-key": "synthetic-caller-key" } }); assert.notEqual(second, first);
  assert.equal(f.sent.at(-1).headers.get("authorization"), "Bearer synthetic-new-environment"); assert.equal(f.sent.at(-1).headers.get("x-api-key"), null);
});
for (const conversation of ["x".repeat(257), "has space", "comma,separated", "non-ascii-é"]) test(`OpenCode malformed conversation ${conversation.length} bytes is zero-egress`, async t => {
  const f = await setup(t); const response = await f.request({ conversation }); assert.equal(response.status, 400); await response.text();
  assert.equal(f.sent.length, 0); assert.equal(f.budgetCalls.length, 0);
});
test("OpenCode maximum bounded ASCII conversation remains valid and stays opaque upstream", async t => {
  const f = await setup(t); assert.match(await f.success({ conversation: "x".repeat(256) }), /^crs_[a-f0-9]{64}$/);
});
test("OpenCode a configured foreign origin cannot receive session or credential dispatch", async t => {
  const f = await setup(t); f.provider.base_urls.default = "https://unqualified.example";
  const response = await f.request(); assert.equal(response.status, 400); await response.text(); assert.equal(f.sent.length, 0);
});

test("OpenCode real authenticated callers cannot share the same conversation handle", async t => {
  const f = await setup(t), first = await f.success();
  await f.authority("/credentials/mutate", { operation: "create", credentialId: "second", credential: { ...f.credential, principalId: "other@example.com" }, scope: "admin", actor: { auth: "admin_token", role: "admin", email: "fixture@example.com" } });
  const second = await f.success({ headers: { authorization: "Bearer clawrouter-live-second-fixture-secret" } });
  assert.notEqual(second, first); assert.equal(f.sent.length, 2);
  assert.ok(f.sent.every(sent => !JSON.stringify([...sent.headers]).includes("other@example.com")));
});
test("OpenCode real original grant selection separates owner keys while preserving credential priority", async t => {
  const f = await setup(t, { pooled: true }), first = await f.success();
  await putGrantCredentials(f.env, "oauth/fixture/second", { provider: "opencode", kind: "api_key", enabled: true, credential: "synthetic-second-key" });
  f.policy.grantRouting = { eligibleGrants: { opencode: ["second"] }, environmentFallback: false };
  await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
  assert.notEqual(await f.success(), first); assert.equal(f.sent.at(-1).headers.get("authorization"), "Bearer synthetic-second-key");
});
test("OpenCode Console and Go real requests isolate the same caller, conversation and environment secret", async t => {
  let consoleHandle;
  await t.test("console", async child => { const f = await setup(child); consoleHandle = await f.success(); });
  await t.test("go", async child => { const f = await setup(child, { providerId: "opencode-go" }); assert.notEqual(await f.success(), consoleHandle); });
});
