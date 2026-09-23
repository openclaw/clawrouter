import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { startWorkerdFixture } from "../test/helpers/workerd.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const temporary = await mkdtemp(join(tmpdir(), "clawrouter-ws-worker-"));
const secret = "websocket-fixture-secret", key = `clawrouter-live-fixture-${secret}`;
const policy = { enabled: true, generation: "g1", providers: ["openai"], tenantId: "default", monthlyBudgetMicros: 100_000_000, requestCostMicros: null, retainRequestContent: false };
const credential = { enabled: true, secretSha256: createHash("sha256").update(secret).digest("hex"), policyId: "fixture", policyGeneration: "g1" };
let mf;
const sockets = [];
try {
  mf = await startWorkerdFixture(temporary, accountingFixture(), upstreamFixture());
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
  assert.equal(usage.budget.spentMicros, 2_220);
  assert.equal(usage.usage.summary.actualCostMicros, 2_220);
  const budgets = await mf.getDurableObjectNamespace("BUDGET_LEDGER", "router");
  const month = new Date().toISOString().slice(0, 7);
  const providerStatus = await budgets.get(budgets.idFromName("provider:openai")).fetch(`https://budget/status?policy_id=provider/openai&window_key=provider/openai/${month}&limit_micros=100000000`);
  assert.equal((await providerStatus.json()).spentMicros, 2_220);
  assert.equal(new Set(usage.usage.events.map((event) => event.request_id)).size, 3);
  assert.ok(usage.usage.events.every((event) => event.session_id === "fixture-session" && event.content_retained === false));
  let count = 3, spent = 2_220;
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
  // Unknown request tiers stay usable only with both budgets disabled.
  await authorityObject.fetch("https://authority/policies/put", { method: "POST", body: JSON.stringify({ policyId: "fixture", policy: { ...policy, monthlyBudgetMicros: null } }) });
  await authorityObject.fetch("https://authority/connections/put", { method: "POST", body: JSON.stringify({ providerId: "openai", enabled: true, monthlyBudgetMicros: null }) });
  let unpriced = 0;
  for (const [scenario, basis, actual] of [
    ["known_served", "manifest_pricing", 1_080],
    ["unknown_served", "unpriced_usage", 0],
    ["failed_unpriced", "unpriced_usage", 0],
    ["error_before_start", "none", 0],
    ["error_after_start", "unpriced_usage", 0],
    ["disconnect", "unpriced_usage", 0],
  ]) {
    const session = `unmetered-${scenario}`;
    const opened = await dispatch("/v1/responses", { headers: { upgrade: "websocket", "x-clawrouter-session-id": session } });
    assert.equal(opened.status, 101);
    const current = opened.webSocket; current.accept(); sockets.push(current);
    current.send(JSON.stringify({ type: "response.create", model: "openai/gpt-6-astra", service_tier: "future-tier", input: scenario, max_output_tokens: 32 }));
    count++;
    await until(async () => { usage = await (await dispatch("/v1/usage")).json(); return usage.usage.summary.requestCount === count; });
    const event = usage.usage.events.find((event) => event.session_id === session);
    assert.equal(event.cost_basis, basis);
    assert.equal(event.actual_cost_micros, actual);
    assert.equal(event.requested_service_tier, "future-tier");
    if (basis === "unpriced_usage") unpriced++;
    assert.equal(usage.usage.summary.unpricedRequestCount, unpriced);
    current.close(1000, "scenario complete");
  }
  await authorityObject.fetch("https://authority/policies/put", { method: "POST", body: JSON.stringify({ policyId: "fixture", policy }) });
  await authorityObject.fetch("https://authority/connections/put", { method: "POST", body: JSON.stringify({ providerId: "openai", enabled: true, monthlyBudgetMicros: policy.monthlyBudgetMicros }) });
  const ledgerFacts = async () => Promise.all([["default:fixture", "default/fixture"], ["provider:openai", "provider/openai"]].map(async ([name, policyId]) => {
    const stub = budgets.get(budgets.idFromName(name));
    const status = await (await stub.fetch(`https://budget/status?policy_id=${policyId}&window_key=${policyId}/${month}&limit_micros=100000000`)).json();
    const unsettled = await (await stub.fetch("https://budget/fixture-unsettled")).json();
    return { spent: status.spentMicros, unsettled: unsettled.count };
  }));
  for (const [toolCase, toolBody] of [
    ...[{ type: "web_search" }, { type: "file_search" }, { type: "code_interpreter" }, { type: "image_generation" }, { type: "shell", environment: { type: "container_reference", container_id: "cntr_fixture" } }].map(tool => [tool.type, { tools: [tool] }]),
    ["prompt", { prompt: { id: "pmpt_fixture", version: "1" } }],
    ["additional_tools", { tools: [], input: [{ type: "additional_tools", role: "developer", tools: [{ type: "file_search" }] }] }],
  ]) for (const [name, policyLimit, providerLimit, fixed, servedInput] of [
    ["policy", policy.monthlyBudgetMicros, null, null, "known_served"],
    ["provider", null, policy.monthlyBudgetMicros, null, "known_served"],
    ["unmetered", null, null, null, "known_served"],
    ["unmetered-unknown-tier", null, null, null, "unknown_served"],
    ["fixed", policy.monthlyBudgetMicros, policy.monthlyBudgetMicros, 7, "known_served"],
    ["fixed-zero", policy.monthlyBudgetMicros, policy.monthlyBudgetMicros, 0, "known_served"],
  ]) {
    await authorityObject.fetch("https://authority/policies/put", { method: "POST", body: JSON.stringify({ policyId: "fixture", policy: { ...policy, monthlyBudgetMicros: policyLimit, requestCostMicros: fixed } }) });
    await authorityObject.fetch("https://authority/connections/put", { method: "POST", body: JSON.stringify({ providerId: "openai", enabled: true, monthlyBudgetMicros: providerLimit }) });
    const before = await ledgerFacts(), session = `hosted-tool-${toolCase}-${name}`;
    const beforeFrames = (await (await upstream.fetch("https://fixture.example/state")).json()).frames.length;
    const opened = await dispatch("/v1/responses", { headers: { upgrade: "websocket", "x-clawrouter-session-id": session } });
    assert.equal(opened.status, 101);
    const current = opened.webSocket; current.accept(); sockets.push(current);
    const events = []; current.addEventListener("message", ({ data }) => events.push(JSON.parse(data)));
    current.send(JSON.stringify({ type: "response.create", model: "openai/gpt-6-astra", service_tier: "priority", input: servedInput, max_output_tokens: 32, ...toolBody }));
    const denied = fixed == null && (policyLimit != null || providerLimit != null);
    await until(() => events.some(({ type }) => type === (denied ? "error" : "response.completed")));
    if (denied) assert.equal(events.find(({ type }) => type === "error").error.code, "pricing_required");
    const after = (await (await upstream.fetch("https://fixture.example/state")).json()).frames;
    assert.equal(after.length, beforeFrames + (denied ? 0 : 1));
    if (!denied) for (const [key, value] of Object.entries(toolBody)) assert.deepEqual(after.at(-1)[key], value);
    let receipt;
    await until(async () => {
      const matched = (await (await dispatch("/v1/usage")).json()).usage.events.filter(({ session_id }) => session_id === session);
      assert.ok(matched.length <= 1); receipt = matched[0]; return !!receipt;
    });
    assert.equal(receipt.cost_basis, denied ? "none" : fixed != null ? "policy_fixed" : "unpriced_usage");
    assert.equal(receipt.actual_cost_micros, denied ? 0 : fixed ?? 0);
    assert.equal(receipt.status, denied ? "client_error" : "success");
    assert.deepEqual(await ledgerFacts(), before.map(({ spent }) => ({ spent: spent + (fixed ?? 0), unsettled: 0 })));
    current.close(1000, "hosted tool scenario complete");
  }
  await authorityObject.fetch("https://authority/policies/put", { method: "POST", body: JSON.stringify({ policyId: "fixture", policy }) });
  await authorityObject.fetch("https://authority/connections/put", { method: "POST", body: JSON.stringify({ providerId: "openai", enabled: true, monthlyBudgetMicros: policy.monthlyBudgetMicros }) });
  const beforeLanes = await ledgerFacts();
  assert.ok(beforeLanes.every(({ unsettled }) => unsettled === 0));
  // Hold named lanes in the real upstream Worker to prove out-of-order completion and FIFO.
  const openedLanes = await dispatch("/v1/responses", { headers: { upgrade: "websocket", "x-clawrouter-session-id": "named-lanes" } });
  const laneSocket = openedLanes.webSocket; laneSocket.accept(); sockets.push(laneSocket);
  const laneEvents = [];
  laneSocket.addEventListener("message", ({ data }) => laneEvents.push(JSON.parse(data)));
  const laneCreate = (lane, input, extra = {}) => laneSocket.send(JSON.stringify({ type: "response.create", model: "openai/gpt-6-astra", service_tier: "priority", max_output_tokens: 32, stream_id: lane, input, ...extra }));
  const stateFrames = async () => (await (await upstream.fetch("https://fixture.example/state")).json()).frames;
  const firstId = "lane_a1_response";
  laneCreate("a", "lane_a1");
  laneCreate("a", "lane_a2", { previous_response_id: firstId });
  laneCreate("b", "lane_b");
  await until(() => laneEvents.filter(({ type }) => type === "response.completed").length === 3);
  assert.deepEqual(laneEvents.filter(({ type }) => type === "response.completed").map(({ stream_id }) => stream_id), ["b", "a", "a"]);
  const laneFrames = (await stateFrames()).filter(({ input }) => typeof input === "string" && input.startsWith("lane_"));
  assert.deepEqual(laneFrames.map(({ input }) => input), ["lane_a1", "lane_b", "lane_a2"]);
  assert.equal(laneFrames[2].previous_response_id, firstId);
  await until(async () => {
    const receipts = (await (await dispatch("/v1/usage")).json()).usage.events.filter(({ session_id }) => session_id === "named-lanes");
    return receipts.length === 3 && receipts.every(({ actual_cost_micros }) => actual_cost_micros === 1_080);
  });
  assert.deepEqual(await ledgerFacts(), beforeLanes.map(({ spent }) => ({ spent: spent + 3 * 1_080, unsettled: 0 })));
  laneSocket.close(1000, "named lanes complete");

  // A successful HTTP response without durable dispatch confirmation cannot
  // admit a WebSocket operation or retain its charge.
  const beforeDispatchFailure = await ledgerFacts(), beforeDispatchFrames = (await stateFrames()).length;
  const rejectedDispatch = await dispatch("/v1/responses", { headers: { upgrade: "websocket", "x-fixture-accounting-fault": "dispatch", "x-clawrouter-session-id": "dispatch-failure" } });
  assert.equal(rejectedDispatch.status, 101);
  const rejectedSocket = rejectedDispatch.webSocket; rejectedSocket.accept(); sockets.push(rejectedSocket);
  const rejectedEvents = []; let rejectedClosed = false;
  rejectedSocket.addEventListener("message", ({ data }) => rejectedEvents.push(JSON.parse(data)));
  rejectedSocket.addEventListener("close", () => { rejectedClosed = true; });
  rejectedSocket.send(JSON.stringify({ type: "response.create", model: "openai/gpt-6-astra", service_tier: "priority", max_output_tokens: 32, input: "must not dispatch" }));
  await until(() => rejectedClosed && rejectedEvents.some(({ error }) => error?.code === "accounting_unavailable"));
  let rejectedReceipt;
  await until(async () => {
    const receipts = (await (await dispatch("/v1/usage")).json()).usage.events.filter(({ session_id }) => session_id === "dispatch-failure");
    assert.ok(receipts.length <= 1); rejectedReceipt = receipts[0]; return !!rejectedReceipt;
  });
  assert.equal(rejectedReceipt.actual_cost_micros, 0);
  assert.equal(rejectedReceipt.status_code, 503);
  assert.equal((await stateFrames()).length, beforeDispatchFrames);
  assert.deepEqual(await ledgerFacts(), beforeDispatchFailure);

  // HTTP status remains 200 while protocol and delivery outcomes drive receipts.
  for (const scenario of ["late-failed", "cancel-stream", "cancel-after-terminal"]) {
    const before = await ledgerFacts(), session = `sse-${scenario}`;
    const canceled = scenario.startsWith("cancel-");
    const init = {
      method: "POST", headers: { "content-type": "application/json", "x-clawrouter-session-id": session },
      body: JSON.stringify({ model: "gpt-6-astra", input: scenario, max_output_tokens: 32, service_tier: "priority", stream: true }),
    };
    if (canceled) {
      await disconnectHttp(new URL("/v1/native/openai/v1/responses", await mf.ready), { ...init, headers: { ...init.headers, authorization: `Bearer ${key}` } }, scenario === "cancel-stream" ? "response.created" : "response.completed");
      try {
        await until(async () => (await (await upstream.fetch("https://fixture.example/state")).json()).httpAborts[scenario]);
      } catch {
        const state = await (await upstream.fetch("https://fixture.example/state")).json();
        const ingress = await (await dispatch("/fixture-ingress-aborts")).json();
        const receipts = (await (await dispatch("/v1/usage")).json()).usage.events.filter(({ session_id }) => session_id === session);
        throw new Error(`external abort not observed: ${JSON.stringify({ scenario, ingressAborted: ingress[session] ?? false, upstreamAborted: state.httpAborts[scenario] ?? false, upstreamEof: state.httpEofs[scenario] ?? false, receipts, ledgers: await ledgerFacts() })}`);
      }
      assert.equal((await (await dispatch("/fixture-ingress-aborts")).json())[session], true);
      assert.equal((await (await upstream.fetch("https://fixture.example/state")).json()).httpEofs[scenario], undefined);
    } else {
      const response = await dispatch("/v1/native/openai/v1/responses", init);
      assert.equal(response.status, 200);
      const body = await response.text();
      const prefix = 'data: {"type":"response.created"}\n\n';
      const delta = `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "x".repeat(20_000) })}\n\n`;
      const last = `data: ${JSON.stringify({ type: "response.failed", response: { status: "failed", service_tier: "priority", usage: { input_tokens: 14, output_tokens: 8, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } } } })}\n\n`;
      assert.equal(body, prefix + delta.repeat(110) + last);
    }
    let receipt;
    await until(async () => {
      const receipts = (await (await dispatch("/v1/usage")).json()).usage.events.filter(({ session_id }) => session_id === session);
      assert.ok(receipts.length <= 1); receipt = receipts[0]; return !!receipt;
    });
    assert.equal(receipt.status_code, 200);
    assert.equal(receipt.status, canceled ? "client_error" : "provider_error");
    assert.equal(receipt.cost_basis, scenario === "cancel-stream" ? "manifest_reservation" : "manifest_pricing");
    const cost = scenario === "cancel-stream" ? receipt.reserved_cost_micros : 1_080;
    assert.equal(receipt.actual_cost_micros, cost);
    assert.deepEqual(await ledgerFacts(), before.map(({ spent }) => ({ spent: spent + cost, unsettled: 0 })));
  }

  // Faults belong to the fixture wrapper, never a production configuration surface.
  for (const phase of ["terminal", "preflight", "rollback"]) {
    await authorityObject.fetch("https://authority/policies/put", { method: "POST", body: JSON.stringify({ policyId: "fixture", policy: { ...policy, retainRequestContent: phase === "preflight" } }) });
    for (const fault of ["recovered", "settlement", "usage_recovered", "usage", "usage_throw"]) {
      const recovered = fault === "recovered" || fault === "usage_recovered";
      const session = `accounting-${phase}-${fault}`;
      const before = (await stateFrames()).length;
      const opened = await dispatch("/v1/responses", { headers: { upgrade: "websocket", "x-fixture-accounting-fault": fault, "x-fixture-accounting-phase": phase, "x-clawrouter-session-id": session } });
      const current = opened.webSocket; current.accept(); sockets.push(current);
      const events = []; let closed = false;
      current.addEventListener("message", ({ data }) => events.push(JSON.parse(data)));
      current.addEventListener("close", () => { closed = true; });
      for (let index = 0; index < 2; index++) current.send(JSON.stringify({ type: "response.create", model: "openai/gpt-6-astra", input: "accounting fixture", max_output_tokens: 16, service_tier: "priority" }));
      if (recovered) {
        await until(() => events.filter(({ type }) => type === "response.completed" || type === "error").length === 2);
        await until(async () => {
          const receipts = (await (await dispatch("/v1/usage")).json()).usage.events.filter(({ session_id }) => session_id === session);
          return receipts.length === 2 && new Set(receipts.map(({ id }) => id)).size === 2;
        });
        assert.equal(closed, false);
        assert.ok(!events.some(({ error }) => error?.code === "accounting_unavailable"));
      } else {
        await until(() => closed);
        assert.ok(events.some(({ error }) => error?.code === "accounting_unavailable"));
      }
      assert.equal((await stateFrames()).length - before, phase !== "terminal" ? 0 : recovered ? 2 : 1);
      if (phase === "rollback") {
        const trace = await (await dispatch("/fixture-accounting")).json();
        assert.deepEqual(trace.slice(0, 4).map(({ kind }) => kind), ["policy_reserved", "provider_denied", "rollback_attempted", "rollback_queued"]);
      }
      current.close(1000, "accounting fixture complete");
    }
  }
  await authorityObject.fetch("https://authority/policies/put", { method: "POST", body: JSON.stringify({ policyId: "fixture", policy }) });
  // Publication recovery and exhaustion must both preserve the consumed HTTP response.
  for (const fault of ["usage_recovered", "usage", "usage_throw"]) {
    const session = `http-${fault}`;
    const response = await dispatch("/v1/responses", {
      method: "POST", headers: { "content-type": "application/json", "x-fixture-accounting-fault": fault, "x-clawrouter-session-id": session },
      body: JSON.stringify({ model: "openai/gpt-6-astra", input: "publication fixture", max_output_tokens: 16, service_tier: "priority" }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { id: "http-fixture", object: "response", status: "completed", output: [], service_tier: "priority", usage: { input_tokens: 14, output_tokens: 8, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } } });
    await until(async () => (await (await dispatch("/fixture-accounting")).json()).some(({ kind }) => kind === "usage_ingest"));
    if (fault === "usage_recovered") await until(async () => (await (await dispatch("/v1/usage")).json()).usage.events.some(({ session_id }) => session_id === session));
  }
  // Mutate only fixture authority: queued/next creates must see revocation.
  const owner = { email: "fixture@example.com", record: { enabled: false } };
  assert.equal((await authorityObject.fetch("https://authority/users/put", { method: "POST", body: JSON.stringify(owner) })).status, 200);
  assert.equal((await authorityObject.fetch("https://authority/credentials/mutate", { method: "POST", body: JSON.stringify({ credentialId: "fixture", operation: "put", scope: "admin", actor: { auth: "admin_token", role: "admin", email: "token-admin" }, credential: { ...credential, principalId: owner.email } }) })).status, 200);
  const beforeOwnerDisable = (await (await upstream.fetch("https://fixture.example/state")).json()).frames.length;
  const ownerTerminal = messages.filter((event) => ["response.completed", "response.incomplete", "response.failed", "error"].includes(event.type)).length + 1;
  create({ input: "disabled owner must not reach upstream" });
  assert.equal((await terminal(ownerTerminal)).error.code, "principal_disabled");
  assert.equal((await (await upstream.fetch("https://fixture.example/state")).json()).frames.length, beforeOwnerDisable);
  assert.equal((await dispatch("/v1/responses", { headers: { upgrade: "websocket" } })).status, 403);
  const revoke = await authorityObject.fetch("https://authority/credentials/mutate", { method: "POST", body: JSON.stringify({ credentialId: "fixture", operation: "revoke", scope: "admin", actor: { auth: "admin_token", role: "admin", email: "token-admin" } }) });
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

// Reset an actual ingress TCP socket after observing bytes from the Worker.
// JS body.cancel() alone cannot prove workerd's external disconnect lifecycle.
async function disconnectHttp(url, init, marker) {
  await new Promise((resolve, reject) => {
    let destroyed = false, text = "";
    const request = httpRequest(url, { method: init.method, headers: init.headers }, (response) => {
      assert.equal(response.statusCode, 200);
      response.on("data", (chunk) => {
        text += chunk.toString();
        if (!destroyed && text.includes(marker)) { destroyed = true; response.socket.resetAndDestroy(); }
      });
      response.on("close", () => { clearTimeout(timer); destroyed ? resolve() : reject(new Error("fixture stream ended before socket destruction")); });
      response.on("error", (error) => { if (!destroyed) reject(error); });
    });
    const timer = setTimeout(() => { request.destroy(); reject(new Error("fixture HTTP disconnect timed out")); }, 10_000);
    request.on("error", (error) => { if (!destroyed) { clearTimeout(timer); reject(error); } });
    request.end(init.body);
  });
}

function upstreamFixture() { return `
const frames = [], httpAborts = {}, httpEofs = {}; let headerMatch = false;
export default { async fetch(request) {
  if (new URL(request.url).pathname === '/state') return Response.json({ frames, headerMatch, httpAborts, httpEofs });
  if (request.url === 'https://api.openai.com/v1/responses' && request.method === 'POST') {
    const body = await request.json();
    const usage = { input_tokens: 14, output_tokens: 8, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } };
    if (body.input === 'late-failed' || body.input.startsWith('cancel-')) {
      let index = 0, timer, release, producer;
      const aborted = () => { httpAborts[body.input] = true; clearTimeout(timer); producer.error(request.signal.reason); release?.(); };
      request.signal.addEventListener('abort', aborted, { once: true });
      return new Response(new ReadableStream({ start(controller) { producer = controller; }, pull(controller) {
        if (index++ === 0) {
          const terminal = body.input === 'cancel-after-terminal' ? 'data: ' + JSON.stringify({ type: 'response.completed', response: { status: 'completed', service_tier: 'priority', usage } }) + '\\n\\n' : '';
          controller.enqueue(new TextEncoder().encode('data: {"type":"response.created"}\\n\\n' + terminal));
        }
        // Keep a bounded live response; only the native request signal records abort.
        else if (body.input.startsWith('cancel-')) return new Promise((resolve) => {
          release = resolve;
          timer = setTimeout(() => {
            httpEofs[body.input] = true; request.signal.removeEventListener('abort', aborted);
            controller.close();
            resolve();
          }, 30_000);
        });
        else if (index <= 111) controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify({ type: 'response.output_text.delta', delta: 'x'.repeat(20000) }) + '\\n\\n'));
        else if (index === 112) controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify({ type: 'response.failed', response: { status: 'failed', service_tier: 'priority', usage } }) + '\\n\\n'));
        else { request.signal.removeEventListener('abort', aborted); controller.close(); }
      }, cancel() { clearTimeout(timer); release?.(); } }, { highWaterMark: 0 }), { headers: { 'content-type': 'text/event-stream' } });
    }
    return Response.json({ id: 'http-fixture', object: 'response', status: 'completed', output: [], service_tier: 'priority', usage });
  }
  if (request.url !== 'https://api.openai.com/v1/responses' || request.headers.get('upgrade') !== 'websocket') return new Response('unexpected upstream route', { status: 400 });
  headerMatch = request.headers.get('authorization') === 'Bearer fixture-upstream-key' && request.headers.get('session-id') === 'fixture-session' && request.headers.get('x-openai-internal-codex-responses-lite') === 'true';
  const pair = new WebSocketPair(); pair[1].accept();
  const held = new Map();
  pair[1].addEventListener('message', ({ data }) => {
    const frame = JSON.parse(data); frames.push(frame);
    const id = typeof frame.input === 'string' && frame.input.startsWith('lane_') ? frame.input + '_response' : 'response_' + frames.length;
    const output = frames.length === 2 ? [{ type: 'function_call', id: 'fc_fixture', call_id: 'call_fixture', name: 'fixture_tool', arguments: '{}' }] : frames.length === 3 ? [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'fixture complete' }] }] : [];
    const usage = { input_tokens: frame.generate === false ? 3 : 14, output_tokens: frame.generate === false ? 0 : 8, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } };
    if (typeof frame.input === 'string' && frame.input.startsWith('lane_')) {
      pair[1].send(JSON.stringify({ type: 'response.created', stream_id: frame.stream_id, response: { id, status: 'in_progress' } }));
      const complete = () => pair[1].send(JSON.stringify({ type: 'response.completed', stream_id: frame.stream_id, response: { id, status: 'completed', output, usage, service_tier: 'priority' } }));
      if (frame.input === 'lane_a1') held.set(frame.input, complete);
      else { complete(); if (frame.input === 'lane_b') { held.get('lane_a1')(); held.delete('lane_a1'); } }
      return;
    }
    if (frame.input === 'error_before_start') { pair[1].send(JSON.stringify({ type: 'error', status: 429, error: { code: 'rate_limit_exceeded', message: 'fixture' } })); return; }
    pair[1].send(JSON.stringify({ type: 'response.created', response: { id, status: 'in_progress' } }));
    if (frame.input === 'disconnect') { pair[1].close(1011, 'fixture disconnect'); return; }
    if (frame.input === 'error_after_start') { pair[1].send(JSON.stringify({ type: 'error', status: 500, response_id: id, error: { code: 'server_error', message: 'fixture' } })); return; }
    if (frame.input === 'failed_unpriced') { pair[1].send(JSON.stringify({ type: 'response.failed', response: { id, status: 'failed', usage, service_tier: 'future-tier' } })); return; }
    if (frame.input === 'incomplete' || frame.input === 'failed') { pair[1].send(JSON.stringify({ type: 'response.' + frame.input, response: { id, status: frame.input, usage, service_tier: 'priority' } })); return; }
    pair[1].send(JSON.stringify({ type: 'codex.response.metadata', headers: { 'x-models-etag': 'fixture-etag' } }));
    pair[1].send(JSON.stringify({ type: 'response.completed', response: { id, status: 'completed', output, usage, service_tier: frame.input === 'unknown_served' ? 'future-tier' : 'priority' } }));
  });
  return new Response(null, { status: 101, webSocket: pair[0] });
} };
`;
}

function accountingFixture() { return `
import handler, { BudgetLedgerObject as RealBudgetLedger } from "./worker/index.ts";
export * from "./worker/index.ts";
export class BudgetLedgerObject extends RealBudgetLedger {
  constructor(state) { super(state); this.fixtureSql = state.storage.sql; }
  async fetch(request) {
    if (new URL(request.url).pathname === "/fixture-unsettled") return Response.json([...this.fixtureSql.exec("SELECT COUNT(*) AS count FROM budget_reservations WHERE settled = 0")][0]);
    return super.fetch(request);
  }
}
let trace = [];
const ingressAborts = {};
export default { ...handler, async fetch(request, env, context) {
  if (new URL(request.url).pathname === "/fixture-accounting") return Response.json(trace);
  if (new URL(request.url).pathname === "/fixture-ingress-aborts") return Response.json(ingressAborts);
  const session = request.headers.get("x-clawrouter-session-id");
  if (session?.startsWith("sse-")) request.signal.addEventListener("abort", () => { ingressAborts[session] = true; }, { once: true });
  const fault = request.headers.get("x-fixture-accounting-fault");
  if (fault) {
    const ledger = env.BUDGET_LEDGER, queue = env.USAGE_QUEUE, usage = env.USAGE_LEDGER;
    const rollback = request.headers.get("x-fixture-accounting-phase") === "rollback";
    trace = [];
    env = { ...env,
      BUDGET_LEDGER: { idFromName: (name) => ledger.idFromName(name), get: (id) => {
        const stub = ledger.get(id);
        return { async fetch(url, init) {
          if (fault === "dispatch" && new URL(url).pathname === "/dispatch") return Response.json({ dispatched: false });
          if (fault !== "dispatch" && new URL(url).pathname === "/settle") { trace.push({ kind: "rollback_attempted" }); return new Response("fixture ledger outage", { status: 503 }); }
          if (rollback && new URL(url).pathname === "/reserve") {
            if (JSON.parse(init.body).policyId === "provider/openai") { trace.push({ kind: "provider_denied" }); return Response.json({ allowed: false, chargedMicros: 0 }); }
            const result = await stub.fetch(url, init);
            if ((await result.clone().json()).allowed) trace.push({ kind: "policy_reserved" });
            return result;
          }
          return stub.fetch(url, init);
        } };
      } },
      USAGE_LEDGER: { idFromName: (name) => usage.idFromName(name), get: (id) => ({ async fetch(url, init) {
        if (new URL(url).pathname === "/ingest") {
          trace.push({ kind: "usage_ingest" });
          if (fault === "usage_throw") throw new Error("fixture ingest outage");
          if (fault === "usage") return new Response("fixture ingest outage", { status: 503 });
        }
        return usage.get(id).fetch(url, init);
      } }) },
      USAGE_QUEUE: { send(message) {
        if (message.kind === "budget_settlement") trace.push({ kind: "rollback_queued" });
        if ((fault === "settlement" && message.kind === "budget_settlement") || (fault.startsWith("usage") && message.type === "clawrouter.usage.v1")) return Promise.reject(new Error("fixture queue outage"));
        return queue.send(message);
      } },
    };
  }
  return handler.fetch(request, env, context);
} };
`; }
