import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildCodexCatalog } from "../scripts/codex-catalog.mjs";
import { nativeCodexClient } from "./helpers/native-codex.mjs";

const binary = process.env.CLAWROUTER_CODEX_BINARY;
const producer = process.env.CLAWROUTER_CODEX_CATALOG_BINARY ?? binary;
const model = "gpt-6-astra";
const secret = "native-router-fixture-secret";
const key = `clawrouter-live-fixture-${secret}`;
const rotatedSecret = "native-router-rotated-fixture-secret";
const rotatedKey = `clawrouter-live-fixture-${rotatedSecret}`;
// An interrupted response retains its conservative reservation. Leave room for
// the following request's reservation as well as that already-settled charge.
const limit = 1_000_000_000;

for (const transport of ["http", "websocket"]) {
  test(`native Codex through workerd: ${transport}, continuation, cancellation and credential lifecycle`, { skip: !binary, timeout: 90_000 }, async (t) => {
    const { startWorkerdFixture } = await import("./helpers/workerd.mjs");
    const home = await mkdtemp(join(tmpdir(), "clawrouter-native-router-"));
    let mf, client;
    try {
      mf = await startWorkerdFixture(home, routerFixture(), upstreamFixture());
      const kv = await mf.getKVNamespace("POLICY_KV", "router");
      const policy = { enabled: true, generation: "g1", providers: ["openai"], tenantId: "default", monthlyBudgetMicros: limit, requestCostMicros: null, retainRequestContent: false };
      const credential = { enabled: true, secretSha256: createHash("sha256").update(secret).digest("hex"), policyId: "fixture", policyGeneration: "g1" };
      await kv.put("policies/fixture", JSON.stringify(policy));
      await kv.put("credentials/fixture", JSON.stringify(credential));
      await kv.put("connections/openai", JSON.stringify({ providerId: "openai", enabled: true, monthlyBudgetMicros: limit }));
      const origin = await mf.ready;
      let currentKey = key;
      const dispatch = (path, credentialKey = currentKey) => fetch(new URL(path, origin), { headers: { authorization: `Bearer ${credentialKey}` }, signal: AbortSignal.timeout(10_000) });
      const discovered = await dispatch("/v1/catalog");
      assert.equal(discovered.status, 200);
      const env = { PATH: process.env.PATH, HOME: home, CODEX_HOME: home, RUST_LOG: "warn", CLAWROUTER_API_KEY: key };
      const bundled = JSON.parse(execFileSync(producer, ["debug", "models", "--bundled"], { env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 20_000, stdio: ["ignore", "pipe", "pipe"] }));
      // Export the actual credential's discovery projection, never an admin union.
      const catalog = await discovered.json();
      const exported = buildCodexCatalog(catalog, bundled, "openai");
      assert.ok(exported.catalog.models.some(({ slug }) => slug === model));
      await writeFile(join(home, "models.json"), JSON.stringify(exported.catalog));
      await writeFile(join(home, "config.toml"), `model = "${model}"
model_provider = "fixture"
model_catalog_json = ${JSON.stringify(join(home, "models.json"))}
service_tier = "priority"
web_search = "disabled"
approval_policy = "never"
sandbox_mode = "read-only"
cli_auth_credentials_store = "file"
chatgpt_base_url = "${new URL("/control", origin)}"
[model_providers.fixture]
name = "Fixture"
base_url = "${new URL(exported.nativeBasePath, origin)}"
env_key = "CLAWROUTER_API_KEY"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = ${transport === "websocket"}
request_max_retries = 0
stream_max_retries = 0
stream_idle_timeout_ms = 10000
`);
      const toolCalls = [];
      let thread;
      async function startClient(apiKey) {
        client = nativeCodexClient(t, binary, home, { ...env, CLAWROUTER_API_KEY: apiKey }, (request) => {
          assert.equal(request.method, "item/tool/call");
          assert.equal(request.params.tool, "fixture_echo");
          assert.deepEqual(request.params.arguments, { message: "fixture" });
          toolCalls.push(request.params);
          return { success: true, contentItems: [{ type: "inputText", text: "fixture tool result" }] };
        });
        await client.rpc("initialize", { clientInfo: { name: "clawrouter_fixture", version: "1.0.0" }, capabilities: { experimentalApi: true } });
        client.child.stdin.write('{"method":"initialized"}\n');
        assert.equal((await client.rpc("account/read", { refreshToken: false })).requiresOpenaiAuth, false);
        assert.ok((await client.rpc("model/list", {})).data.some((item) => item.model === model));
        thread = await client.rpc("thread/start", { model, modelProvider: "fixture", cwd: home, ephemeral: true, approvalPolicy: "never", sandbox: "read-only", dynamicTools: [{ type: "function", name: "fixture_echo", description: "Echo synthetic fixture text.", inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"], additionalProperties: false } }] });
      }
      await startClient(key);
      const startTurn = (text) => client.rpc("turn/start", { threadId: thread.thread.id, input: [{ type: "text", text }], serviceTier: "priority" });
      async function finishTurn(started) {
        let completed;
        await until(() => {
          assert.deepEqual(client.errors, []);
          completed = client.notifications.find(({ method, params }) => method === "turn/completed" && params.turn.id === started.turn.id);
          return !!completed;
        });
        return completed.params.turn;
      }
      const turn = async (text) => finishTurn(await startTurn(text));
      const assertComplete = (completed) => assert.equal(completed.status, "completed", completed.error?.message?.replaceAll(key, "[fixture credential]").replaceAll(rotatedKey, "[fixture credential]"));
      for (const input of ["Call fixture_echo once with message fixture.", "Return fixture complete for the second turn."]) {
        assertComplete(await turn(input));
      }
      assert.equal(toolCalls.length, 1);
      const upstream = await mf.getWorker("upstream");
      const state = () => upstream.fetch("https://fixture.example/state").then((response) => response.json());
      const before = await state();
      const generated = before.requests.filter(({ body }) => body.generate !== false);
      assert.equal(generated.length, 3, "one tool call, its continuation, and a second user turn");
      assert.ok(before.requests.every(({ transport: actual, authorized, lite, body }) => actual === transport && authorized && body.model === model && body.service_tier === "priority" &&
        (transport === "http" ? lite : body.client_metadata?.ws_request_header_x_openai_internal_codex_responses_lite === "true")));
      assert.ok(generated[1].body.input.some((item) => item.type === "function_call_output" && item.call_id === "fixture_call" && JSON.stringify(item.output).includes("fixture tool result")));
      if (transport === "websocket") {
        assert.equal(before.connections, 1, "both turns reuse the native WebSocket");
        assert.equal(generated[1].body.previous_response_id, generated[0].responseId);
      }
      let usage;
      await until(async () => {
        usage = await (await dispatch("/v1/usage")).json();
        return usage.usage?.events?.length === before.requests.length;
      });
      const receipts = usage.usage.events;
      assert.equal(new Set(receipts.map(({ request_id }) => request_id)).size, before.requests.length);
      assert.ok(receipts.every((receipt) => receipt.status === "success" && receipt.content_retained === false && receipt.requested_service_tier === "priority" && receipt.served_service_tier === "priority" && receipt.cost_basis === "manifest_pricing"));
      let expected = before.requests.reduce((cost, { body }) => cost + (body.generate === false ? 60 : 1_080), 0);
      assert.equal(usage.usage.summary.actualCostMicros, expected);
      assert.equal(usage.budget.spentMicros, expected);
      const budgets = await mf.getDurableObjectNamespace("BUDGET_LEDGER", "router");
      async function ledgerFacts() {
        return Promise.all([["default:fixture", "default/fixture"], ["provider:openai", "provider/openai"]].map(async ([name, policyId]) => {
          const stub = budgets.get(budgets.idFromName(name));
          const month = new Date().toISOString().slice(0, 7);
          const status = await (await stub.fetch(`https://budget/status?policy_id=${policyId}&window_key=${policyId}/${month}&limit_micros=${limit}`)).json();
          const unsettled = await (await stub.fetch("https://budget/fixture-unsettled")).json();
          return { spent: status.spentMicros, unsettled: unsettled.count };
        }));
      }
      assert.deepEqual(await ledgerFacts(), [{ spent: expected, unsettled: 0 }, { spent: expected, unsettled: 0 }]);

      // Wait for a native item notification, not just an upstream request: this
      // establishes delivery after headers and excludes pre-header accounting.
      assert.equal((await upstream.fetch("https://fixture.example/hold", { method: "POST" })).status, 200);
      const interrupted = await startTurn("Return a synthetic fixture item, then wait.");
      await until(() => client.notifications.some(({ method, params }) => method === "item/completed" && params.turnId === interrupted.turn.id && params.item.type === "agentMessage"));
      const held = (await state()).requests.find(({ held }) => held);
      assert.ok(held);
      await client.rpc("turn/interrupt", { threadId: thread.thread.id, turnId: interrupted.turn.id });
      assert.equal((await finishTurn(interrupted)).status, "interrupted");
      try {
        await until(async () => (await state()).aborted.includes(held.responseId), 5_000);
      } catch {
        const observed = await state();
        const ingress = await (await dispatch("/fixture-ingress")).json();
        const receipts = (await (await dispatch("/v1/usage")).json()).usage.events.map(({ status, status_code, cost_basis, actual_cost_micros }) => ({ status, status_code, cost_basis, actual_cost_micros }));
        throw new Error(`native interrupt did not abort upstream: ${JSON.stringify({ aborted: observed.aborted, canceled: observed.canceled, expired: observed.expired, ingress, receipts, ledgers: await ledgerFacts() })}`);
      }
      assert.deepEqual((await state()).expired, []);
      const priorReceiptIds = new Set(receipts.map(({ request_id }) => request_id));
      const interruptedState = await state();
      await until(async () => {
        usage = await (await dispatch("/v1/usage")).json();
        return usage.usage.events.length === interruptedState.requests.length;
      });
      const newReceipts = usage.usage.events.filter(({ request_id }) => !priorReceiptIds.has(request_id));
      const canceled = newReceipts.filter(({ status }) => status !== "success");
      assert.equal(canceled.length, 1);
      // R04 remains a product follow-up: WS currently calls caller disconnects
      // provider_error/502, while HTTP records client_error with delivered 200.
      assert.equal(canceled[0].status, transport === "http" ? "client_error" : "provider_error");
      assert.equal(canceled[0].status_code, transport === "http" ? 200 : 502);
      assert.equal(canceled[0].cost_basis, "manifest_reservation");
      assert.ok(canceled[0].actual_cost_micros > 0);
      assert.equal(canceled[0].actual_cost_micros, canceled[0].reserved_cost_micros);
      const expectedCost = (requests) => requests.reduce((cost, request) => cost + (request.held ? canceled[0].actual_cost_micros : request.body.generate === false ? 60 : 1_080), 0);
      async function assertSettled() {
        const observed = await state();
        await until(async () => {
          usage = await (await dispatch("/v1/usage")).json();
          return usage.usage.events.length === observed.requests.length;
        });
        assert.equal(new Set(usage.usage.events.map(({ request_id }) => request_id)).size, observed.requests.length);
        assert.ok(usage.usage.events.every(({ credential_id, content_retained }) => credential_id === "fixture" && content_retained === false));
        assert.ok(usage.usage.events.filter(({ request_id }) => request_id !== canceled[0].request_id).every((receipt) => receipt.status === "success" && receipt.cost_basis === "manifest_pricing" && receipt.requested_service_tier === "priority" && receipt.served_service_tier === "priority"));
        expected = expectedCost(observed.requests);
        assert.equal(usage.usage.summary.actualCostMicros, expected);
        assert.equal(usage.budget.spentMicros, expected);
        assert.deepEqual(await ledgerFacts(), [{ spent: expected, unsettled: 0 }, { spent: expected, unsettled: 0 }]);
        return observed;
      }
      await assertSettled();
      assertComplete(await turn("Return fixture complete after interruption."));
      const resumed = await assertSettled();
      if (transport === "websocket") {
        assert.equal(resumed.connections, interruptedState.connections + 1);
        const fresh = resumed.requests.filter(({ connection }) => connection === resumed.connections);
        assert.ok(fresh.length > 0);
        assert.equal(fresh[0].body.previous_response_id, undefined, "new socket must replay input without the interrupted response ID");
        assert.ok(fresh.every(({ body }) => body.previous_response_id !== held.responseId));
      }

      const authority = await mf.getDurableObjectNamespace("ACCESS_CONTROL", "router");
      const authorityObject = authority.get(authority.idFromName("policy-bindings"));
      const resolvePolicy = () => authorityObject.fetch("https://authority/policies/resolve", { method: "POST", body: JSON.stringify({ policyIds: ["fixture"] }) }).then((response) => response.json());
      const policyBeforeRotation = await resolvePolicy();
      assert.deepEqual(policyBeforeRotation.policies.map(({ policyId }) => policyId), ["fixture"]);
      assert.deepEqual(policyBeforeRotation.missingPolicyIds, []);
      const rotatedCredential = { ...credential, secretSha256: createHash("sha256").update(rotatedSecret).digest("hex") };
      const rotated = await authorityObject.fetch("https://authority/credentials/put", { method: "POST", body: JSON.stringify({ credentialId: "fixture", credential: rotatedCredential }) });
      assert.equal(rotated.status, 200);
      const oldProcess = await turn("This old credential must not reach upstream.");
      assert.equal(oldProcess.status, "failed");
      assert.match(JSON.stringify(oldProcess), /invalid_proxy_key|proxy key secret is invalid/);
      assert.equal((await state()).requests.length, resumed.requests.length);
      assert.equal((await dispatch("/v1/catalog", key)).status, 401);
      currentKey = rotatedKey;
      assert.deepEqual((await (await dispatch("/v1/catalog")).json()).providers.map(({ id }) => id), catalog.providers.map(({ id }) => id));
      assert.deepEqual(await resolvePolicy(), policyBeforeRotation);
      assert.equal(/fallback model metadata|model metadata.*not found/i.test(client.stderr() + JSON.stringify(client.notifications)), false);
      await client.close();
      await startClient(rotatedKey);
      assertComplete(await turn("Return fixture complete using the rotated credential."));
      const afterRotation = await assertSettled();
      const revoked = await authorityObject.fetch("https://authority/credentials/put", { method: "POST", body: JSON.stringify({ credentialId: "fixture", credential: { ...rotatedCredential, enabled: false } }) });
      assert.equal(revoked.status, 200);
      const rejected = await turn("This revoked turn must not reach upstream.");
      assert.equal(rejected.status, "failed");
      assert.match(JSON.stringify(rejected), /proxy_key_revoked|proxy key is revoked/);
      assert.equal((await state()).requests.length, afterRotation.requests.length);
      assert.deepEqual(await ledgerFacts(), [{ spent: expected, unsettled: 0 }, { spent: expected, unsettled: 0 }]);
      assert.equal(/fallback model metadata|model metadata.*not found/i.test(client.stderr() + JSON.stringify(client.notifications)), false);
    } finally {
      await client?.close();
      await mf?.dispose();
      await rm(home, { recursive: true, force: true });
    }
  });
}

async function until(predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("native router fixture timed out");
}

function routerFixture() { return `
import handler, { BudgetLedgerObject as RealBudgetLedger } from "./worker/index.ts";
export * from "./worker/index.ts";
export class BudgetLedgerObject extends RealBudgetLedger {
  constructor(state) { super(state); this.fixtureSql = state.storage.sql; }
  async fetch(request) {
    if (new URL(request.url).pathname === "/fixture-unsettled") return Response.json([...this.fixtureSql.exec("SELECT COUNT(*) AS count FROM budget_reservations WHERE settled = 0")][0]);
    return super.fetch(request);
  }
}
const ingress = [];
export default { ...handler, async fetch(request, env, context) {
  if (new URL(request.url).pathname === "/fixture-ingress") return Response.json(ingress);
  if (request.method === "POST" && new URL(request.url).pathname.endsWith("/responses")) {
    const entry = { aborted: false }; ingress.push(entry);
    request.signal.addEventListener("abort", () => { entry.aborted = true; }, { once: true });
  }
  return handler.fetch(request, env, context);
} };
`; }

function upstreamFixture() { return `
const requests = [], aborted = [], canceled = [], expired = []; let connections = 0, generated = 0, holdNext = false;
function respond(body, request, transport, connection = null) {
  const responseId = 'fixture_response_' + (requests.length + 1);
  const warmup = body.generate === false;
  const held = holdNext && !warmup;
  if (held) holdNext = false;
  requests.push({ body, responseId, transport, connection, held, authorized: request.headers.get('authorization') === 'Bearer fixture-upstream-key', lite: request.headers.get('x-openai-internal-codex-responses-lite') === 'true' });
  const output = warmup ? [] : generated++ === 0
    ? [{ id: 'fixture_fc', type: 'function_call', call_id: 'fixture_call', name: 'fixture_echo', arguments: '{"message":"fixture"}' }]
    : [{ id: 'fixture_message_' + generated, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'fixture complete', annotations: [] }] }];
  const result = { id: responseId, object: 'response', status: 'completed', model: body.model, output, service_tier: 'priority', usage: { input_tokens: warmup ? 3 : 14, output_tokens: warmup ? 0 : 8, total_tokens: warmup ? 3 : 22, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } } };
  const events = [{ type: 'response.created', response: { ...result, status: 'in_progress', output: [] } }, ...output.map((item, output_index) => ({ type: 'response.output_item.done', output_index, item }))];
  if (!held) events.push({ type: 'response.completed', response: result });
  return { events, heldId: held ? responseId : null };
}
export default { async fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === '/state') return Response.json({ requests, connections, aborted, canceled, expired });
  if (path === '/hold' && request.method === 'POST') { holdNext = true; return new Response('armed'); }
  if (request.url !== 'https://api.openai.com/v1/responses') return new Response('unexpected upstream route', { status: 400 });
  if (request.headers.get('upgrade') === 'websocket') {
    const connection = ++connections;
    const pair = new WebSocketPair(); pair[1].accept();
    let heldId, timer;
    pair[1].addEventListener('close', () => {
      if (heldId) aborted.push(heldId);
      clearTimeout(timer);
      pair[1].close();
    });
    pair[1].addEventListener('message', ({ data }) => {
      const body = JSON.parse(data);
      const response = respond(body, request, 'websocket', connection);
      for (const event of response.events) pair[1].send(JSON.stringify({ ...event, ...(body.stream_id ? { stream_id: body.stream_id } : {}) }));
      if (response.heldId) {
        heldId = response.heldId;
        timer = setTimeout(() => { expired.push(heldId); pair[1].close(); }, 30_000);
      }
    });
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
  if (request.method !== 'POST') return new Response('unexpected upstream method', { status: 405 });
  const { events, heldId } = respond(await request.json(), request, 'http');
  const prefix = events.map(event => 'event: ' + event.type + '\\ndata: ' + JSON.stringify(event) + '\\n\\n').join('');
  const headers = { 'content-type': 'text/event-stream' };
  if (!heldId) return new Response(prefix, { headers });
  let sent = false, timer, release, producer;
  const onAbort = () => { aborted.push(heldId); clearTimeout(timer); producer.error(request.signal.reason); release?.(); };
  request.signal.addEventListener('abort', onAbort, { once: true });
  return new Response(new ReadableStream({
    start(controller) { producer = controller; },
    pull(controller) {
      if (!sent) { sent = true; controller.enqueue(new TextEncoder().encode(prefix)); return; }
      // Only the upstream request signal proves abort; local stream cancellation
      // and the bounded watchdog must not make a broken client lifecycle pass.
      return new Promise((resolve) => {
        release = resolve;
        timer = setTimeout(() => { expired.push(heldId); request.signal.removeEventListener('abort', onAbort); controller.close(); resolve(); }, 30_000);
      });
    },
    cancel() { canceled.push(heldId); clearTimeout(timer); release?.(); },
  }, { highWaterMark: 0 }), { headers });
} };
`; }
