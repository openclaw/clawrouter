import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
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
  test(`native Codex through workerd: ${transport}, active-stream cancellation and credential lifecycle`, { skip: !binary, timeout: 90_000 }, async (t) => {
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
      const catalog = await discovered.json();
      const env = await configureNativeClient(home, origin, catalog, transport);
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

      // A native output delta establishes body delivery before interruption.
      // Keep HTTP output active: the 0.153 SSE reader notices consumer drop only
      // on its next recognized event; an idle stream is a separate limitation.
      assert.equal((await upstream.fetch("https://fixture.example/hold", { method: "POST" })).status, 200);
      const interrupted = await startTurn("Stream a synthetic fixture response.");
      await until(() => client.notifications.some(({ method, params }) => method === "item/agentMessage/delta" && params.turnId === interrupted.turn.id));
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
      assert.equal(canceled[0].status, "client_error");
      assert.equal(canceled[0].status_code, transport === "http" ? 200 : null);
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
      const actor = { auth: "admin_token", role: "admin", email: "token-admin" };
      const resolvePolicy = () => authorityObject.fetch("https://authority/policies/resolve", { method: "POST", body: JSON.stringify({ policyIds: ["fixture"] }) }).then((response) => response.json());
      const policyBeforeRotation = await resolvePolicy();
      assert.deepEqual(policyBeforeRotation.policies.map(({ policyId }) => policyId), ["fixture"]);
      assert.deepEqual(policyBeforeRotation.missingPolicyIds, []);
      const rotated = await authorityObject.fetch("https://authority/credentials/mutate", { method: "POST", body: JSON.stringify({ credentialId: "fixture", operation: "rotate", secretSha256: createHash("sha256").update(rotatedSecret).digest("hex"), scope: "admin", actor }) });
      assert.equal(rotated.status, 200);
      assert.equal((await rotated.json()).outcome, "updated");
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
      const revoked = await authorityObject.fetch("https://authority/credentials/mutate", { method: "POST", body: JSON.stringify({ credentialId: "fixture", operation: "revoke", scope: "admin", actor }) });
      assert.equal(revoked.status, 200);
      assert.equal((await revoked.json()).outcome, "updated");
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

for (const scenario of ["request_retry", "stream_retry", "interrupt"]) {
  test(`native Codex through workerd: HTTP defaults, ${scenario}`, { skip: !binary, timeout: 90_000 }, async t => {
    const { startWorkerdFixture } = await import("./helpers/workerd.mjs");
    const home = await mkdtemp(join(tmpdir(), "clawrouter-native-retry-"));
    let mf, client;
    try {
      mf = await startWorkerdFixture(home, routerFixture({ failFirstPublication: scenario === "request_retry" }), upstreamFixture({ toolCall: false, turnState: true }));
      const kv = await mf.getKVNamespace("POLICY_KV", "router");
      await kv.put("policies/fixture", JSON.stringify({ enabled: true, generation: "g1", providers: ["openai"], tenantId: "default", monthlyBudgetMicros: limit, requestCostMicros: null, retainRequestContent: false }));
      await kv.put("credentials/fixture", JSON.stringify({ enabled: true, secretSha256: createHash("sha256").update(secret).digest("hex"), policyId: "fixture", policyGeneration: "g1" }));
      await kv.put("connections/openai", JSON.stringify({ providerId: "openai", enabled: true, monthlyBudgetMicros: limit }));
      const origin = await mf.ready;
      const dispatch = path => fetch(new URL(path, origin), { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) });
      const discovered = await dispatch("/v1/catalog"); assert.equal(discovered.status, 200);
      const env = await configureNativeClient(home, origin, await discovered.json(), "http", true);
      client = nativeCodexClient(t, binary, home, env);
      await client.rpc("initialize", { clientInfo: { name: "clawrouter_fixture", version: "1.0.0" }, capabilities: { experimentalApi: true } });
      client.child.stdin.write('{"method":"initialized"}\n');
      const { thread } = await client.rpc("thread/start", { model, modelProvider: "fixture", cwd: home, ephemeral: true, approvalPolicy: "never", sandbox: "read-only" });
      const startTurn = text => client.rpc("turn/start", { threadId: thread.id, input: [{ type: "text", text }], serviceTier: "priority" });
      async function finishTurn(started, status) {
        let completed;
        await until(() => {
          assert.deepEqual(client.errors, []);
          completed = client.notifications.find(({ method, params }) => method === "turn/completed" && params.turn.id === started.turn.id);
          return !!completed;
        });
        assert.equal(completed.params.turn.status, status, completed.params.turn.error?.message?.replaceAll(key, "[fixture credential]"));
      }
      const upstream = await mf.getWorker("upstream");
      const state = () => upstream.fetch("https://fixture.example/state").then(response => response.json());
      if (scenario !== "request_retry") assert.equal((await upstream.fetch(`https://fixture.example/hold${scenario === "stream_retry" ? "?broken=1" : ""}`, { method: "POST" })).status, 200);
      const started = await startTurn("Return a synthetic fixture response.");
      if (scenario !== "request_retry") {
        // End the first attempt only after the actual native client receives its
        // output. EOF is a stream failure without waiting on the default idle timer.
        await until(() => client.notifications.some(({ method, params }) => method === "item/agentMessage/delta" && params.turnId === started.turn.id));
        assert.equal((await state()).requests.length, 1);
        if (scenario === "stream_retry") assert.equal((await upstream.fetch("https://fixture.example/break", { method: "POST" })).status, 200);
        else await client.rpc("turn/interrupt", { threadId: thread.id, turnId: started.turn.id });
      }
      await finishTurn(started, scenario === "interrupt" ? "interrupted" : "completed");
      if (scenario === "interrupt") {
        await until(async () => (await state()).aborted.length === 1, 5_000);
        await finishTurn(await startTurn("Return fixture complete after interruption."), "completed");
      }
      const observed = await state();
      assert.equal(observed.connections, 0);
      assert.equal(observed.requests.length, 2, "one initial attempt and one successful retry or fresh turn");
      assert.ok(observed.requests.every(({ transport, authorized, body }) => transport === "http" && authorized && body.generate !== false && body.model === model && body.service_tier === "priority"));
      assert.deepEqual(observed.expired, []);
      assert.deepEqual(observed.broken, scenario === "stream_retry" ? [observed.requests[0].responseId] : []);
      if (scenario === "interrupt") assert.deepEqual(observed.aborted, [observed.requests[0].responseId]);
      const retries = client.notifications.filter(({ method, params }) => method === "error" && params.turnId === started.turn.id && params.willRetry);
      assert.equal(retries.length, scenario === "stream_retry" ? 1 : 0, "HTTP request retries stay below the native stream-retry notification layer");
      let usage;
      await until(async () => {
        usage = await (await dispatch("/v1/usage")).json();
        assert.ok(usage.usage.events.length <= observed.requests.length);
        return usage.usage.events.length === observed.requests.length;
      });
      const ingress = await (await dispatch("/fixture-ingress")).json();
      assert.deepEqual(ingress.map(({ status }) => status), scenario === "request_retry" ? [503, 200] : [200, 200]);
      const receipts = ingress.map(({ requestId }) => usage.usage.events.filter(event => event.request_id === requestId));
      assert.ok(receipts.every(events => events.length === 1), "each actual router attempt has one receipt");
      const [failed, success] = receipts.map(events => events[0]);
      assert.equal(new Set(usage.usage.events.map(event => event.id)).size, 2);
      assert.equal(failed.status, scenario === "interrupt" ? "client_error" : "provider_error");
      assert.equal(failed.status_code, scenario === "request_retry" ? 503 : 200);
      assert.equal(failed.cost_basis, "manifest_reservation");
      assert.ok(failed.reserved_cost_micros > 0);
      assert.equal(failed.actual_cost_micros, failed.reserved_cost_micros);
      assert.equal(success.status, "success"); assert.equal(success.cost_basis, "manifest_pricing");
      assert.equal(success.actual_cost_micros, 1_080);
      assert.ok(usage.usage.events.every(event => event.credential_id === "fixture" && event.content_retained === false));
      const expected = failed.actual_cost_micros + success.actual_cost_micros;
      assert.equal(usage.usage.summary.actualCostMicros, expected); assert.equal(usage.budget.spentMicros, expected);
      const budgets = await mf.getDurableObjectNamespace("BUDGET_LEDGER", "router");
      for (const [name, policyId] of [["default:fixture", "default/fixture"], ["provider:openai", "provider/openai"]]) {
        const ledger = budgets.get(budgets.idFromName(name)), month = new Date().toISOString().slice(0, 7);
        const status = await (await ledger.fetch(`https://budget/status?policy_id=${policyId}&window_key=${policyId}/${month}&limit_micros=${limit}`)).json();
        assert.equal(status.spentMicros, expected);
        assert.deepEqual(await (await ledger.fetch("https://budget/fixture-unsettled")).json(), { count: 0 });
      }
      assert.equal(/fallback model metadata|model metadata.*not found/i.test(client.stderr() + JSON.stringify(client.notifications)), false);
    } finally {
      await client?.close();
      await mf?.dispose();
      await rm(home, { recursive: true, force: true });
    }
  });
}

// A TCP reset is an explicit disconnect even with no further provider output.
// Ordinary close of a stalled HTTP stream remains a separate qualification gap.
test("idle HTTP TCP reset: upstream abort and one cancellation receipt", { skip: !binary, timeout: 30_000 }, async () => {
  const { startWorkerdFixture } = await import("./helpers/workerd.mjs");
  const home = await mkdtemp(join(tmpdir(), "clawrouter-native-boundary-"));
  let mf;
  try {
    mf = await startWorkerdFixture(home, routerFixture(), upstreamFixture());
    const kv = await mf.getKVNamespace("POLICY_KV", "router");
    await kv.put("policies/fixture", JSON.stringify({ enabled: true, generation: "g1", providers: ["openai"], tenantId: "default", monthlyBudgetMicros: limit, retainRequestContent: false }));
    await kv.put("credentials/fixture", JSON.stringify({ enabled: true, secretSha256: createHash("sha256").update(secret).digest("hex"), policyId: "fixture", policyGeneration: "g1" }));
    await kv.put("connections/openai", JSON.stringify({ providerId: "openai", enabled: true, monthlyBudgetMicros: limit }));
    const origin = await mf.ready;
    const upstream = await mf.getWorker("upstream");
    await upstream.fetch("https://fixture.example/hold?idle=1", { method: "POST" });
    await new Promise((resolve, reject) => {
      let destroyed = false, text = "";
      const request = httpRequest(new URL("/v1/native/openai/v1/responses", origin), { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" } }, (response) => {
        assert.equal(response.statusCode, 200);
        response.on("data", (chunk) => {
          text += chunk.toString();
          if (!destroyed && text.includes("response.output_text.delta")) { destroyed = true; response.socket.resetAndDestroy(); }
        });
        response.on("close", () => { clearTimeout(timer); destroyed ? resolve() : reject(new Error("fixture stream ended before socket destruction")); });
        response.on("error", (error) => { if (!destroyed) reject(error); });
      });
      const timer = setTimeout(() => { request.destroy(); reject(new Error("raw HTTP disconnect timed out")); }, 5_000);
      request.on("error", (error) => { if (!destroyed) { clearTimeout(timer); reject(error); } });
      request.end(JSON.stringify({ model, input: "synthetic boundary control", stream: true, service_tier: "priority", max_output_tokens: 32 }));
    });
    let observed, usage;
    await until(async () => { observed = await (await upstream.fetch("https://fixture.example/state")).json(); return observed.aborted.length > 0; }, 5_000);
    assert.equal(observed.requests.length, 1);
    assert.deepEqual(observed.aborted, [observed.requests[0].responseId]);
    assert.deepEqual(observed.expired, []);
    assert.deepEqual((await (await fetch(new URL("/fixture-ingress", origin))).json()).map(({ aborted, status }) => ({ aborted, status })), [{ aborted: true, status: 200 }]);
    await until(async () => {
      usage = await (await fetch(new URL("/v1/usage", origin), { headers: { authorization: `Bearer ${key}` } })).json();
      return usage.usage.events.length === 1;
    });
    const [receipt] = usage.usage.events;
    assert.equal(receipt.status, "client_error");
    assert.equal(receipt.status_code, 200);
    assert.equal(receipt.cost_basis, "manifest_reservation");
    assert.ok(receipt.actual_cost_micros > 0);
    assert.equal(receipt.actual_cost_micros, receipt.reserved_cost_micros);
    assert.equal(usage.budget.spentMicros, receipt.actual_cost_micros);
  } finally {
    await mf?.dispose();
    await rm(home, { recursive: true, force: true });
  }
});

async function configureNativeClient(home, origin, catalog, transport, useDefaultRetries = false) {
  const env = { PATH: process.env.PATH, HOME: home, CODEX_HOME: home, RUST_LOG: "warn", CLAWROUTER_API_KEY: key };
  const bundled = JSON.parse(execFileSync(producer, ["debug", "models", "--bundled"], { env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 20_000, stdio: ["ignore", "pipe", "pipe"] }));
  // Export the actual credential's discovery projection, never an admin union.
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
${useDefaultRetries ? "" : "request_max_retries = 0\nstream_max_retries = 0\nstream_idle_timeout_ms = 10000\n"}`);
  return env;
}

async function until(predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("native router fixture timed out");
}

function routerFixture({ failFirstPublication = false } = {}) { return `
import handler, { BudgetLedgerObject as RealBudgetLedger } from "./worker/index.ts";
export * from "./worker/index.ts";
export class BudgetLedgerObject extends RealBudgetLedger {
  constructor(state) { super(state); this.fixtureSql = state.storage.sql; }
  async fetch(request) {
    if (new URL(request.url).pathname === "/fixture-unsettled") return Response.json([...this.fixtureSql.exec("SELECT COUNT(*) AS count FROM budget_reservations WHERE settled = 0")][0]);
    return super.fetch(request);
  }
}
const ingress = []; let failPublication = ${failFirstPublication};
export default { ...handler, async fetch(request, env, context) {
  if (new URL(request.url).pathname === "/fixture-ingress") return Response.json(ingress);
  let entry;
  if (request.method === "POST" && new URL(request.url).pathname.endsWith("/responses")) {
    entry = { aborted: false }; ingress.push(entry);
    request.signal.addEventListener("abort", () => { entry.aborted = true; }, { once: true });
  }
  if (failPublication) {
    const authority = env.ACCESS_CONTROL;
    env = { ...env, ACCESS_CONTROL: { idFromName: name => authority.idFromName(name), get: id => ({ fetch(url, init) {
      if (failPublication && new URL(url).pathname === "/http-continuations" && JSON.parse(init.body).action === "register") {
        failPublication = false; return Promise.resolve(new Response("fixture publication outage", { status: 503 }));
      }
      return authority.get(id).fetch(url, init);
    } }) } };
  }
  const response = await handler.fetch(request, env, context);
  if (entry) { entry.status = response.status; entry.requestId = response.headers.get("x-request-id"); }
  return response;
} };
`; }

function upstreamFixture({ toolCall = true, turnState = false } = {}) { return `
const requests = [], aborted = [], canceled = [], expired = [], broken = []; let connections = 0, generated = 0, holdNext = null, breakHeld = false, breakRequested = false;
function respond(body, request, transport, connection = null) {
  const responseId = 'fixture_response_' + (requests.length + 1);
  const warmup = body.generate === false;
  const held = !!holdNext && !warmup, active = holdNext === 'active', breakable = holdNext === 'broken';
  if (held) holdNext = null;
  requests.push({ body, responseId, transport, connection, held, authorized: request.headers.get('authorization') === 'Bearer fixture-upstream-key', lite: request.headers.get('x-openai-internal-codex-responses-lite') === 'true' });
  const output = warmup ? [] : generated++ === 0 && !held && ${toolCall}
    ? [{ id: 'fixture_fc', type: 'function_call', call_id: 'fixture_call', name: 'fixture_echo', arguments: '{"message":"fixture"}' }]
    : [{ id: 'fixture_message_' + generated, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'fixture complete', annotations: [] }] }];
  const result = { id: responseId, object: 'response', status: 'completed', model: body.model, output, service_tier: 'priority', usage: { input_tokens: warmup ? 3 : 14, output_tokens: warmup ? 0 : 8, total_tokens: warmup ? 3 : 22, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } } };
  const events = [{ type: 'response.created', response: { ...result, status: 'in_progress', output: [] } }];
  const delta = held ? { type: 'response.output_text.delta', item_id: output[0].id, output_index: 0, content_index: 0, delta: 'fixture ' } : null;
  if (held) {
    events.push({ type: 'response.output_item.added', output_index: 0, item: { ...output[0], status: 'in_progress', content: [] } });
    events.push({ type: 'response.content_part.added', item_id: output[0].id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } }, delta);
  } else {
    events.push(...output.map((item, output_index) => ({ type: 'response.output_item.done', output_index, item })), { type: 'response.completed', response: result });
  }
  return { events, responseId, heldId: held ? responseId : null, delta, active, breakable };
}
export default { async fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === '/state') return Response.json({ requests, connections, aborted, canceled, expired, broken });
  if (path === '/hold' && request.method === 'POST') { const query = new URL(request.url).searchParams; holdNext = query.has('idle') ? 'idle' : query.has('broken') ? 'broken' : 'active'; return new Response('armed'); }
  if (path === '/break' && request.method === 'POST') { if (!breakHeld) return new Response('no held stream', { status: 409 }); breakRequested = true; return new Response('armed'); }
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
  const { events, responseId, heldId, delta, active, breakable } = respond(await request.json(), request, 'http');
  const encode = event => 'event: ' + event.type + '\\ndata: ' + JSON.stringify(event) + '\\n\\n';
  const prefix = events.map(encode).join('');
  const headers = { 'content-type': 'text/event-stream' };
  if (${turnState}) headers['x-codex-turn-state'] = 'fixture_turn_' + responseId;
  if (!heldId) return new Response(prefix, { headers });
  let sent = false, timer, release, producer;
  const deadline = Date.now() + 30_000;
  const onAbort = () => { aborted.push(heldId); clearTimeout(timer); producer.error(request.signal.reason); release?.(); };
  request.signal.addEventListener('abort', onAbort, { once: true });
  if (breakable) { breakHeld = true; breakRequested = false; }
  return new Response(new ReadableStream({
    start(controller) { producer = controller; },
    pull(controller) {
      if (!sent) { sent = true; controller.enqueue(new TextEncoder().encode(prefix)); return; }
      // Only the upstream request signal proves abort; local stream cancellation
      // and the bounded watchdog must not make a broken client lifecycle pass.
      return new Promise((resolve) => {
        release = resolve;
        timer = setTimeout(function deliver() {
          // A control request changes only a flag. The original request owns
          // stream completion and its pending promise across workerd contexts.
          if (breakable && !breakRequested && Date.now() < deadline) { timer = setTimeout(deliver, 25); return; }
          if (breakable && breakRequested) { breakHeld = false; broken.push(heldId); request.signal.removeEventListener('abort', onAbort); controller.close(); }
          else if (Date.now() >= deadline) { expired.push(heldId); request.signal.removeEventListener('abort', onAbort); controller.close(); }
          else controller.enqueue(new TextEncoder().encode(encode(delta)));
          resolve();
        }, breakable ? 25 : active ? 100 : 30_000);
      });
    },
    cancel() { canceled.push(heldId); clearTimeout(timer); release?.(); },
  }, { highWaterMark: 0 }), { headers });
} };
`; }
