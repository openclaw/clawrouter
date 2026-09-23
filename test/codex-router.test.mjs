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

for (const recovery of ["HTTP fallback", "WebSocket reconnect"]) test(`native Codex metadata survives ${recovery} on its original pooled account`, { skip: !binary, timeout: 90_000 }, async t => {
  const forceHttp = recovery === "HTTP fallback";
  const { startWorkerdFixture } = await import("./helpers/workerd.mjs");
  const home = await mkdtemp(join(tmpdir(), "clawrouter-native-fallback-"));
  let mf, client;
  try {
    mf = await startWorkerdFixture(home, routerFixture(), fallbackUpstreamFixture());
    const kv = await mf.getKVNamespace("POLICY_KV", "router"), origin = await mf.ready;
    const policy = { enabled: true, generation: "g1", providers: ["openai"], tenantId: "default", monthlyBudgetMicros: limit, retainRequestContent: false, grantRouting: { strategy: "round_robin", stickiness: "none", failover: true } };
    await kv.put("policies/fixture", JSON.stringify(policy));
    await kv.put("credentials/fixture", JSON.stringify({ enabled: true, secretSha256: createHash("sha256").update(secret).digest("hex"), policyId: "fixture", policyGeneration: "g1" }));
    await kv.put("connections/openai", JSON.stringify({ providerId: "openai", enabled: true, monthlyBudgetMicros: limit }));
    const grants = await mf.getDurableObjectNamespace("GRANT_CREDENTIALS", "router");
    const grantCall = async (name, action, credential = `fixture-account-${name}`) => {
      const grantKey = `oauth/fixture/account-${name}`;
      const response = await grants.get(grants.idFromName(grantKey)).fetch(`https://credential/${action}`, { method: "POST", body: JSON.stringify({ key: grantKey, grant: { provider: "openai", kind: "api_key", enabled: true, credential }, preserveUnspecifiedSecrets: false }) });
      assert.equal(response.status, 200, await response.clone().text());
    };
    await grantCall("a", "put"); await grantCall("b", "put");
    const dispatch = (path, init = {}) => fetch(new URL(path, origin), { ...init, headers: { authorization: `Bearer ${key}`, ...init.headers }, signal: AbortSignal.timeout(10_000) });
    const catalog = await (await dispatch("/v1/catalog")).json();
    const env = { PATH: process.env.PATH, HOME: home, CODEX_HOME: home, RUST_LOG: "warn", CLAWROUTER_API_KEY: key };
    const bundled = JSON.parse(execFileSync(producer, ["debug", "models", "--bundled"], { env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 20_000, stdio: ["ignore", "pipe", "pipe"] }));
    const exported = buildCodexCatalog(catalog, bundled, "openai");
    await writeFile(join(home, "models.json"), JSON.stringify(exported.catalog));
    await writeFile(join(home, "config.toml"), `model = "${model}"
model_provider = "fixture"
model_catalog_json = ${JSON.stringify(join(home, "models.json"))}
service_tier = "priority"
web_search = "disabled"
approval_policy = "never"
sandbox_mode = "read-only"
cli_auth_credentials_store = "file"
[model_providers.fixture]
name = "Fixture"
base_url = "${new URL(exported.nativeBasePath, origin)}"
env_key = "CLAWROUTER_API_KEY"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = true
${forceHttp ? "request_max_retries = 0\nstream_max_retries = 0\nstream_idle_timeout_ms = 10000\n" : ""}
`);
    client = nativeCodexClient(t, binary, home, env);
    await client.rpc("initialize", { clientInfo: { name: "clawrouter_fallback_fixture", version: "1.0.0" }, capabilities: { experimentalApi: true } });
    client.child.stdin.write('{"method":"initialized"}\n');
    const thread = await client.rpc("thread/start", { model, modelProvider: "fixture", cwd: home, ephemeral: true, approvalPolicy: "never", sandbox: "read-only" });
    const turn = await client.rpc("turn/start", { threadId: thread.thread.id, input: [{ type: "text", text: "Return fixture complete." }], serviceTier: "priority" });
    const upstream = await mf.getWorker("upstream");
    const state = () => upstream.fetch("https://fixture.example/state").then(response => response.json());
    await until(() => client.notifications.some(({ method, params }) => method === "item/agentMessage/delta" && params.turnId === turn.turn.id));
    const started = (await state()).requests.find(({ held }) => held);
    assert.equal(started.account, "a");
    const post = (body, headers = {}) => dispatch("/v1/responses", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ model: "openai/gpt-6-astra", input: "fixture", max_output_tokens: 32, service_tier: "priority", ...body }) });
    assert.equal((await upstream.fetch("https://fixture.example/disconnect", { method: "POST" })).status, 200);
    let completed;
    await until(() => {
      assert.deepEqual(client.errors, []);
      completed = client.notifications.find(({ method, params }) => method === "turn/completed" && params.turn.id === turn.turn.id);
      return !!completed;
    });
    assert.equal(completed.params.turn.status, "completed", completed.params.turn.error?.message);
    const recovered = await state();
    assert.equal(recovered.disconnected, true); assert.equal(recovered.expired, false, "the watchdog must not stand in for the controlled disconnect");
    const retries = recovered.requests.filter(({ held, body }) => !held && body.generate !== false);
    assert.equal(retries.length, 1, "one native retry, no router replay");
    assert.equal(retries[0].transport, forceHttp ? "http" : "websocket");
    assert.equal(retries[0].account, "a");
    assert.equal(recovered.connections, forceHttp ? 1 : 2);
    if (forceHttp) {
      assert.equal(retries[0].turn, "fixture-turn-from-websocket");
      assert.match(JSON.stringify(client.notifications) + client.stderr(), /Falling back from WebSockets to HTTPS/);
    } else {
      assert.equal(retries[0].turn, null, "Codex does not send turn state in the upgrade header");
      assert.equal(retries[0].body.previous_response_id, undefined, "reconnect clears the prior response selector");
      assert.equal(retries[0].body.client_metadata["x-codex-turn-state"], "fixture-turn-from-websocket");
      assert.match(JSON.stringify(retries[0].body.input), /Return fixture complete/);
      assert.doesNotMatch(JSON.stringify(client.notifications) + client.stderr(), /Falling back from WebSockets to HTTPS/);
    }
    // Pinned creates leave the round-robin cursor at A. Do not consume the next
    // ordinary selection before retry: without its identity, retry would use B.
    const ordinary = await post({ generate: false }); assert.equal(ordinary.status, 200); await ordinary.text();
    const after = await state();
    assert.equal(after.requests.at(-1).account, "b");
    assert.ok(after.requests.every(({ account }) => account === "a" || account === "b"));
    let usage;
    await until(async () => { usage = await (await dispatch("/v1/usage")).json(); return usage.usage.events.length === after.requests.length; });
    const failed = usage.usage.events.filter(({ status }) => status !== "success");
    assert.equal(failed.length, 1); assert.equal(failed[0].status, "provider_error");
    assert.equal(failed[0].cost_basis, "manifest_reservation");
    assert.ok(failed[0].actual_cost_micros > 0); assert.equal(failed[0].actual_cost_micros, failed[0].reserved_cost_micros);
    let expected = after.requests.reduce((sum, request) => sum + (request.held ? failed[0].actual_cost_micros : request.body.generate === false ? 60 : 1080), 0);
    assert.equal(usage.budget.spentMicros, expected); assert.equal(usage.usage.summary.actualCostMicros, expected);
    assert.equal(new Set(usage.usage.events.map(({ request_id }) => request_id)).size, after.requests.length);
    const budgets = await mf.getDurableObjectNamespace("BUDGET_LEDGER", "router"), month = new Date().toISOString().slice(0, 7);
    const assertLedgers = async () => {
      const totals = [];
      for (const [name, policyId] of [["default:fixture", "default/fixture"], ["provider:openai", "provider/openai"]]) {
        const stub = budgets.get(budgets.idFromName(name));
        let status, rows;
        await until(async () => {
          status = await (await stub.fetch(`https://budget/status?policy_id=${policyId}&window_key=${policyId}/${month}&limit_micros=${limit}`)).json();
          rows = await (await stub.fetch("https://budget/fixture-unsettled")).json();
          return status.spentMicros === expected && rows.count === 0;
        });
        totals.push(rows.total);
      }
      return totals;
    };
    await assertLedgers();
    for (const action of ["replace", "revoke"]) {
      await grantCall("a", action === "replace" ? "put" : "revoke", "fixture-replaced-account-a");
      for (const [body, headers] of [[{}, { "x-codex-turn-state": "fixture-turn-from-websocket" }], [{ previous_response_id: started.responseId }, {}]]) {
        const rejected = await post(body, headers);
        assert.equal(rejected.status, 409); assert.equal((await rejected.json()).error.code, "continuation_restart_required");
      }
      assert.equal((await state()).requests.length, after.requests.length);
      await assertLedgers();
    }
    // A live socket keeps its upstream route, not the authorization scope of
    // its first create. Rebinding the same key must isolate subsequent IDs.
    const opened = await mf.dispatchFetch("https://router.example/v1/responses", { headers: { authorization: `Bearer ${key}`, upgrade: "websocket" } });
    assert.equal(opened.status, 101);
    const socket = opened.webSocket; socket.accept();
    t.after(() => { try { socket.close(); } catch {} });
    const messages = [];
    socket.addEventListener("message", ({ data }) => messages.push(JSON.parse(data)));
    const warmup = body => socket.send(JSON.stringify({ type: "response.create", model: "openai/gpt-6-astra", service_tier: "priority", generate: false, input: "fixture scope", ...body }));
    warmup({});
    await until(() => messages.some(({ type }) => type === "response.completed"));
    const oldId = messages.find(({ type }) => type === "response.completed").response.id;
    const oldTurn = messages.find(({ type }) => type === "response.metadata").headers["x-codex-turn-state"][0];
    expected += 60;
    const beforeRejected = await assertLedgers(), beforeRejectedEgress = (await state()).requests.length;
    const conflicting = await mf.dispatchFetch("https://router.example/v1/responses", { headers: { authorization: `Bearer ${key}`, upgrade: "websocket", "x-codex-turn-state": oldTurn } });
    assert.equal(conflicting.status, 101);
    const conflictingSocket = conflicting.webSocket; conflictingSocket.accept();
    const conflicts = [];
    conflictingSocket.addEventListener("message", ({ data }) => conflicts.push(JSON.parse(data)));
    conflictingSocket.send(JSON.stringify({ type: "response.create", model: "openai/gpt-6-astra", input: "full input", client_metadata: { "x-codex-turn-state": "different-turn" } }));
    await until(() => conflicts.some(({ type }) => type === "error"));
    assert.equal(conflicts[0].error.code, "continuation_restart_required");
    conflictingSocket.close();
    assert.equal((await state()).requests.length, beforeRejectedEgress);
    assert.deepEqual(await assertLedgers(), beforeRejected, "conflicting carriers never reserve either ledger");
    const authority = await mf.getDurableObjectNamespace("ACCESS_CONTROL", "router");
    const rebound = await authority.get(authority.idFromName("policy-bindings")).fetch("https://authority/credentials/mutate", { method: "POST", body: JSON.stringify({ operation: "put", credentialId: "fixture", scope: "admin", actor: { auth: "admin_token", role: "admin", email: "token-admin" }, credential: { enabled: true, secretSha256: createHash("sha256").update(secret).digest("hex"), policyId: "fixture", principalId: "other@example.com" } }) });
    assert.equal(rebound.status, 200); assert.equal((await rebound.json()).outcome, "updated");
    const beforeRebound = (await state()).requests.length;
    for (const body of [{ previous_response_id: oldId }, { client_metadata: { "x-codex-turn-state": oldTurn } }]) {
      const errors = messages.filter(({ type }) => type === "error").length;
      warmup(body);
      await until(() => messages.filter(({ type }) => type === "error").length > errors);
      assert.equal(messages.at(-1).error.code, "continuation_restart_required");
      assert.equal((await state()).requests.length, beforeRebound);
      assert.deepEqual(await assertLedgers(), beforeRejected, "rebound-scope continuations never reserve either ledger");
    }
    warmup({});
    await until(() => messages.filter(({ type }) => type === "response.completed").length === 2);
    const newId = messages.filter(({ type }) => type === "response.completed")[1].response.id;
    const continued = await post({ previous_response_id: newId });
    assert.equal(continued.status, 200); await continued.text();
    const rejectedOld = await post({ previous_response_id: oldId });
    assert.equal(rejectedOld.status, 409); await rejectedOld.text();
    expected += 1140;
    await assertLedgers();
    socket.close();
  } finally {
    await client?.close(); await mf?.dispose(); await rm(home, { recursive: true, force: true });
  }
});

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
    assert.deepEqual(await (await fetch(new URL("/fixture-ingress", origin))).json(), [{ aborted: true }]);
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
    if (new URL(request.url).pathname === "/fixture-unsettled") return Response.json([...this.fixtureSql.exec("SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN settled = 0 THEN 1 ELSE 0 END), 0) AS count FROM budget_reservations")][0]);
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

function fallbackUpstreamFixture() { return `
const requests = []; let connections = 0, disconnectRequested = false, disconnected = false, expired = false;
function respond(body, request, transport) {
  const responseId = 'fallback_response_' + (requests.length + 1);
  const warmup = body.generate === false, held = transport === 'websocket' && !warmup && !requests.some(request => request.held);
  const authorization = request.headers.get('authorization');
  const account = authorization === 'Bearer fixture-account-a' ? 'a' : authorization === 'Bearer fixture-account-b' ? 'b' : 'unexpected';
  requests.push({ body, responseId, transport, account, held, turn: request.headers.get('x-codex-turn-state') });
  const item = { id: 'fallback_message', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'fixture complete', annotations: [] }] };
  const result = { id: responseId, object: 'response', status: 'completed', model: body.model, output: warmup ? [] : [item], service_tier: 'priority', usage: { input_tokens: warmup ? 3 : 14, output_tokens: warmup ? 0 : 8, total_tokens: warmup ? 3 : 22 } };
  const events = [];
  if (held || body.input === 'fixture scope') events.push({ type: 'response.metadata', response_id: responseId, headers: { 'x-codex-turn-state': [held ? 'fixture-turn-from-websocket' : 'turn_' + responseId] } });
  events.push({ type: 'response.created', response: { ...result, status: 'in_progress', output: [], usage: null } });
  if (held) events.push(
    { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
    { type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
    { type: 'response.output_text.delta', response_id: responseId, item_id: item.id, output_index: 0, content_index: 0, delta: 'fixture ' }
  );
  else events.push(...result.output.map((item, output_index) => ({ type: 'response.output_item.done', output_index, item })), { type: 'response.completed', response: result });
  return { events, held };
}
export default { async fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === '/state') return Response.json({ requests, connections, disconnected, expired });
  if (path === '/disconnect' && request.method === 'POST') { disconnectRequested = true; return new Response('disconnect requested'); }
  if (request.url !== 'https://api.openai.com/v1/responses') return new Response('unexpected upstream route', { status: 400 });
  if (request.headers.get('upgrade') === 'websocket') {
    connections++;
    const pair = new WebSocketPair(); pair[1].accept();
    let timer;
    const close = () => { clearTimeout(timer); pair[1].close(); };
    pair[1].addEventListener('close', close); pair[1].addEventListener('error', close);
    pair[1].addEventListener('message', ({ data }) => {
      const body = JSON.parse(data);
      const { events, held } = respond(body, request, 'websocket');
      for (const event of events) pair[1].send(JSON.stringify(event));
      if (held) {
        // The control request shares only a flag. Socket I/O and its timer
        // stay in this message's Worker context until close or watchdog expiry.
        const deadline = Date.now() + 30_000;
        const poll = () => {
          if (disconnectRequested || Date.now() >= deadline) {
            disconnected = disconnectRequested; expired = !disconnectRequested;
            pair[1].close(1011, 'fixture disconnect');
          } else timer = setTimeout(poll, 10);
        };
        timer = setTimeout(poll, 10);
      }
    });
    return new Response(null, { status: 101, headers: { 'x-codex-turn-state': 'fixture-turn-only-in-upgrade' }, webSocket: pair[0] });
  }
  if (request.method !== 'POST') return new Response('unexpected upstream method', { status: 405 });
  const { events } = respond(await request.json(), request, 'http');
  return new Response(events.map(event => 'event: ' + event.type + '\\ndata: ' + JSON.stringify(event) + '\\n\\n').join(''), { headers: { 'content-type': 'text/event-stream' } });
} };
`; }

function upstreamFixture() { return `
const requests = [], aborted = [], canceled = [], expired = []; let connections = 0, generated = 0, holdNext = null;
function respond(body, request, transport, connection = null) {
  const responseId = 'fixture_response_' + (requests.length + 1);
  const warmup = body.generate === false;
  const held = !!holdNext && !warmup, active = holdNext === 'active';
  if (held) holdNext = null;
  requests.push({ body, responseId, transport, connection, held, authorized: request.headers.get('authorization') === 'Bearer fixture-upstream-key', lite: request.headers.get('x-openai-internal-codex-responses-lite') === 'true' });
  const output = warmup ? [] : generated++ === 0 && !held
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
  return { events, heldId: held ? responseId : null, delta, active };
}
export default { async fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === '/state') return Response.json({ requests, connections, aborted, canceled, expired });
  if (path === '/hold' && request.method === 'POST') { holdNext = new URL(request.url).searchParams.has('idle') ? 'idle' : 'active'; return new Response('armed'); }
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
  const { events, heldId, delta, active } = respond(await request.json(), request, 'http');
  const encode = event => 'event: ' + event.type + '\\ndata: ' + JSON.stringify(event) + '\\n\\n';
  const prefix = events.map(encode).join('');
  const headers = { 'content-type': 'text/event-stream' };
  if (!heldId) return new Response(prefix, { headers });
  let sent = false, timer, release, producer;
  const deadline = Date.now() + 30_000;
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
        timer = setTimeout(() => {
          if (Date.now() >= deadline) { expired.push(heldId); request.signal.removeEventListener('abort', onAbort); controller.close(); }
          else controller.enqueue(new TextEncoder().encode(encode(delta)));
          resolve();
        }, active ? 100 : 30_000);
      });
    },
    cancel() { canceled.push(heldId); clearTimeout(timer); release?.(); },
  }, { highWaterMark: 0 }), { headers });
} };
`; }
