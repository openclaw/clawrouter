import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runOpenClawConsumer } from "./helpers/openclaw-consumer.mjs";

const source = process.env.CLAWROUTER_OPENCLAW_CHECKOUT;
const sourceHead = "3645a2c86518e9e98e4df2a81d00355bc6b082c0";
const models = ["lyria-3-clip-preview", "lyria-3-pro-preview"];
const dispatched = ["clip", "pro", "image", "text", "eof", "error", "persist", "cancel"];
const denied = ["budget", "denied", "missing", "stale", "foreign", "preabort"];
const route = "native";
const entries = [...dispatched, ...denied].map(kind => ({
  id: `lyria_${route}_${kind}`, route, kind, model: kind === "pro" ? models[1] : models[0],
}));

test("actual registered Lyria music tool through native Worker and SQLite", { skip: !source, timeout: 300_000 }, async t => {
  const mp3 = readFileSync(join(source, "test/fixtures/media/lyria-silence.mp3"));
  assert.equal(createHash("sha256").update(mp3).digest("hex"), "94bf451427043b32a9893976aefdea79d784323e5422f1f986fb22548615162b");
  const wav = silenceWav(), audio = { mp3: mp3.toString("base64"), wav: wav.toString("base64") };
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-openclaw-lyria-"));
  const { startWorkerdFixture } = await import("./helpers/workerd.mjs");
  let mf;
  try {
    mf = await startWorkerdFixture(temporary, routerFixture(), upstreamFixture(audio));
    const kv = await mf.getKVNamespace("POLICY_KV", "router");
    for (const entry of entries.filter(entry => entry.route === route)) {
      await kv.put(`policies/${entry.id}`, JSON.stringify({ enabled: true, generation: "fixture", providers: entry.kind === "denied" ? ["openai"] : ["google-gemini"],
        models: models.map(id => `google/${id}`), tenantId: "fixture", monthlyBudgetMicros: 100, requestCostMicros: entry.kind === "budget" ? null : 7,
        budgetMode: "reserve", retainRequestContent: false }));
      await kv.put(`credentials/${entry.id}`, JSON.stringify({ enabled: true, secretSha256: createHash("sha256").update("fixture-secret").digest("hex"), policyId: entry.id, policyGeneration: "fixture" }));
    }
    await kv.put("connections/google-gemini", JSON.stringify({ providerId: "google-gemini", enabled: true }));
    const origin = String(await mf.ready).replace(/\/$/, "");
    const catalogResponse = await fetch(origin + "/v1/catalog", { headers: { authorization: "Bearer clawrouter-live-lyria_native_clip-fixture-secret" } });
    assert.equal(catalogResponse.status, 200);
    const offers = (await catalogResponse.json()).providers.find(provider => provider.id === "google-gemini").offers;
    for (const model of models) assert.ok(offers.some(offer => offer.endpoint === "music_generate" && offer.modelId === `google/${model}` && offer.routeKind === "native" && offer.eligible));
    assert.ok(offers.filter(offer => offer.endpoint === "music_generate").every(offer => offer.routeKind !== "manifest"));
    await runOpenClawConsumer(t, { source, sourceHead, fixture: new URL("./fixtures/openclaw-lyria-contract.test.ts", import.meta.url),
      testPath: "src/agents/tools/worker-contract.test.ts", env: { CLAWROUTER_CONTRACT_ORIGIN: origin, CLAWROUTER_CONTRACT_ROUTE: route, CLAWROUTER_CONTRACT_AUDIO: JSON.stringify(audio) } });
    const upstream = await mf.getWorker("upstream");
    const calls = await (await upstream.fetch("https://fixture.example/state")).json();
    assert.equal(calls.length, dispatched.length, "denials never dispatch and uncertain paid requests never replay");
    const incoming = await (await fetch(origin + "/fixture/requests")).json();
    assert.equal(incoming.filter(call => call.path === "/fixture/alternate").length, 0, "the configured alternate is never used after a paid attempt or explicit selection");
    for (const entry of entries.filter(entry => entry.route === route)) {
      const matched = calls.filter(call => call.body.contents[0].parts[0].text.startsWith(`Synthetic ${entry.id}`));
      const receipt = await settledUsage(origin, entry.id, dispatched.includes(entry.kind));
      if (!dispatched.includes(entry.kind)) {
        assert.equal(matched.length, 0, entry.id); assert.equal(receipt.budget.spentMicros, 0, entry.id);
        assert.ok(receipt.usage.events.every(event => event.actual_cost_micros === 0), entry.id);
        continue;
      }
      assert.equal(matched.length, 1, entry.id); const [call] = matched;
      assert.equal(call.url, `https://generativelanguage.googleapis.com/v1beta/models/${entry.model}:generateContent`);
      assert.equal(call.method, "POST"); assert.equal(call.redirect, "manual");
      assert.equal(call.headers["x-goog-api-key"], "fixture-original-google-key");
      assert.equal(call.headers.authorization, undefined); assert.equal(call.headers["x-api-key"], undefined);
      assert.doesNotMatch(JSON.stringify(call), /clawrouter-live-|must-not-forward|must-not-fallback/);
      assert.deepEqual(call.body.generationConfig, { responseModalities: ["AUDIO", "TEXT"] });
      assert.match(call.body.contents[0].parts[0].text, /Instrumental only\.[\s\S]*Lyrics:\nSynthetic lyrics$/);
      if (entry.kind === "image") assert.deepEqual(call.body.contents[0].parts[1], { inlineData: { mimeType: "image/png", data: png } });
      else assert.equal(call.body.contents[0].parts.length, 1);
      const post = incoming.find(value => value.authorization === `Bearer clawrouter-live-${entry.id}-fixture-secret` && value.method === "POST");
      assert.ok(post, entry.id);
      assert.equal(post.path, entry.route === "native" ? `/v1/native/google-gemini/v1beta/models/${entry.model}:generateContent` : "/v1/proxy/google-gemini/music_generate");
      assert.equal(post.vendorKey, null); assert.equal(post.otherKey, null);
      assert.equal(post.acceptEncoding, "identity", entry.id);
      assert.deepEqual(post.body, entry.route === "native" ? call.body : { body: call.body, pathParams: { model: entry.model } });
      const [event] = receipt.usage.events;
      assert.equal(receipt.usage.events.length, 1); assert.equal(receipt.budget.spentMicros, 7);
      assert.equal(event.credential_id, entry.id); assert.equal(event.policy_id, entry.id);
      assert.equal(event.provider, "google-gemini"); assert.equal(event.model, `google/${entry.model}`); assert.equal(event.capability, "audio.generate");
      assert.equal(event.actual_cost_micros, 7); assert.equal(event.cost_basis, "policy_fixed");
      assert.equal(event.status, ["text", "eof", "error"].includes(entry.kind) ? "provider_error" : "success");
      for (const field of ["input_tokens", "output_tokens", "total_tokens"]) assert.equal(event[field], null);
      assert.doesNotMatch(JSON.stringify(event), /Synthetic|fixture-original|fixture-secret|must-not-/);
    }
  } finally { await mf?.dispose(); await rm(temporary, { recursive: true, force: true }); }
});

// Direct Worker transport coverage does not imply a manifest catalog offer.
test("real Worker negotiates identity without changing complete audio or accounting", { timeout: 30_000 }, async () => {
  const audio = { mp3: "", wav: silenceWav().toString("base64") };
  const { startWorkerdFixture } = await import("./helpers/workerd.mjs");
  for (const route of ["native", "manifest"]) {
    const temporary = await mkdtemp(join(tmpdir(), "clawrouter-lyria-encoding-"));
    let mf;
    try {
      mf = await startWorkerdFixture(temporary, routerFixture(), upstreamFixture(audio));
      const kv = await mf.getKVNamespace("POLICY_KV", "router");
      for (const kind of ["pro", "negotiated"]) {
        const id = `lyria_${route}_${kind}`;
        await kv.put(`policies/${id}`, JSON.stringify({ enabled: true, generation: "fixture", providers: ["google-gemini"],
          models: ["google/lyria-3-pro-preview"], tenantId: "fixture", monthlyBudgetMicros: 100,
          requestCostMicros: 7, budgetMode: "reserve", retainRequestContent: false }));
        await kv.put(`credentials/${id}`, JSON.stringify({ enabled: true, secretSha256: createHash("sha256").update("fixture-secret").digest("hex"), policyId: id, policyGeneration: "fixture" }));
      }
      await kv.put("connections/google-gemini", JSON.stringify({ providerId: "google-gemini", enabled: true }));
      const origin = String(await mf.ready).replace(/\/$/, "");
      for (const kind of ["pro", "negotiated"]) {
        const id = `lyria_${route}_${kind}`;
        const body = { contents: [{ role: "user", parts: [{ text: `Synthetic ${id}` }] }], generationConfig: { responseModalities: ["AUDIO", "TEXT"] } };
        const response = await fetch(origin + (route === "native" ? "/v1/native/google-gemini/v1beta/models/lyria-3-pro-preview:generateContent" : "/v1/proxy/google-gemini/music_generate"), {
          method: "POST", headers: { authorization: `Bearer clawrouter-live-${id}-fixture-secret`, "content-type": "application/json", "accept-encoding": kind === "pro" ? "identity" : "gzip" },
          body: JSON.stringify(route === "native" ? body : { body, pathParams: { model: "lyria-3-pro-preview" } }),
        });
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("content-encoding"), kind === "pro" ? null : "gzip");
        const result = await response.json();
        assert.equal(result.candidates[0].content.parts[1].inlineData.data, audio.wav, "both negotiated responses deliver the exact complete WAV");
        const observed = await (await fetch(origin + "/fixture/requests")).json();
        const post = observed.find(call => call.authorization === `Bearer clawrouter-live-${id}-fixture-secret` && call.method === "POST");
        assert.equal(post.acceptEncoding, kind === "pro" ? "identity" : "gzip", "observe the original client header before edge normalization");
        const receipt = await settledUsage(origin, id, true);
        assert.equal(receipt.usage.events.length, 1); assert.equal(receipt.budget.spentMicros, 7);
        const [event] = receipt.usage.events;
        assert.equal(event.cost_basis, "policy_fixed"); assert.equal(event.actual_cost_micros, 7); assert.equal(event.status, "success");
        assert.deepEqual([event.input_tokens, event.output_tokens, event.total_tokens], [null, null, null]);
      }
      const calls = await (await (await mf.getWorker("upstream")).fetch("https://fixture.example/state")).json();
      assert.equal(calls.length, 2);
      for (const call of calls) assert.equal(call.headers["x-goog-api-key"], "fixture-original-google-key");
    } finally { await mf?.dispose(); await rm(temporary, { recursive: true, force: true }); }
  }
});

const png = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVQI12NkYPj/n4GBgYGJAQoAHRkCAhxhMhsAAAAASUVORK5CYII=";
function silenceWav() {
  const bytes = Buffer.alloc(1808);
  bytes.write("RIFF"); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(2, 22);
  bytes.writeUInt32LE(44100, 24); bytes.writeUInt32LE(176400, 28); bytes.writeUInt16LE(4, 32); bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36); bytes.writeUInt32LE(bytes.length - 44, 40); return bytes;
}
async function settledUsage(origin, id, charged) {
  let receipt;
  for (let i = 0; i < (charged ? 150 : 1); i++) {
    const response = await fetch(origin + "/v1/usage", { headers: { authorization: `Bearer clawrouter-live-${id}-fixture-secret` } });
    assert.equal(response.status, 200); receipt = await response.json();
    if (receipt.usage.events.length || !charged) return receipt;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return receipt;
}
function routerFixture() {
  return `import handler from "./worker/index.ts"; export * from "./worker/index.ts";
    const requests = [];
    export default { ...handler, async fetch(request, env, context) {
      const path = new URL(request.url).pathname;
      if (path === "/fixture/requests") return Response.json(requests);
      if (path !== "/v1/usage") requests.push({ path, method: request.method, authorization: request.headers.get("authorization"), vendorKey: request.headers.get("x-goog-api-key"), otherKey: request.headers.get("x-api-key"), acceptEncoding: request.cf?.clientAcceptEncoding ?? request.headers.get("accept-encoding"), body: request.method === "POST" ? await request.clone().json() : null });
      if (path === "/fixture/alternate") return new Response("unexpected alternate");
      const response = await handler.fetch(request, { ...env, GOOGLE_API_KEY: "fixture-original-google-key" }, context);
      const id = /^Bearer clawrouter-live-([^-]+)-/.exec(request.headers.get("authorization") ?? "")?.[1] ?? "";
      if (path !== "/v1/catalog" || !response.ok || !(id.endsWith("_stale") || id.endsWith("_foreign"))) return response;
      const catalog = await response.json();
      // Explicit malformed-discovery cases must fail before any paid POST.
      if (id.endsWith("_stale")) catalog.observedAt = new Date(Date.now() - 61000).toISOString();
      if (id.endsWith("_foreign")) for (const provider of catalog.providers) for (const offer of provider.offers) offer.route = "https://foreign.example/music";
      return Response.json(catalog, response);
    } };`;
}
function upstreamFixture(audio) {
  return `const calls = [], audio = ${JSON.stringify(audio)};
    export default { async fetch(request) {
      if (request.url === "https://fixture.example/state") return Response.json(calls);
      const body = await request.json(), text = body.contents[0].parts[0].text;
      calls.push({ url: request.url, method: request.method, redirect: request.redirect, headers: Object.fromEntries(request.headers), body });
      if (text.includes("_error")) return Response.json({ error: { message: "fixture-private-error" } }, { status: 429 });
      if (text.includes("_eof")) return new Response('{"candidates":[', { headers: { "content-type": "application/json" } });
      const pro = request.url.includes("lyria-3-pro-preview"), parts = [{ text: "Synthetic final lyrics" }];
      if (!text.includes("_text")) parts.push({ inlineData: { mimeType: pro ? "audio/wav" : "audio/mpeg", data: pro ? audio.wav : audio.mp3 } });
      const data = new TextEncoder().encode(JSON.stringify({ candidates: [{ finishReason: "STOP", content: { role: "model", parts } }], usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 100, totalTokenCount: 112 } }));
      const chunks = [data.subarray(0, 7), data.subarray(7, 31), data.subarray(31)];
      return new Response(new ReadableStream({ pull(controller) { const chunk = chunks.shift(); if (chunk) controller.enqueue(chunk); else controller.close(); } }, { highWaterMark: 0 }), { headers: { "content-type": "application/json" } });
    } };`;
}
