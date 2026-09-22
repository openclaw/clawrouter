import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Use the same locked workerd and bundler as Wrangler, without upstream network.
const require = createRequire(import.meta.resolve("wrangler/package.json"));
const { Miniflare, convertV4MiniflareOptions } = require("miniflare");
const { build } = require("esbuild");
const temporary = await mkdtemp(join(tmpdir(), "clawrouter-ws-worker-"));
const secret = "websocket-fixture-secret", key = `clawrouter-live-fixture-${secret}`;
const policy = { enabled: true, generation: "g1", providers: ["openai"], tenantId: "default", monthlyBudgetMicros: 100_000_000, requestCostMicros: null, retainRequestContent: false };
const credential = { enabled: true, secretSha256: createHash("sha256").update(secret).digest("hex"), policyId: "fixture", policyGeneration: "g1" };
let mf;
const sockets = [];
try {
  const bundle = await build({ entryPoints: ["worker/index.ts"], write: false, bundle: true, format: "esm", platform: "browser", target: "es2022", logLevel: "silent" });
  mf = new Miniflare(convertV4MiniflareOptions({ resourceTmpPath: temporary, workers: [{
    name: "router", modules: true, script: bundle.outputFiles[0].text, compatibilityDate: "2026-06-05",
    bindings: { OPENAI_API_KEY: "fixture-upstream-key" },
    kvNamespaces: ["POLICY_KV"],
    durableObjects: Object.fromEntries([["ACCESS_CONTROL", "PolicyBindingIndexObject"], ["BUDGET_LEDGER", "BudgetLedgerObject"], ["USAGE_LEDGER", "UsageLedgerObject"], ["GRANT_CREDENTIALS", "GrantCredentialObject"]].map(([binding, className]) => [binding, { className, useSQLite: true }])),
    queueProducers: { USAGE_QUEUE: "usage" }, queueConsumers: { usage: { maxBatchSize: 1, maxBatchTimeout: 0 } },
    outboundService: "upstream",
  }, { name: "upstream", modules: true, script: upstreamFixture(), compatibilityDate: "2026-06-05" }] }));
  const kv = await mf.getKVNamespace("POLICY_KV", "router");
  await kv.put("policies/fixture", JSON.stringify(policy));
  await kv.put("credentials/fixture", JSON.stringify(credential));
  await kv.put("connections/openai", JSON.stringify({ providerId: "openai", enabled: true, monthlyBudgetMicros: policy.monthlyBudgetMicros }));
  const authority = await mf.getDurableObjectNamespace("ACCESS_CONTROL", "router");
  const authorityObject = authority.get(authority.idFromName("policy-bindings"));
  const dispatch = (path, init = {}) => mf.dispatchFetch(`https://router.example${path}`, { ...init, headers: { authorization: `Bearer ${key}`, ...init.headers } });
  const denied = await mf.dispatchFetch("https://router.example/v1/responses", { headers: { upgrade: "websocket" } });
  assert.equal(denied.status, 401);
  const response = await dispatch("/v1/native/openai/v1/responses", { headers: { upgrade: "websocket", "x-request-id": "fixture-handshake", "session-id": "fixture-session", "x-openai-internal-codex-responses-lite": "true" } });
  assert.equal(response.status, 101);
  assert.equal(response.headers.get("x-request-id"), "fixture-handshake");
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  const socket = response.webSocket; assert.ok(socket); socket.accept(); sockets.push(socket);
  const messages = [];
  socket.addEventListener("message", (event) => messages.push(JSON.parse(event.data)));
  const create = (body) => socket.send(JSON.stringify({ type: "response.create", model: "gpt-6-astra", service_tier: "priority", max_output_tokens: 32, stream: true, ...body }));
  async function terminal(count) {
    await until(() => messages.filter((event) => ["response.completed", "response.incomplete", "response.failed", "error"].includes(event.type)).length >= count);
    return messages.filter((event) => ["response.completed", "response.incomplete", "response.failed", "error"].includes(event.type))[count - 1];
  }
  create({ generate: false, input: [], stream_options: { reasoning_summary_delivery: "sequential_cutoff" } });
  assert.equal((await terminal(1)).response.id, "response_1");
  create({ previous_response_id: "response_1", input: [] });
  const tool = await terminal(2);
  assert.equal(tool.response.output[0].type, "function_call");
  create({ previous_response_id: "response_2", input: [{ type: "function_call_output", call_id: "call_fixture", output: "fixture tool result" }] });
  assert.equal((await terminal(3)).response.output[0].content[0].text, "fixture complete");
  assert.ok(messages.some((event) => event.type === "codex.response.metadata" && event.headers["x-models-etag"] === "fixture-etag"));
  const upstream = await mf.getWorker("upstream");
  const state = await (await upstream.fetch("https://fixture.example/state")).json();
  assert.equal(state.headerMatch, true);
  assert.equal(state.frames.length, 3);
  assert.equal(state.frames[0].stream, undefined);
  assert.deepEqual(state.frames[0].stream_options, { reasoning_summary_delivery: "sequential_cutoff" });
  assert.equal(state.frames[1].previous_response_id, "response_1");
  assert.deepEqual(state.frames[1].input, []);
  assert.equal(state.frames[2].input[0].type, "function_call_output");
  let usage;
  await until(async () => {
    usage = await (await dispatch("/v1/usage")).json();
    return usage.usage?.summary?.requestCount === 3;
  });
  assert.equal(usage.budget.spentMicros, 2_160);
  assert.equal(usage.usage.summary.actualCostMicros, 2_160);
  const budgets = await mf.getDurableObjectNamespace("BUDGET_LEDGER", "router");
  const month = new Date().toISOString().slice(0, 7);
  const providerStatus = await budgets.get(budgets.idFromName("provider:openai")).fetch(`https://budget/status?policy_id=provider/openai&window_key=provider/openai/${month}&limit_micros=100000000`);
  assert.equal((await providerStatus.json()).spentMicros, 2_160);
  assert.equal(new Set(usage.usage.events.map((event) => event.request_id)).size, 3);
  assert.ok(usage.usage.events.every((event) => event.session_id === "fixture-session" && event.content_retained === false));
  let count = 3, spent = 2_160;
  for (const scenario of ["incomplete", "failed", "error_before_start", "error_after_start", "disconnect"]) {
    const opened = await dispatch("/v1/responses", { headers: { upgrade: "websocket", "session-id": scenario } });
    assert.equal(opened.status, 101);
    const current = opened.webSocket; current.accept(); sockets.push(current);
    current.send(JSON.stringify({ type: "response.create", model: "openai/gpt-6-astra", service_tier: "priority", input: scenario, max_output_tokens: 32 }));
    count++;
    await until(async () => {
      usage = await (await dispatch("/v1/usage")).json();
      return usage.usage.summary.requestCount === count;
    });
    const event = usage.usage.events.find((event) => event.session_id === scenario);
    const measured = scenario === "incomplete" || scenario === "failed";
    const expected = measured ? 1_080 : scenario === "error_before_start" ? 0 : event.reserved_cost_micros;
    assert.equal(event.actual_cost_micros, expected);
    assert.equal(event.status, scenario === "incomplete" ? "success" : "provider_error");
    if (!measured && expected) assert.equal(event.cost_basis, "manifest_reservation");
    spent += expected;
    assert.equal(usage.budget.spentMicros, spent);
    current.close(1000, "scenario complete");
  }
  for (const [change, code] of [[{ ...policy, retainRequestContent: true }, "content_retention_unavailable"], [{ ...policy, monthlyBudgetMicros: 0 }, "budget_exhausted"]]) {
    const updated = await authorityObject.fetch("https://authority/policies/put", { method: "POST", body: JSON.stringify({ policyId: "fixture", policy: change }) });
    assert.equal(updated.status, 200);
    const before = (await (await upstream.fetch("https://fixture.example/state")).json()).frames.length;
    const next = messages.filter((event) => ["response.completed", "response.incomplete", "response.failed", "error"].includes(event.type)).length + 1;
    create({ input: "must not be sent" });
    assert.equal((await terminal(next)).error.code, code);
    assert.equal((await (await upstream.fetch("https://fixture.example/state")).json()).frames.length, before);
    count++;
    await until(async () => { usage = await (await dispatch("/v1/usage")).json(); return usage.usage.summary.requestCount === count; });
    // A zero limit intentionally projects a blocked budget with zero spend.
    // Read the ledger to prove rejected work did not alter previous charges.
    const ledger = await budgets.get(budgets.idFromName("default:fixture")).fetch(`https://budget/status?policy_id=default/fixture&window_key=default/fixture/${month}&limit_micros=100000000`);
    assert.equal((await ledger.json()).spentMicros, spent);
    assert.equal(usage.usage.summary.actualCostMicros, spent);
  }
  await authorityObject.fetch("https://authority/policies/put", { method: "POST", body: JSON.stringify({ policyId: "fixture", policy }) });
  // Mutate only fixture authority: queued/next creates must see revocation.
  const revoke = await authorityObject.fetch("https://authority/credentials/put", { method: "POST", body: JSON.stringify({ credentialId: "fixture", credential: { ...credential, enabled: false } }) });
  assert.equal(revoke.status, 200);
  const beforeRevocation = (await (await upstream.fetch("https://fixture.example/state")).json()).frames.length;
  const nextTerminal = messages.filter((event) => ["response.completed", "response.incomplete", "response.failed", "error"].includes(event.type)).length + 1;
  create({ input: "must not reach upstream" });
  assert.equal((await terminal(nextTerminal)).error.code, "proxy_key_revoked");
  assert.equal((await (await upstream.fetch("https://fixture.example/state")).json()).frames.length, beforeRevocation);
  socket.close(1000, "fixture complete");
  console.log("Responses WebSocket workerd fixture passed: 101, native headers, prewarm, tool continuation, SQL budget/usage settlement, per-create revocation");
} finally {
  for (const socket of sockets) try { socket.close(1000, "fixture cleanup"); } catch {}
  await mf?.dispose();
  await rm(temporary, { recursive: true, force: true });
}

async function until(predicate) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("WebSocket fixture timed out");
}

function upstreamFixture() { return `
const frames = []; let headerMatch = false;
export default { async fetch(request) {
  if (new URL(request.url).pathname === '/state') return Response.json({ frames, headerMatch });
  if (request.url !== 'https://api.openai.com/v1/responses' || request.headers.get('upgrade') !== 'websocket') return new Response('unexpected upstream route', { status: 400 });
  headerMatch = request.headers.get('authorization') === 'Bearer fixture-upstream-key' && request.headers.get('session-id') === 'fixture-session' && request.headers.get('x-openai-internal-codex-responses-lite') === 'true';
  const pair = new WebSocketPair(); pair[1].accept();
  pair[1].addEventListener('message', ({ data }) => {
    const frame = JSON.parse(data); frames.push(frame);
    const id = 'response_' + frames.length;
    const output = frames.length === 2 ? [{ type: 'function_call', id: 'fc_fixture', call_id: 'call_fixture', name: 'fixture_tool', arguments: '{}' }] : frames.length === 3 ? [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'fixture complete' }] }] : [];
    const usage = { input_tokens: frame.generate === false ? 0 : 14, output_tokens: frame.generate === false ? 0 : 8, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } };
    if (frame.input === 'error_before_start') { pair[1].send(JSON.stringify({ type: 'error', status: 429, error: { code: 'rate_limit_exceeded', message: 'fixture' } })); return; }
    pair[1].send(JSON.stringify({ type: 'response.created', response: { id, status: 'in_progress' } }));
    if (frame.input === 'disconnect') { pair[1].close(1011, 'fixture disconnect'); return; }
    if (frame.input === 'error_after_start') { pair[1].send(JSON.stringify({ type: 'error', status: 500, response_id: id, error: { code: 'server_error', message: 'fixture' } })); return; }
    if (frame.input === 'incomplete' || frame.input === 'failed') { pair[1].send(JSON.stringify({ type: 'response.' + frame.input, response: { id, status: frame.input, usage, service_tier: 'priority' } })); return; }
    pair[1].send(JSON.stringify({ type: 'codex.response.metadata', headers: { 'x-models-etag': 'fixture-etag' } }));
    pair[1].send(JSON.stringify({ type: 'response.completed', response: { id, status: 'completed', output, usage, service_tier: 'priority' } }));
  });
  return new Response(null, { status: 101, webSocket: pair[0] });
} };
`;
}
