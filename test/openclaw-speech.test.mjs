import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import snapshot from "../worker/generated/provider-snapshot.json" with { type: "json" };
import { runOpenClawConsumer } from "./helpers/openclaw-consumer.mjs";

const source = process.env.CLAWROUTER_OPENCLAW_CHECKOUT;
const sourceHead = "70fcd8cb826f1e70ee59aacaf442e4cf411c7ca4";
const cases = [
  { id: "speech_tts", input: "Synthetic TTS", voice: "alloy", format: "mp3", cost: 7, basis: "policy_fixed" },
  { id: "speech_talk", input: "Synthetic Talk", voice: "nova", format: "wav", speed: 1.25, cost: 7, basis: "policy_fixed" },
  { id: "speech_priced", input: "one 😀", voice: "alloy", format: "mp3", cost: 75, basis: "request_character_estimate" },
  { id: "speech_error", input: "Synthetic rejection", voice: "alloy", format: "mp3", cost: 0, basis: "none" },
];

test("actual OpenClaw TTS and Talk through workerd, binary delivery and SQLite settlement", { skip: !source, timeout: 300_000 }, async t => {
  const provider = snapshot.providers.find(provider => provider.id === "openai");
  const model = provider.models.find(model => model.id === "openai/tts-1");
  assert.ok(model.capabilities.includes("audio.speech"));
  assert.ok(provider.endpoints.some(endpoint => endpoint.request_format === "openai.audio_speech" && endpoint.response_format === "audio.binary"));
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-openclaw-speech-"));
  const { startWorkerdFixture } = await import("./helpers/workerd.mjs");
  let mf;
  try {
    mf = await startWorkerdFixture(temporary, routerFixture(), upstreamFixture());
    const kv = await mf.getKVNamespace("POLICY_KV", "router");
    for (const id of [...cases.map(entry => entry.id), "speech_denied", "speech_budget"]) {
      await kv.put(`policies/${id}`, JSON.stringify({ enabled: true, generation: "fixture", providers: id === "speech_denied" ? ["mistral"] : ["openai"], models: [model.id], tenantId: "fixture", monthlyBudgetMicros: id === "speech_budget" ? 1 : 1000, requestCostMicros: id === "speech_priced" ? null : 7, budgetMode: "reserve", retainRequestContent: false }));
      await kv.put(`credentials/${id}`, JSON.stringify({ enabled: true, secretSha256: createHash("sha256").update("fixture-secret").digest("hex"), policyId: id, policyGeneration: "fixture" }));
    }
    await kv.put("connections/openai", JSON.stringify({ providerId: "openai", enabled: true }));
    const origin = String(await mf.ready);
    await runOpenClawConsumer(t, {
      source, sourceHead, fixture: new URL("./fixtures/openclaw-speech-contract.test.ts", import.meta.url),
      testPath: "src/gateway/talk/worker-contract.test.ts",
      env: { CLAWROUTER_CONTRACT_ORIGIN: origin.replace(/\/$/, "") },
    });
    const upstream = await mf.getWorker("upstream");
    const calls = await (await upstream.fetch("https://fixture.example/state")).json();
    assert.equal(calls.length, cases.length, "rotated keys, missing grants and insufficient budgets must not dispatch");
    for (const entry of cases) {
      const call = calls.find(call => call.body.input === entry.input);
      assert.ok(call, entry.id);
      assert.equal(call.url, "https://api.openai.com/v1/audio/speech");
      assert.equal(call.method, "POST");
      assert.equal(call.headers.authorization, "Bearer fixture-upstream-key");
      assert.deepEqual(call.body, { model: "tts-1", input: entry.input, voice: entry.voice, response_format: entry.format, ...(entry.speed ? { speed: entry.speed } : {}) });
      assert.doesNotMatch(JSON.stringify(call), /clawrouter-live-|must-not-fallback/);
      let usage;
      for (let attempt = 0; attempt < 100; attempt++) {
        usage = await (await fetch(new URL("/v1/usage", origin), { headers: { authorization: `Bearer clawrouter-live-${entry.id}-fixture-secret` } })).json();
        if (usage.usage.events.length) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.equal(usage.usage.events.length, 1, "one synthesis produces one caller-scoped receipt");
      const [event] = usage.usage.events;
      assert.equal(event.provider, "openai");
      assert.equal(event.model, model.id);
      assert.equal(event.capability, "audio.speech");
      assert.equal(event.credential_id, entry.id);
      assert.equal(event.policy_id, entry.id);
      assert.equal(event.status, entry.id === "speech_error" ? "provider_error" : "success");
      assert.equal(event.cost_basis, entry.basis);
      assert.equal(event.actual_cost_micros, entry.cost);
      assert.equal(usage.budget.spentMicros, entry.cost);
      for (const name of ["input_tokens", "output_tokens", "total_tokens"]) assert.equal(event[name], null, "binary bytes are not tokens");
      assert.doesNotMatch(JSON.stringify(event), /Synthetic|one 😀|fixture-upstream|must-not-fallback/);
    }
  } finally {
    await mf?.dispose();
    await rm(temporary, { recursive: true, force: true });
  }
});

function routerFixture() {
  return `import handler from "./worker/index.ts"; export * from "./worker/index.ts"; export default handler;`;
}

function upstreamFixture() {
  return `const calls = []; export default { async fetch(request) {
    if (request.url === "https://fixture.example/state") return Response.json(calls);
    const body = await request.json();
    calls.push({ url: request.url, method: request.method, headers: Object.fromEntries(request.headers), body });
    if (body.input === "Synthetic rejection") return Response.json({ error: { message: "Synthetic speech unavailable" } }, { status: 502 });
    const chunks = [new Uint8Array([0x49, 0x44]), new Uint8Array([0x33]), new Uint8Array([1, 2, 3])];
    return new Response(new ReadableStream({ pull(controller) { const chunk = chunks.shift(); if (chunk) controller.enqueue(chunk); else controller.close(); } }), { headers: { "content-type": body.response_format === "wav" ? "audio/wav" : "audio/mpeg" } });
  } };`;
}
