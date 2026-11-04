import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { fixture, grantKey } from "./managed-runtime-fixture.mjs";
import { eventFrame } from "./bedrock-eventstream-fixture.mjs";
const { snapshot } = await import("../providers.ts");
const { putGrantCredentials } = await import("../grant-credentials.ts");
const { BodyLease, bodyBudgetCharged } = await import("../body-budget.ts");
const model = "anthropic.claude-sonnet-4-5-20250929-v1:0", region = "us-east-1";
const origin = `https://bedrock-runtime.${region}.amazonaws.com`;
const input = () => ({ messages: [{ role: "user", content: [{ text: "synthetic prompt" }] }] });
const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15, cacheReadInputTokens: 30, cacheWriteInputTokens: 20,
  cacheDetails: [{ ttl: "5m", inputTokens: 7 }, { ttl: "1h", inputTokens: 13 }] };
const unary = (stopReason = "end_turn") => ({ output: { message: { role: "assistant", content: [{ text: "synthetic answer" }] } }, stopReason, usage });
const frame = (kind, value) => eventFrame(value, { ":message-type": "event", ":event-type": kind, ":content-type": "application/json" });
const streamWire = (stopReason = "end_turn") => Buffer.concat([
  frame("messageStart", { role: "assistant" }), frame("contentBlockDelta", { contentBlockIndex: 0, delta: { text: "synthetic answer" } }),
  frame("contentBlockStop", { contentBlockIndex: 0 }), frame("messageStop", { stopReason }), frame("metadata", { usage }),
]);

async function setup(t, options = {}) {
  const original = snapshot.providers, source = structuredClone(original.find(provider => provider.id === "aws-bedrock")); assert.ok(source);
  snapshot.providers = original.filter(provider => provider.id !== source.id); t.after(() => { snapshot.providers = original; });
  const f = await fixture(t, { ...options, providerId: source.id, configure(provider) {
    Object.assign(provider, source);
    // Candidate declarations only. Reuse a shipped exact format if present,
    // without appending duplicate route, capability or model identities.
    for (const streaming of [false, true]) {
      const format = streaming ? "aws_bedrock.converse_stream" : "aws_bedrock.converse";
      if (provider.endpoints.some(endpoint => endpoint.request_format === format)) continue;
      const endpoint = { ...structuredClone(provider.endpoints.find(endpoint => endpoint.id === "invoke_model")),
        id: streaming ? "converse_stream" : "converse", path: `/model/${"${model}"}/${streaming ? "converse-stream" : "converse"}`,
        request_format: format, response_format: streaming ? "aws_bedrock.converse_eventstream" : format,
        modelPassthrough: undefined, streaming: null, request_headers: [],
        headers: { "content-type": "application/json", accept: streaming ? "application/vnd.amazon.eventstream" : "application/json" } };
      provider.endpoints.push(endpoint); provider.capabilities.push({ id: "llm.chat", endpoint: endpoint.id, methods: ["POST"] });
    }
    const upstream = options.model ?? model, id = `bedrock/${upstream}`;
    const previous = provider.models.find(item => item.id === id) ?? provider.models[0];
    provider.models = provider.models.filter(item => item.id !== id);
    provider.models.push({ ...structuredClone(previous), id, upstream, capabilities: ["llm.chat"], pricing: null,
      inference: undefined, nativeCapabilities: undefined });
    if (options.reverse) { provider.endpoints.reverse(); provider.capabilities.reverse(); }
  } });
  Object.assign(f.env, { AWS_ACCESS_KEY_ID: "synthetic-env-access", AWS_SECRET_ACCESS_KEY: "synthetic-env-secret",
    AWS_SESSION_TOKEN: "synthetic-env-session", AWS_REGION: region });
  if (options.pooled) {
    f.policy.grantRouting = { eligibleGrants: { "aws-bedrock": ["replicate"] }, environmentFallback: false };
    await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
    await putGrantCredentials(f.env, grantKey, { provider: "aws-bedrock", kind: "api_key", enabled: true,
      credentials: { accessKeyId: "synthetic-grant-access", secretAccessKey: "synthetic-grant-secret", sessionToken: "synthetic-grant-session" } });
  }
  f.model = options.model ?? model;
  f.rows = () => [...new Set(f.budgetCalls.map(call => call.name))].flatMap(name => f.budgets.get(name).reservations());
  f.endpoint = streaming => f.provider.endpoints.find(endpoint => endpoint.request_format === (streaming ? "aws_bedrock.converse_stream" : "aws_bedrock.converse"));
  f.upstream = request => {
    f.dispatch = { rows: f.rows(), capacity: bodyBudgetCharged() };
    if (options.response) return options.response(request);
    return request.url.endsWith("/converse-stream") ? new Response(streamWire(), { headers: { "content-type": "application/vnd.amazon.eventstream" } })
      : Response.json(unary(), { headers: { "x-private-upstream": "synthetic" } });
  };
  f.request = ({ manifest = false, streaming = false, upstream = f.model, body = { ...input(), modelId: "caller-routing-alias", stream: streaming }, query = "", ...extra } = {}) => f.call(
    (manifest ? `/v1/proxy/aws-bedrock/${f.endpoint(streaming).id}` : `/v1/native/aws-bedrock/model/${encodeURIComponent(upstream)}/${streaming ? "converse-stream" : "converse"}`) + query,
    manifest ? { body, pathParams: { model: upstream } } : body, { ...extra, headers: {
      "x-amz-security-token": "synthetic-caller-session", "x-amz-content-sha256": "caller-hash", "x-api-key": "synthetic-caller", ...extra.headers,
    } });
  t.after(f.drain); return f;
}
async function settled(f) {
  await f.drain(); const events = await f.events(); assert.equal(events.length, 1); assert.equal(bodyBudgetCharged(), 0);
  assert.doesNotMatch(JSON.stringify(events), /synthetic-(?:env|grant|caller)/); return events[0];
}
async function denied(f, request = {}) {
  const response = await f.request(request), text = await response.text(); assert.ok(response.status >= 400, text);
  assert.doesNotMatch(text, /synthetic-(?:env|grant|caller)/); assert.equal(f.sent.length, 0); await f.drain();
  assert.ok((await f.events()).every(event => event.actual_cost_micros === 0)); assert.equal(bodyBudgetCharged(), 0); return response;
}
function observed(event) {
  assert.deepEqual([event.input_tokens, event.output_tokens, event.total_tokens, event.cached_input_tokens, event.cache_write_input_tokens], [60, 5, 65, 30, 20]);
}

for (const streaming of [false, true]) for (const manifest of [false, true]) {
  test(`Bedrock real ${streaming ? "quarantined stream" : "unary"} ${manifest ? "manifest" : "native"} prepares before signing and settles observed cache usage`, { timeout: 10_000 }, async t => {
    const f = await setup(t, { pooled: manifest, reverse: streaming });
    const response = await f.request({ manifest, streaming }); assert.equal(response.status, 200, response.ok ? undefined : await response.text());
    if (streaming) assert.deepEqual(Buffer.from(await response.arrayBuffer()), streamWire()); else assert.deepEqual(await response.json(), unary());
    assert.equal(response.headers.get("x-private-upstream"), null); assert.equal(f.sent.length, 1);
    const sent = f.sent[0], text = await sent.clone().text();
    assert.equal(sent.url, `${origin}/model/${encodeURIComponent(model)}/${streaming ? "converse-stream" : "converse"}`);
    assert.equal(sent.method, "POST"); assert.equal(sent.redirect, "manual"); assert.deepEqual(JSON.parse(text), input());
    assert.equal(sent.headers.get("accept"), streaming ? "application/vnd.amazon.eventstream" : "application/json");
    assert.equal(sent.headers.get("x-amz-content-sha256"), createHash("sha256").update(text).digest("hex"));
    assert.match(sent.headers.get("authorization"), new RegExp(`^AWS4-HMAC-SHA256 Credential=synthetic-${manifest ? "grant" : "env"}-access/\\d{8}/${region}/bedrock/aws4_request,`));
    assert.equal(sent.headers.get("x-amz-security-token"), `synthetic-${manifest ? "grant" : "env"}-session`); assert.equal(sent.headers.get("x-api-key"), null);
    assert.equal(f.dispatch.capacity, 64 * 1024 * 1024); assert.equal(f.dispatch.rows.length, 2);
    assert.ok(f.dispatch.rows.every(row => row.dispatch_started === 1 && row.settled === 0));
    const event = await settled(f); observed(event); assert.equal(event.actual_cost_micros, 700); assert.equal(event.cost_basis, "policy_fixed");
    assert.equal(event.model, `bedrock/${model}`); assert.ok(f.rows().every(row => row.settled === 1));
  });
}

test("Bedrock Converse preserves the registered opaque profile and native signed-reasoning/tool payload", async t => {
  const upstream = "arn:aws:bedrock:us-east-1:000000000000:inference-profile/synthetic", f = await setup(t, { model: upstream, pooled: true });
  const body = { messages: [{ role: "assistant", content: [{ reasoningContent: { reasoningText: { text: "synthetic reasoning", signature: "synthetic-signature" } } },
    { toolUse: { toolUseId: "call_1", name: "inspect", input: { value: 1 } } }] },
  { role: "user", content: [{ toolResult: { toolUseId: "call_1", content: [{ text: "synthetic result" }] } }] }] };
  const response = await f.request({ body }); assert.equal(response.status, 200, response.ok ? undefined : await response.text()); await response.text();
  assert.equal(f.sent[0].url, `${origin}/model/${encodeURIComponent(upstream)}/converse`); assert.deepEqual(await f.sent[0].json(), body);
  assert.equal((await settled(f)).actual_cost_micros, 700);
});

for (const streaming of [false, true]) for (const scenario of ["unpriced", "missing-key", "missing-region", "foreign-origin", "region-mismatch", "signing-service",
  "query", "compiled-query", "wrong-model", "invoke-only", "passthrough", "invalid-stream", "oversized"]) {
  test(`Bedrock ${streaming ? "stream" : "unary"} ${scenario} denies before paid egress`, { timeout: 10_000 }, async t => {
    const f = await setup(t, { fixed: scenario === "unpriced" ? null : 700 }), request = { streaming };
    if (scenario === "missing-key") delete f.env.AWS_SECRET_ACCESS_KEY;
    if (scenario === "missing-region") delete f.env.AWS_REGION;
    if (scenario === "foreign-origin") f.provider.base_urls.default = "https://unqualified.example";
    if (scenario === "region-mismatch") f.provider.base_urls.default = "https://bedrock-runtime.eu-west-1.amazonaws.com";
    if (scenario === "signing-service") f.provider.auth.schemes[0].service = "s3";
    if (scenario === "query") request.query = "?region=eu-west-1";
    if (scenario === "compiled-query") f.endpoint(streaming).query = { trace: "ENABLED" };
    if (scenario === "wrong-model") { request.manifest = true; request.upstream = "unregistered-model"; }
    if (scenario === "invoke-only") f.provider.models.find(item => item.upstream === f.model).capabilities = ["llm.invoke"];
    if (scenario === "passthrough") f.endpoint(streaming).modelPassthrough = { enabled: true };
    if (scenario === "invalid-stream") request.body = { ...input(), stream: streaming ? false : true };
    if (scenario === "oversized") request.body = { ...input(), metadata: "x".repeat(2 * 1024 * 1024) };
    await denied(f, request);
  });
}

for (const streaming of [false, true]) test(`Bedrock ${streaming ? "stream" : "unary"} grant-scoped policy cannot borrow environment credentials after replacement or revocation`, async t => {
  const f = await setup(t, { pooled: true });
  await putGrantCredentials(f.env, grantKey, { provider: "aws-bedrock", kind: "api_key", enabled: true, credentials: { accessKeyId: "synthetic-grant-access" } });
  await denied(f, { streaming });
  await putGrantCredentials(f.env, grantKey, { provider: "aws-bedrock", kind: "api_key", enabled: false,
    credentials: { accessKeyId: "synthetic-grant-access", secretAccessKey: "synthetic-grant-secret" } });
  await denied(f, { streaming });
});

for (const streaming of [false, true]) for (const scenario of ["redirect", "rejection", "malformed", "truncated", "compressed"]) {
  test(`Bedrock ${streaming ? "stream" : "unary"} dispatched ${scenario} is quarantined and charged conservatively once`, { timeout: 10_000 }, async t => {
    const f = await setup(t, { pooled: true, response: () => {
      if (scenario === "redirect") return new Response(null, { status: 307, headers: { location: "https://unqualified.example" } });
      if (scenario === "rejection") return Response.json({ message: "synthetic private rejection" }, { status: 401 });
      let body = streaming ? streamWire() : Buffer.from(JSON.stringify(unary()));
      if (scenario === "malformed") body[streaming ? 12 : 0] ^= 1;
      if (scenario === "truncated") body = body.subarray(0, -1);
      return new Response(body, { headers: { "content-type": streaming ? "application/vnd.amazon.eventstream" : "application/json",
        ...(scenario === "compressed" ? { "content-encoding": "gzip" } : {}) } });
    } });
    const response = await f.request({ streaming }); assert.equal(response.status, 502); assert.equal((await response.json()).error.code, "provider_unavailable");
    assert.equal(f.sent.length, 1); const event = await settled(f); assert.equal(event.actual_cost_micros, 700); assert.equal(event.input_tokens, null);
  });
}

for (const streaming of [false, true]) test(`Bedrock ${streaming ? "stream" : "unary"} valid refusal is content-free and retains qualified usage`, async t => {
  const f = await setup(t, { response: () => streaming
    ? new Response(streamWire("refusal"), { headers: { "content-type": "application/vnd.amazon.eventstream" } }) : Response.json(unary("refusal")) });
  const response = await f.request({ streaming }); assert.equal(response.status, 502);
  const body = await response.text(); assert.doesNotMatch(body, /synthetic answer/); assert.match(body, /bedrock_refusal/);
  const event = await settled(f); observed(event); assert.equal(event.actual_cost_micros, 700); assert.equal(f.sent.length, 1);
});

for (const streaming of [false, true]) test(`Bedrock ${streaming ? "stream" : "unary"} holds complete bytes and capacity until EOF; caller cancellation never releases a partial answer`, { timeout: 10_000 }, async t => {
  const reached = Promise.withResolvers(), abort = new AbortController(); let canceled = false;
  const f = await setup(t, { response: () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(streaming ? streamWire() : new TextEncoder().encode(JSON.stringify(unary()))); reached.resolve();
  }, cancel() { canceled = true; } }), { headers: { "content-type": streaming ? "application/vnd.amazon.eventstream" : "application/json" } }) });
  let delivered = false; const pending = f.request({ streaming, signal: abort.signal }).then(response => { delivered = true; return response; });
  await reached.promise; await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(delivered, false); assert.equal(bodyBudgetCharged(), 64 * 1024 * 1024);
  abort.abort(); const response = await pending; assert.equal(response.status, 502); assert.doesNotMatch(await response.text(), /synthetic answer/);
  const event = await settled(f); assert.equal(event.actual_cost_micros, 700); assert.equal(event.input_tokens, null); assert.equal(canceled, true); assert.equal(f.sent.length, 1);
});

for (const streaming of [false, true]) test(`Bedrock ${streaming ? "stream" : "unary"} capacity refusal is known-unsent with zero settlement`, async t => {
  const f = await setup(t), blocker = new BodyLease(); assert.equal(blocker.grow(20 * 1024 * 1024), true);
  let response; try { response = await f.request({ streaming }); } finally { blocker.release(); }
  assert.equal(response.status, 503); await response.text(); assert.equal(f.sent.length, 0); assert.equal((await settled(f)).actual_cost_micros, 0);
});

test("Bedrock Converse requires both original reservation dispatch acknowledgments before fetch", async t => {
  const f = await setup(t), ledger = f.env.BUDGET_LEDGER; let lost = 0;
  f.env.BUDGET_LEDGER = { idFromName: name => name, get: name => ({ async fetch(url, init) {
    if (new URL(url).pathname === "/dispatch") { lost++; return Response.json({ error: "synthetic lost ACK" }, { status: 503 }); }
    const response = await ledger.get(name).fetch(url, init);
    if (new URL(url).pathname !== "/reserve") return response;
    const receipt = await response.json(); delete receipt.dispatched; return Response.json(receipt, { status: response.status });
  } }) };
  const response = await f.request({ streaming: true }); assert.equal(response.status, 503); assert.equal((await response.json()).error.code, "accounting_unavailable");
  assert.equal(f.sent.length, 0); assert.equal(lost, 2); assert.equal((await settled(f)).actual_cost_micros, 0);
});
