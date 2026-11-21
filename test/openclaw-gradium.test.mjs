import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import snapshot from "../worker/generated/provider-snapshot.json" with { type: "json" };
import { runOpenClawConsumer } from "./helpers/openclaw-consumer.mjs";

const source = process.env.CLAWROUTER_OPENCLAW_CHECKOUT;
const sourceHead = "d2e88f6ff4b34b2141ee67b30a4c2783adf0f38c";
const wire = JSON.parse(readFileSync(new URL("../providers/_fixtures/gradium/speech.json", import.meta.url)));
const cases = [
  { id: "gradium_wav", text: "Synthetic café WAV", format: "wav", voice: "synthetic-voice" },
  { id: "gradium_opus", text: "Synthetic Opus", format: "opus", voice: "synthetic-voice" },
  { id: "gradium_talk", text: "Synthetic Talk", format: "wav", voice: "synthetic-override" },
  ...["error", "eof", "mime"].map(failure => ({ id: `gradium_${failure}`, text: `Synthetic ${failure}`, format: "wav", voice: "synthetic-voice", failure })),
];
const denied = ["gradium_denied", "gradium_budget", "gradium_invalid"];

{
  const transport = "native";
  test(`actual Gradium TTS/Talk ${transport} through workerd and SQLite`, { skip: !source, timeout: 300_000 }, async t => {
    const provider = snapshot.providers.find(provider => provider.id === "gradium");
    assert.ok(provider.endpoints.some(endpoint => endpoint.request_format === "gradium.speech" && endpoint.response_format === "audio.binary"));
    const temporary = await mkdtemp(join(tmpdir(), "clawrouter-openclaw-gradium-"));
    const { startWorkerdFixture } = await import("./helpers/workerd.mjs");
    let mf;
    try {
      mf = await startWorkerdFixture(temporary, routerFixture(), upstreamFixture());
      const kv = await mf.getKVNamespace("POLICY_KV", "router");
      for (const id of [...cases.map(entry => entry.id), ...denied]) {
        await kv.put(`policies/${id}`, JSON.stringify({ enabled: true, generation: "fixture", providers: id === "gradium_denied" ? ["openai"] : ["gradium"], models: null, tenantId: "fixture", monthlyBudgetMicros: 100, requestCostMicros: id === "gradium_budget" ? null : 7, budgetMode: "reserve", retainRequestContent: false }));
        await kv.put(`credentials/${id}`, JSON.stringify({ enabled: true, secretSha256: createHash("sha256").update("fixture-secret").digest("hex"), policyId: id, policyGeneration: "fixture" }));
      }
      await kv.put("connections/gradium", JSON.stringify({ providerId: "gradium", enabled: true }));
      const origin = String(await mf.ready);
      const catalogResponse = await fetch(new URL("/v1/catalog", origin), { headers: { authorization: "Bearer clawrouter-live-gradium_wav-fixture-secret" } });
      assert.equal(catalogResponse.status, 200);
      const offers = (await catalogResponse.json()).providers.find(row => row.id === "gradium").offers;
      assert.ok(offers.some(offer => offer.endpoint === "speech" && offer.routeKind === "native" && offer.eligible));
      assert.ok(offers.filter(offer => offer.endpoint === "speech").every(offer => offer.routeKind !== "manifest"));
      await runOpenClawConsumer(t, {
        source, sourceHead, fixture: new URL("./fixtures/openclaw-gradium-contract.test.ts", import.meta.url),
        testPath: "src/gateway/talk/worker-contract.test.ts",
        env: { CLAWROUTER_CONTRACT_ORIGIN: origin.replace(/\/$/, "") },
      });
      const upstream = await mf.getWorker("upstream");
      const calls = await (await upstream.fetch("https://fixture.example/state")).json();
      assert.equal(calls.length, cases.length, "denied calls never dispatch; uncertain generation never replays");
      const incoming = await (await fetch(new URL("/fixture/requests", origin))).json();
      const posts = incoming.filter(call => call.method === "POST");
      assert.equal(posts.length, cases.length);
      for (const call of incoming) {
        assert.match(call.authorization, /^Bearer clawrouter-live-gradium_[a-z]+-(?:fixture-secret|invalid)$/);
        assert.equal(call.vendorKey, null, "the actual client must send only the proxy credential");
      }
      for (const entry of cases) {
        const call = calls.find(call => call.body.text === entry.text);
        assert.ok(call, entry.id);
        assert.equal(call.url, "https://api.gradium.ai" + wire.request.path);
        assert.equal(call.method, "POST");
        assert.equal(call.redirect, "manual");
        assert.equal(call.headers["x-api-key"], "fixture-upstream-gradium-key");
        assert.equal(call.headers.authorization, undefined);
        assert.deepEqual(call.body, { text: entry.text, voice_id: entry.voice, only_audio: true, output_format: entry.format, json_config: '{"padding_bonus":0}' });
        assert.doesNotMatch(JSON.stringify(call), /clawrouter-live-|must-not-fallback|must-not-forward/);
        const post = posts.find(call => call.authorization === `Bearer clawrouter-live-${entry.id}-fixture-secret`);
        assert.equal(post?.path, transport === "native" ? "/v1/native/gradium" + wire.request.path : "/v1/proxy/gradium/speech");
        assert.ok(incoming.some(call => call.path === "/v1/catalog" && call.authorization === post.authorization), "the actual client selects from its credential-scoped catalog");
        const usage = await settledUsage(origin, entry.id);
        assert.equal(usage.usage.events.length, 1, "one synthesis produces one original-caller receipt");
        const [event] = usage.usage.events;
        assert.equal(event.provider, "gradium");
        assert.equal(event.model, null, "model-less speech must not invent a model");
        assert.equal(event.capability, "audio.speech");
        assert.equal(event.credential_id, entry.id);
        assert.equal(event.policy_id, entry.id);
        assert.equal(event.status, entry.failure ? "provider_error" : "success");
        assert.equal(event.cost_basis, "policy_fixed");
        assert.equal(event.actual_cost_micros, 7, "uncertain dispatched generation retains the explicit policy charge");
        assert.equal(usage.budget.spentMicros, 7);
        for (const name of ["input_tokens", "output_tokens", "total_tokens"]) assert.equal(event[name], null, "audio bytes and characters are not token receipts");
        assert.doesNotMatch(JSON.stringify(event), /Synthetic|fixture-upstream|must-not-fallback|must-not-forward/);
      }
      for (const id of denied) {
        const usage = await readUsage(origin, id);
        assert.equal(usage.budget.spentMicros, 0);
        assert.ok(usage.usage.events.every(event => event.actual_cost_micros === 0));
      }
    } finally {
      await mf?.dispose();
      await rm(temporary, { recursive: true, force: true });
    }
  });
}

async function readUsage(origin, id) {
  const response = await fetch(new URL("/v1/usage", origin), { headers: { authorization: `Bearer clawrouter-live-${id}-fixture-secret` } });
  assert.equal(response.status, 200);
  return response.json();
}

async function settledUsage(origin, id) {
  let usage;
  for (let attempt = 0; attempt < 100; attempt++) {
    usage = await readUsage(origin, id);
    if (usage.usage.events.length) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return usage;
}

function routerFixture() {
  return `import handler from "./worker/index.ts"; export * from "./worker/index.ts";
    const requests = [];
    export default { ...handler, fetch(request, env, context) {
      const path = new URL(request.url).pathname;
      if (path === "/fixture/requests") return Response.json(requests);
      if (path !== "/v1/usage") requests.push({ path, method: request.method, authorization: request.headers.get("authorization"), vendorKey: request.headers.get("x-api-key") });
      return handler.fetch(request, { ...env, GRADIUM_API_KEY: "fixture-upstream-gradium-key" }, context);
    } };`;
}

function upstreamFixture() {
  return `const calls = [], wav = Uint8Array.from(atob(${JSON.stringify(wire.response.base64)}), c => c.charCodeAt(0));
    export default { async fetch(request) {
      if (request.url === "https://fixture.example/state") return Response.json(calls);
      const body = await request.json();
      calls.push({ url: request.url, method: request.method, redirect: request.redirect, headers: Object.fromEntries(request.headers), body });
      if (body.text === "Synthetic error") return Response.json({ error: "fixture-private-upstream-error" }, { status: 429 });
      const bytes = body.output_format === "opus" ? new TextEncoder().encode("OggS\\0synthetic OpusHead transport fixture") : wav;
      const chunks = [bytes.subarray(0, 3), bytes.subarray(3, 9), bytes.subarray(9)];
      return new Response(new ReadableStream({ pull(controller) {
        const chunk = chunks.shift();
        if (body.text === "Synthetic eof" && chunks.length === 1) { controller.error(new Error("fixture-private-transport-loss")); return; }
        if (chunk) controller.enqueue(chunk); else controller.close();
      } }), { headers: { "content-type": body.text === "Synthetic mime" ? "application/json" : body.output_format === "opus" ? "audio/ogg" : "audio/wav" } });
    } };`;
}
