import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import snapshot from "../worker/generated/provider-snapshot.json" with { type: "json" };
import { runOpenClawConsumer } from "./helpers/openclaw-consumer.mjs";

const source = process.env.CLAWROUTER_OPENCLAW_CHECKOUT;
const sourceHead = "d8bb939408aa4d2be7df0161748edb52ebf3b1fb";
const providerId = "anthropic-vertex", upstreamModel = "claude-sonnet-4-6", modelId = `${providerId}/${upstreamModel}`;
const charged = ["vertex_stream", "vertex_simple", "vertex_global", "vertex_europe", "vertex_asia", "vertex_thinking", "vertex_tools", "vertex_error", "vertex_cancel"];
const denied = ["vertex_unpriced", "vertex_foreign", "vertex_unbound", "vertex_location", "vertex_revoked"];
const ids = [...charged, ...denied];
const locationFor = id => ({ vertex_global: "global", vertex_europe: "europe-west1", vertex_asia: "asia-southeast1", vertex_location: "us-central1" }[id] ?? "us-east5");
const projectFor = id => "fixture-" + id.replaceAll("_", "-");
const grant = id => ({ provider: providerId, kind: "oauth", enabled: true, tokenType: "Bearer", accessToken: "fixture-vertex-" + id,
  expiresAt: new Date(Date.now() + 3600000).toISOString(), ...(id === "vertex_unbound" ? {} : { vertexAnthropicAuthorization: {
    version: "clawrouter.vertex-anthropic.v1", source: "access_token", project: projectFor(id), location: locationFor(id),
  } }) });
const headers = id => ({ authorization: `Bearer clawrouter-live-${id}-fixture-secret`, "content-type": "application/json" });

async function setup(temporary) {
  const { startWorkerdFixture } = await import("./helpers/workerd.mjs");
  const mf = await startWorkerdFixture(temporary, routerFixture(), upstreamFixture());
  try {
    const kv = await mf.getKVNamespace("POLICY_KV", "router");
    for (const id of ids) {
      await kv.put(`policies/${id}`, JSON.stringify({ enabled: true, generation: "fixture", providers: [id === "vertex_foreign" ? "anthropic" : providerId],
        models: [modelId], tenantId: "fixture", monthlyBudgetMicros: 100, requestCostMicros: id === "vertex_unpriced" ? null : 7,
        budgetMode: "reserve", retainRequestContent: false, grantRouting: { eligibleGrants: { [providerId]: ["vertex"] }, environmentFallback: false } }));
      await kv.put(`credentials/${id}`, JSON.stringify({ enabled: true, secretSha256: createHash("sha256").update("fixture-secret").digest("hex"), policyId: id, policyGeneration: "fixture" }));
    }
    await kv.put(`connections/${providerId}`, JSON.stringify({ providerId, enabled: true }));
    const origin = String(await mf.ready).replace(/\/$/, "");
    for (const id of ids) {
      const response = await fetch(`${origin}/v1/admin/upstream-grants/policies/${id}/vertex`, {
        method: "PUT", headers: { authorization: "Bearer fixture-admin", "content-type": "application/json" }, body: JSON.stringify(grant(id)),
      });
      assert.equal(response.status, 200, await response.text());
    }
    return { mf, origin, upstream: await mf.getWorker("upstream") };
  } catch (error) { await mf.dispose(); throw error; }
}

test("shipped Vertex JSON/manifest owner and unknown-price contracts through workerd", { timeout: 60_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-vertex-wire-")); let fixture;
  try {
    fixture = await setup(temporary); const { origin, upstream } = fixture;
    for (const [id, manifest] of [["vertex_stream", false], ["vertex_global", true]]) {
      const body = { model: upstreamModel, messages: [{ role: "user", content: `fixture ${id}` }], max_tokens: 16, stream: false };
      const response = await fetch(origin + (manifest ? "/v1/proxy/anthropic-vertex/messages" : "/v1/native/anthropic-vertex/v1/messages"),
        { method: "POST", headers: headers(id), body: JSON.stringify(manifest ? { body } : body) });
      assert.equal(response.status, 200); assert.equal((await response.json()).content[0].text, "synthetic-answer");
      const receipt = await settledUsage(origin, id); assert.equal(receipt.budget.spentMicros, 7);
      assert.deepEqual(receipt.usage.events.map(event => [event.actual_cost_micros, event.cost_basis, event.input_tokens, event.output_tokens]), [[7, "policy_fixed", 11, 3]]);
    }
    const response = await fetch(origin + "/v1/native/anthropic-vertex/v1/messages", { method: "POST", headers: headers("vertex_unpriced"),
      body: JSON.stringify({ model: upstreamModel, messages: [{ role: "user", content: "fixture vertex_unpriced" }], max_tokens: 16 }) });
    const error = await response.json(); assert.equal(response.status, 400, JSON.stringify(error)); assert.equal(error.error.code, "pricing_required");
    const calls = await (await upstream.fetch("https://fixture.example/state")).json(); assert.equal(calls.length, 2);
    for (const [index, id] of ["vertex_stream", "vertex_global"].entries()) assertOwner(calls[index], id, false);
  } finally { await fixture?.mf.dispose(); await rm(temporary, { recursive: true, force: true }); }
});

test("actual registered Vertex Messages client, original owners and SQLite accounting", { skip: !source, timeout: 300_000 }, async t => {
  const provider = snapshot.providers.find(provider => provider.id === providerId);
  assert.deepEqual(provider.models.map(model => [model.id, model.upstream, model.pricing]), [[modelId, upstreamModel, null]]);
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-vertex-client-")); let fixture;
  try {
    fixture = await setup(temporary); const { origin, upstream } = fixture;
    const catalog = await (await fetch(origin + "/v1/catalog", { headers: headers("vertex_stream") })).json();
    const visible = catalog.providers.find(row => row.id === providerId);
    assert.equal(visible.models[0].pricing, null); assert.equal(visible.models[0].endpointPricing.messages.pricing, null);
    assert.deepEqual([visible.models[0].nativeCapabilities.endpoints.messages.contextWindow, visible.models[0].nativeCapabilities.endpoints.messages.maxOutputTokens], [1_000_000, 128_000]);
    assert.doesNotMatch(JSON.stringify(visible), /fixture-vertex|vertexAnthropicBinding|fixture-vertex-access/);
    await runOpenClawConsumer(t, { source, sourceHead, fixture: new URL("./fixtures/openclaw-vertex-contract.test.ts", import.meta.url),
      testPath: "src/agents/worker-contract.test.ts", env: { CLAWROUTER_CONTRACT_ORIGIN: origin } });
    let calls;
    for (let attempt = 0; attempt < 150; attempt++) {
      calls = await (await upstream.fetch("https://fixture.example/state")).json();
      const cancelled = calls.find(call => JSON.stringify(call.body.messages).includes("vertex_cancel"));
      if (cancelled?.cancelled || cancelled?.aborted) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(calls.length, charged.length, "denials are zero-egress; no uncertain replay or native credential fallback");
    const cancelled = calls.find(call => JSON.stringify(call.body.messages).includes("vertex_cancel"));
    assert.ok(cancelled?.cancelled || cancelled?.aborted); assert.notEqual(cancelled.fixtureExpired, true);
    for (const id of charged) {
      const matched = calls.filter(call => JSON.stringify(call.body.messages).includes(`fixture ${id}`));
      assert.equal(matched.length, 1, id); const [call] = matched; assertOwner(call, id, true);
      const blocks = call.body.messages.flatMap(message => Array.isArray(message.content) ? message.content : []);
      const use = blocks.find(block => block.type === "tool_use"), answer = blocks.find(block => block.type === "tool_result");
      assert.equal(use.name, "lookup"); assert.deepEqual(use.input, { index: 1 }); assert.match(use.id, /^[a-zA-Z0-9_-]+$/);
      assert.equal(answer.tool_use_id, use.id); assert.equal(answer.content, "synthetic record");
      assert.equal(call.body.max_tokens, 2048);
      if (id === "vertex_thinking") {
        assert.ok(["enabled", "adaptive"].includes(call.body.thinking?.type));
        assert.equal(call.body.messages.at(-1).role, "user"); assert.doesNotMatch(JSON.stringify(call.body.messages), /synthetic prefill/);
      }
      const receipt = await settledUsage(origin, id), [event] = receipt.usage.events;
      assert.equal(receipt.usage.events.length, 1); assert.equal(receipt.budget.spentMicros, 7);
      assert.equal(event.provider, providerId); assert.equal(event.model, modelId);
      assert.equal(event.credential_id, id); assert.equal(event.policy_id, id);
      assert.equal(event.cost_basis, "policy_fixed"); assert.equal(event.actual_cost_micros, 7);
      assert.equal(event.status, id === "vertex_error" ? "provider_error" : id === "vertex_cancel" ? "client_error" : "success");
      assert.deepEqual([event.input_tokens, event.output_tokens, event.total_tokens], ["vertex_error", "vertex_cancel"].includes(id) ? [null, null, null] : [11, 3, 14]);
      assert.doesNotMatch(JSON.stringify(event), /fixture-vertex-|must-not-fallback|synthetic record/);
    }
    const incoming = await (await fetch(origin + "/fixture/incoming")).json();
    assert.ok(incoming.length >= charged.length);
    assert.ok(incoming.every(call => call.proxyAuthorization && !call.nativeFallback), "actual caller uses only the selected proxy credential");
    for (const id of denied) {
      const receipt = await settledUsage(origin, id, false); assert.equal(receipt.budget.spentMicros, 0, id);
      assert.ok(receipt.usage.events.every(event => event.actual_cost_micros === 0), id);
    }
  } finally { await fixture?.mf.dispose(); await rm(temporary, { recursive: true, force: true }); }
});

function assertOwner(call, id, stream) {
  const location = locationFor(id), host = location === "global" ? "aiplatform.googleapis.com" : `${location}-aiplatform.googleapis.com`;
  assert.equal(call.url, `https://${host}/v1/projects/${projectFor(id)}/locations/${location}/publishers/anthropic/models/${upstreamModel}:${stream ? "streamRawPredict" : "rawPredict"}`);
  assert.equal(call.redirect, "manual"); assert.equal(call.headers.authorization, `Bearer fixture-vertex-${id}`);
  for (const name of ["x-api-key", "anthropic-version", "x-goog-user-project"]) assert.equal(call.headers[name], undefined);
  assert.equal(call.body.model, undefined); assert.equal(call.body.anthropic_version, "vertex-2023-10-16"); assert.equal(call.body.stream, stream);
  assert.doesNotMatch(JSON.stringify(call), /clawrouter-live-|must-not-fallback|caller-foreign|clawrouterRoute/);
}
async function settledUsage(origin, id, charged = true) {
  let receipt;
  for (let attempt = 0; attempt < (charged ? 150 : 1); attempt++) {
    const response = await fetch(origin + "/v1/usage", { headers: headers(id) }); assert.equal(response.status, 200); receipt = await response.json();
    if (receipt.usage.events.length || !charged) return receipt;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return receipt;
}
function routerFixture() {
  const adminHash = createHash("sha256").update("fixture-admin").digest("hex");
  return `import handler from "./worker/index.ts"; export * from "./worker/index.ts";
    const incoming = [];
    export default { ...handler, async fetch(request, env, context) {
      env = { ...env, CLAWROUTER_ADMIN_TOKEN_SHA256: "${adminHash}", ANTHROPIC_API_KEY: "must-not-fallback-anthropic", GOOGLE_API_KEY: "must-not-fallback-google", GOOGLE_APPLICATION_CREDENTIALS: "must-not-fallback-adc" };
      const path = new URL(request.url).pathname;
      if (path === "/fixture/incoming") return Response.json(incoming);
      if (path === "/v1/native/anthropic-vertex/v1/messages") incoming.push({ proxyAuthorization: (request.headers.get("authorization") ?? "").startsWith("Bearer clawrouter-live-"), nativeFallback: JSON.stringify([...request.headers]).includes("must-not-fallback") });
      if (path === "/fixture/revoke") {
        const response = await handler.fetch(new Request("https://fixture.example/v1/admin/upstream-grants/policies/vertex_revoked/vertex", {
          method: "PUT", headers: { authorization: "Bearer fixture-admin", "content-type": "application/json" }, body: JSON.stringify({ provider: "anthropic-vertex", kind: "oauth", enabled: false }),
        }), env, context);
        if (response.status !== 200) return response; await response.body?.cancel(); return new Response(null, { status: 204 });
      }
      return handler.fetch(request, env, context);
    } };`;
}
function upstreamFixture() {
  return `const calls = []; export default { async fetch(request) {
    if (request.url === "https://fixture.example/state") return Response.json(calls);
    const body = await request.json(), call = { url: request.url, redirect: request.redirect, headers: Object.fromEntries(request.headers), body }; calls.push(call);
    const input = JSON.stringify(body.messages), failed = input.includes("vertex_error"), cancel = input.includes("vertex_cancel"), thinking = input.includes("vertex_thinking"), tool = input.includes("vertex_tools");
    if (!body.stream) return Response.json({ id: "msg_fixture", type: "message", role: "assistant", model: "claude-sonnet-4-6", content: [{ type: "text", text: "synthetic-answer" }], stop_reason: "end_turn", usage: { input_tokens: 11, output_tokens: 3 } });
    const textIndex = thinking ? 1 : 0;
    const events = [
      { type: "message_start", message: { id: "msg_fixture", type: "message", role: "assistant", model: "claude-sonnet-4-6", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 11, output_tokens: 0 } } },
      ...(thinking ? [{ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } }, { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "synthetic reasoning" } }, { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "synthetic-signature" } }, { type: "content_block_stop", index: 0 }] : []),
      { type: "content_block_start", index: textIndex, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: textIndex, delta: { type: "text_delta", text: "synthetic-answer" } },
      ...(failed ? [{ type: "error", error: { type: "overloaded_error", message: "synthetic-upstream-error" } }] : cancel ? [] : [
        { type: "content_block_stop", index: textIndex },
        ...(tool ? [{ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tool_fixture", name: "lookup", input: {} } }, { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"index":' } }, { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '2}' } }, { type: "content_block_stop", index: 1 }] : []),
        { type: "message_delta", delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } }, { type: "message_stop" }]),
    ];
    const bytes = new TextEncoder().encode(events.map(event => "event: " + event.type + "\\ndata: " + JSON.stringify(event) + "\\n\\n").join(""));
    let offset = 0, beats = 0, timer, wake;
    request.signal.addEventListener("abort", () => { call.aborted = true; clearTimeout(timer); wake?.(); }, { once: true });
    return new Response(new ReadableStream({ pull(controller) {
      if (offset === bytes.length) {
        if (!cancel) { controller.close(); return; }
        return new Promise(resolve => { wake = resolve; timer = setTimeout(() => {
          if (++beats > 200) { call.fixtureExpired = true; controller.close(); }
          else controller.enqueue(new TextEncoder().encode(": fixture heartbeat\\n\\n")); resolve();
        }, 50); });
      }
      const end = Math.min(offset + 7, bytes.length); controller.enqueue(bytes.slice(offset, end)); offset = end;
    }, cancel() { call.cancelled = true; clearTimeout(timer); wake?.(); } }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } });
  } };`;
}
