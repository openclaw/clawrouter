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
const sourceHead = "4e27e9ab53dd7215f84ffa06ef5f193be7fb603b";
const audio = JSON.parse(readFileSync(new URL("./fixtures/azure-output.json", import.meta.url)));
const format = "audio-24khz-48kbitrate-mono-mp3";
const cases = [
  { id: "azure_tts", text: "Synthetic café &amp; 中文 😀 &lt;tag&gt;", voice: "en-US-JennyNeural" },
  { id: "azure_talk", text: "Synthetic Talk", voice: "en-US-AriaNeural" },
  ...["error", "eof", "mime", "empty"].map(failure => ({ id: `azure_${failure}`, text: `Synthetic ${failure}`, voice: "en-US-JennyNeural", failure })),
];
const denied = ["azure_denied", "azure_budget", "azure_invalid"];

test("actual Azure native TTS/Talk raw SSML through workerd and SQLite", { skip: !source, timeout: 300_000 }, async t => {
  const provider = snapshot.providers.find(provider => provider.id === "azure-speech");
  assert.equal(provider.models.length, 0);
  assert.ok(provider.endpoints.some(endpoint => endpoint.request_format === "azure_speech.ssml" && endpoint.response_format === "audio.binary"));
  assert.equal(createHash("sha256").update(Buffer.from(audio.base64, "base64")).digest("hex"), audio.sha256);
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-openclaw-azure-"));
  const { startWorkerdFixture } = await import("./helpers/workerd.mjs");
  let mf;
  try {
    mf = await startWorkerdFixture(temporary, routerFixture(), upstreamFixture());
    const kv = await mf.getKVNamespace("POLICY_KV", "router");
    for (const id of [...cases.map(entry => entry.id), ...denied]) {
      await kv.put(`policies/${id}`, JSON.stringify({ enabled: true, generation: "fixture", providers: id === "azure_denied" ? ["openai"] : ["azure-speech"], models: null, tenantId: "fixture", monthlyBudgetMicros: 100, requestCostMicros: id === "azure_budget" ? null : 7, budgetMode: "reserve", retainRequestContent: false }));
      await kv.put(`credentials/${id}`, JSON.stringify({ enabled: true, secretSha256: createHash("sha256").update("fixture-secret").digest("hex"), policyId: id, policyGeneration: "fixture" }));
    }
    await kv.put("connections/azure-speech", JSON.stringify({ providerId: "azure-speech", enabled: true }));
    const origin = String(await mf.ready).replace(/\/$/, "");
    await runOpenClawConsumer(t, {
      source, sourceHead, fixture: new URL("./fixtures/openclaw-azure-contract.test.ts", import.meta.url),
      testPath: "src/gateway/talk/worker-contract.test.ts",
      env: { CLAWROUTER_CONTRACT_ORIGIN: origin, CLAWROUTER_CONTRACT_MP3: audio.base64 },
    });
    const upstream = await mf.getWorker("upstream"), calls = await (await upstream.fetch("https://fixture.example/state")).json();
    const incoming = await (await fetch(origin + "/fixture/requests")).json(), posts = incoming.filter(call => call.method === "POST");
    assert.equal(calls.length, cases.length, "denied requests never dispatch; uncertain synthesis never replays");
    assert.equal(posts.length, cases.length);
    for (const call of incoming) {
      assert.match(call.authorization, /^Bearer clawrouter-live-azure_[a-z]+-(?:fixture-secret|invalid)$/);
      assert.equal(call.vendorKey, null); assert.equal(call.otherKey, null); assert.equal(call.region, null);
    }
    for (const entry of cases) {
      const expected = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US"><voice name="${entry.voice}">${entry.text}</voice></speak>`;
      const call = calls.find(call => call.body === expected); assert.ok(call, entry.id);
      assert.equal(call.url, "https://eastus.tts.speech.microsoft.com/cognitiveservices/v1");
      assert.equal(call.method, "POST"); assert.equal(call.redirect, "manual");
      assert.equal(call.headers["content-type"], "application/ssml+xml");
      assert.equal(call.headers["x-microsoft-outputformat"], format);
      assert.equal(call.headers["ocp-apim-subscription-key"], "fixture-upstream-azure-key");
      assert.equal(call.headers.authorization, undefined);
      assert.deepEqual(call.bytes, Array.from(Buffer.from(expected, "utf8")), "actual serializer bytes must reach the selected origin unchanged");
      assert.doesNotMatch(JSON.stringify(call), /clawrouter-live-|must-not-fallback|must-not-forward/);
      const post = posts.find(call => call.authorization === `Bearer clawrouter-live-${entry.id}-fixture-secret`);
      assert.equal(post?.path, "/v1/native/azure-speech/cognitiveservices/v1");
      assert.ok(incoming.some(call => call.path === "/v1/catalog" && call.authorization === post.authorization));
      const usage = await settledUsage(origin, entry.id), [event] = usage.usage.events;
      assert.equal(usage.usage.events.length, 1); assert.equal(usage.budget.spentMicros, 7);
      assert.equal(event.provider, "azure-speech"); assert.equal(event.model, null); assert.equal(event.capability, "audio.speech");
      assert.equal(event.credential_id, entry.id); assert.equal(event.policy_id, entry.id);
      assert.equal(event.status, entry.failure ? "provider_error" : "success");
      assert.equal(event.cost_basis, "policy_fixed"); assert.equal(event.actual_cost_micros, 7);
      for (const field of ["input_tokens", "output_tokens", "total_tokens"]) assert.equal(event[field], null);
      assert.doesNotMatch(JSON.stringify(event), /Synthetic|fixture-upstream|must-not-forward|must-not-fallback/);
    }
    for (const id of denied) {
      const usage = await readUsage(origin, id); assert.equal(usage.budget.spentMicros, 0);
      assert.ok(usage.usage.events.every(event => event.actual_cost_micros === 0));
    }
  } finally { await mf?.dispose(); await rm(temporary, { recursive: true, force: true }); }
});

async function readUsage(origin, id) {
  const response = await fetch(origin + "/v1/usage", { headers: { authorization: `Bearer clawrouter-live-${id}-fixture-secret` } });
  assert.equal(response.status, 200); return response.json();
}
async function settledUsage(origin, id) {
  let usage;
  for (let attempt = 0; attempt < 100; attempt++) {
    usage = await readUsage(origin, id); if (usage.usage.events.length) break;
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
      if (path !== "/v1/usage") requests.push({ path, method: request.method, authorization: request.headers.get("authorization"), vendorKey: request.headers.get("ocp-apim-subscription-key"), otherKey: request.headers.get("x-api-key"), region: request.headers.get("ocp-apim-subscription-region") });
      return handler.fetch(request, { ...env, AZURE_SPEECH_API_KEY: "fixture-upstream-azure-key", AZURE_SPEECH_REGION: "eastus" }, context);
    } };`;
}
function upstreamFixture() {
  return `const calls = [], mp3 = Uint8Array.from(atob(${JSON.stringify(audio.base64)}), c => c.charCodeAt(0));
    export default { async fetch(request) {
      if (request.url === "https://fixture.example/state") return Response.json(calls);
      const bytes = new Uint8Array(await request.arrayBuffer()), body = new TextDecoder().decode(bytes);
      calls.push({ url: request.url, method: request.method, redirect: request.redirect, headers: Object.fromEntries(request.headers), bytes: Array.from(bytes), body });
      if (body.includes("Synthetic error")) return Response.json({ error: "fixture-private-upstream-error" }, { status: 429 });
      if (body.includes("Synthetic empty")) return new Response(null, { headers: { "content-type": "audio/mpeg" } });
      const chunks = [mp3.subarray(0, 3), mp3.subarray(3, 19), mp3.subarray(19)];
      return new Response(new ReadableStream({ pull(controller) {
        const chunk = chunks.shift();
        if (body.includes("Synthetic eof") && chunks.length === 1) { controller.error(new Error("fixture-private-transport-loss")); return; }
        if (chunk) controller.enqueue(chunk); else controller.close();
      } }, { highWaterMark: 0 }), { headers: { "content-type": body.includes("Synthetic mime") ? "audio/ogg" : "audio/mpeg" } });
    } };`;
}
