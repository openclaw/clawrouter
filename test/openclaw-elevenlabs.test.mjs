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
const sourceHead = "dec94c877c3c891f27b4210a680c6445184d444f";
const wire = JSON.parse(readFileSync(new URL("../providers/_fixtures/elevenlabs/speech.json", import.meta.url)));
const cases = [
  { id: "elevenlabs_tts", text: "Synthetic café 😀", voice: "syntheticVoice1234567" },
  { id: "elevenlabs_talk", text: "Synthetic Talk", voice: "syntheticOverride123" },
  ...["error", "eof", "mime", "cancel"].map(failure => ({ id: `elevenlabs_${failure}`, text: `Synthetic ${failure}`, voice: "syntheticVoice1234567", failure })),
];
const denied = ["elevenlabs_denied", "elevenlabs_budget", "elevenlabs_invalid"];

for (const transport of ["native", "manifest"]) {
  test(`actual ElevenLabs TTS/Talk ${transport} through workerd and SQLite`, { skip: !source, timeout: 300_000 }, async t => {
    const provider = snapshot.providers.find(provider => provider.id === "elevenlabs");
    assert.ok(provider.endpoints.some(endpoint => endpoint.request_format === "elevenlabs.speech" && endpoint.response_format === "audio.binary"));
    const temporary = await mkdtemp(join(tmpdir(), "clawrouter-openclaw-elevenlabs-"));
    const { startWorkerdFixture } = await import("./helpers/workerd.mjs");
    let mf;
    try {
      mf = await startWorkerdFixture(temporary, routerFixture(transport), upstreamFixture());
      const kv = await mf.getKVNamespace("POLICY_KV", "router");
      for (const id of [...cases.map(entry => entry.id), ...denied]) {
        await kv.put(`policies/${id}`, JSON.stringify({ enabled: true, generation: "fixture", providers: id === "elevenlabs_denied" ? ["openai"] : ["elevenlabs"], models: null, tenantId: "fixture", monthlyBudgetMicros: 100, requestCostMicros: id === "elevenlabs_budget" ? null : 7, budgetMode: "reserve", retainRequestContent: false }));
        await kv.put(`credentials/${id}`, JSON.stringify({ enabled: true, secretSha256: createHash("sha256").update("fixture-secret").digest("hex"), policyId: id, policyGeneration: "fixture" }));
      }
      await kv.put("connections/elevenlabs", JSON.stringify({ providerId: "elevenlabs", enabled: true }));
      const origin = String(await mf.ready);
      await runOpenClawConsumer(t, {
        source, sourceHead, fixture: new URL("./fixtures/openclaw-elevenlabs-contract.test.ts", import.meta.url),
        testPath: "src/gateway/talk/worker-contract.test.ts",
        env: { CLAWROUTER_CONTRACT_ORIGIN: origin.replace(/\/$/, ""), CLAWROUTER_CONTRACT_AUDIO_BASE64: wire.response.base64 },
      });
      const upstream = await mf.getWorker("upstream");
      const calls = await (await upstream.fetch("https://fixture.example/state")).json();
      assert.equal(calls.length, cases.length, "denied calls never dispatch; uncertain generation never replays");
      const incoming = await (await fetch(new URL("/fixture/requests", origin))).json();
      const posts = incoming.filter(call => call.method === "POST");
      assert.equal(posts.length, cases.length);
      for (const call of incoming) {
        assert.match(call.authorization, /^Bearer clawrouter-live-elevenlabs_[a-z]+-(?:fixture-secret|invalid)$/);
        assert.equal(call.vendorKey, null, "the actual client must send only the proxy credential");
        assert.equal(call.genericKey, null);
      }
      for (const entry of cases) {
        const call = calls.find(call => call.body.text === entry.text);
        assert.ok(call, entry.id);
        assert.equal(call.url, `https://api.elevenlabs.io/v1/text-to-speech/${entry.voice}?output_format=mp3_44100_128&optimize_streaming_latency=2`);
        assert.equal(call.method, "POST");
        assert.equal(call.redirect, "manual");
        assert.equal(call.headers["xi-api-key"], "fixture-upstream-elevenlabs-key");
        assert.equal(call.headers.authorization, undefined);
        assert.equal(call.headers["x-api-key"], undefined);
        assert.deepEqual(call.body, { text: entry.text, model_id: "eleven_multilingual_v2", seed: 42, language_code: "en", apply_text_normalization: "auto", voice_settings: { stability: 0.4, similarity_boost: 0.7, style: 0.1, use_speaker_boost: false, speed: 1.2 } });
        assert.doesNotMatch(JSON.stringify(call), /clawrouter-live-|must-not-fallback|must-not-forward/);
        const post = posts.find(call => call.authorization === `Bearer clawrouter-live-${entry.id}-fixture-secret`);
        assert.equal(post?.path, transport === "native" ? `/v1/native/elevenlabs/v1/text-to-speech/${entry.voice}` : "/v1/proxy/elevenlabs/speech");
        assert.ok(incoming.some(call => call.path === "/v1/catalog" && call.authorization === post.authorization), "the actual client selects from its credential-scoped catalog");
        const usage = await settledUsage(origin, entry.id);
        assert.equal(usage.usage.events.length, 1, "one synthesis produces one original-caller receipt");
        const [event] = usage.usage.events;
        assert.equal(event.provider, "elevenlabs");
        assert.equal(event.model, null, "model-less speech must not invent a model");
        assert.equal(event.capability, "audio.speech");
        assert.equal(event.credential_id, entry.id);
        assert.equal(event.policy_id, entry.id);
        assert.equal(event.status, entry.failure === "cancel" ? "client_error" : entry.failure ? "provider_error" : "success");
        assert.equal(event.cost_basis, "policy_fixed");
        assert.equal(event.actual_cost_micros, 7, "uncertain dispatched generation retains the explicit policy charge");
        assert.equal(usage.budget.spentMicros, 7);
        for (const name of ["input_tokens", "output_tokens", "total_tokens"]) assert.equal(event[name], null, "audio bytes and characters are not token receipts");
        assert.doesNotMatch(JSON.stringify(event), /Synthetic|fixture-upstream|must-not-fallback|must-not-forward/);
      }
      const finalCalls = await (await upstream.fetch("https://fixture.example/state")).json();
      assert.equal(finalCalls.find(call => call.body.text === "Synthetic cancel")?.canceled, true, "caller cancellation reaches the original upstream reader");
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

function routerFixture(transport) {
  return `import handler from "./worker/index.ts"; export * from "./worker/index.ts";
    import { snapshot } from "./worker/providers.ts";
    ${transport === "manifest" ? 'for (const endpoint of snapshot.providers.find(provider => provider.id === "elevenlabs").endpoints) endpoint.native_proxy = false;' : ""}
    const requests = [];
    export default { ...handler, fetch(request, env, context) {
      const path = new URL(request.url).pathname;
      if (path === "/fixture/requests") return Response.json(requests);
      if (path !== "/v1/usage") requests.push({ path, method: request.method, authorization: request.headers.get("authorization"), vendorKey: request.headers.get("xi-api-key"), genericKey: request.headers.get("x-api-key") });
      return handler.fetch(request, { ...env, ELEVENLABS_API_KEY: "fixture-upstream-elevenlabs-key" }, context);
    } };`;
}

function upstreamFixture() {
  return `const calls = [], audio = Uint8Array.from(atob(${JSON.stringify(wire.response.base64)}), c => c.charCodeAt(0));
    export default { async fetch(request) {
      if (request.url === "https://fixture.example/state") return Response.json(calls);
      const body = await request.json();
      const call = { url: request.url, method: request.method, redirect: request.redirect, headers: Object.fromEntries(request.headers), body, canceled: false };
      calls.push(call);
      if (body.text === "Synthetic error") return Response.json({ error: "fixture-private-upstream-error" }, { status: 429 });
      if (body.text === "Synthetic cancel") return new Response(new ReadableStream({
        start(controller) { controller.enqueue(audio.subarray(0, 8)); },
        cancel() { call.canceled = true; },
      }), { headers: { "content-type": "audio/mpeg" } });
      const chunks = [audio.subarray(0, 3), audio.subarray(3, 9), audio.subarray(9)];
      return new Response(new ReadableStream({ pull(controller) {
        const chunk = chunks.shift();
        if (body.text === "Synthetic eof" && chunks.length === 1) { controller.error(new Error("fixture-private-transport-loss")); return; }
        if (chunk) controller.enqueue(chunk); else controller.close();
      } }), { headers: { "content-type": body.text === "Synthetic mime" ? "application/json" : "audio/mpeg" } });
    } };`;
}
