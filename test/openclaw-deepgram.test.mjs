import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import snapshot from "../worker/generated/provider-snapshot.json" with { type: "json" };
import { runOpenClawConsumer } from "./helpers/openclaw-consumer.mjs";

const source = process.env.CLAWROUTER_OPENCLAW_CHECKOUT;
const sourceHead = "0066d51dff16526f9a3aa46c534047aba2632918";
const success = ["tracks", "silent", "repeat"];
const dispatched = [...success, "malformed", "eof", "mime", "error", "redirect", "cancel"].map(name => "deepgram_" + name);
const denied = ["deepgram_denied", "deepgram_budget", "deepgram_invalid"];
const audioSha256 = "5efcd8ff93f78a2a9177e4db8b767662c7feb49aec41238f78fad5ceb6d635ed";

test("actual registered Deepgram native raw audio through workerd and SQLite", { skip: !source, timeout: 300_000 }, async t => {
  const provider = snapshot.providers.find(provider => provider.id === "deepgram");
  assert.ok(provider.endpoints.some(endpoint => endpoint.id === "listen" && endpoint.request_format === "deepgram.prerecorded"));
  assert.equal(provider.models.find(model => model.id === "deepgram/nova-3").pricing, null);
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-openclaw-deepgram-"));
  const network = await pendingJsonSource();
  const { startWorkerdFixture } = await import("./helpers/workerd.mjs");
  let mf;
  try {
    mf = await startWorkerdFixture(temporary, routerFixture(), upstreamFixture(network.url),
      { bindings: { DEEPGRAM_API_KEY: "fixture-upstream-deepgram-key" } });
    const kv = await mf.getKVNamespace("POLICY_KV", "router");
    for (const id of [...dispatched, ...denied]) {
      await kv.put("policies/" + id, JSON.stringify({
        enabled: true, generation: "fixture", providers: id === "deepgram_denied" ? ["openai"] : ["deepgram"],
        models: ["deepgram/nova-3"], tenantId: "fixture", monthlyBudgetMicros: 100,
        requestCostMicros: id === "deepgram_budget" ? null : 7, budgetMode: "reserve", retainRequestContent: false,
      }));
      await kv.put("credentials/" + id, JSON.stringify({
        enabled: true, secretSha256: createHash("sha256").update("fixture-secret").digest("hex"), policyId: id, policyGeneration: "fixture",
      }));
    }
    await kv.put("connections/deepgram", JSON.stringify({ providerId: "deepgram", enabled: true }));
    const origin = String(await mf.ready).replace(/\/$/, "");
    await runOpenClawConsumer(t, {
      source, sourceHead, fixture: new URL("./fixtures/openclaw-deepgram-contract.test.ts", import.meta.url),
      testPath: "extensions/clawrouter/worker-contract.test.ts", env: { CLAWROUTER_CONTRACT_ORIGIN: origin },
    });
    const state = await readJson(origin + "/fixture/state");
    const posts = state.requests.filter(call => call.method === "POST");
    assert.equal(state.calls.length, dispatched.length, "invalid inputs never egress; dispatched audio is not replayed");
    assert.equal(posts.length, dispatched.length);
    for (const call of state.requests) {
      assert.match(call.authorization, /^Bearer clawrouter-live-deepgram_[a-z]+-(?:fixture-secret|invalid)$/);
      assert.equal(call.otherKey, null, "client vendor keys cannot cross the proxy boundary");
    }
    for (const id of dispatched) {
      const calls = state.calls.filter(call => call.id === id);
      assert.equal(calls.length, 1, id);
      const [call] = calls, url = new URL(call.url);
      assert.equal(url.origin + url.pathname, "https://api.deepgram.com/v1/listen");
      assert.equal(url.searchParams.get("model"), "nova-3"); assert.equal(url.searchParams.get("language"), "en");
      assert.equal(url.searchParams.get("punctuate"), "false"); assert.equal(url.searchParams.get("multichannel"), "true");
      assert.deepEqual(url.searchParams.getAll("keyterm"), ["synthetic one", "synthetic two"]); assert.deepEqual(url.searchParams.getAll("tag"), [id]);
      assert.equal(call.method, "POST"); assert.equal(call.redirect, "manual");
      assert.equal(call.headers.authorization, "Token fixture-upstream-deepgram-key");
      assert.equal(call.headers["x-api-key"], undefined); assert.equal(call.headers["content-type"], "audio/wav");
      assert.equal(call.audioBytes, 2048, "playable input must pass the actual host size filter and reach upstream");
      assert.equal(call.audioSha256, audioSha256, "source-owned PCM WAV bytes remain unchanged");
      assert.doesNotMatch(JSON.stringify(call), /clawrouter-live-|must-not-forward|never-router/);
      const post = posts.find(call => call.authorization === "Bearer clawrouter-live-" + id + "-fixture-secret");
      assert.equal(post?.path, "/v1/native/deepgram/v1/listen");
      assert.ok(state.requests.some(call => call.path === "/v1/catalog" && call.authorization === post.authorization));
      const usage = await settledUsage(origin, id), [event] = usage.usage.events;
      assert.equal(usage.usage.events.length, 1, "one original caller receives exactly one durable receipt");
      assert.equal(event.provider, "deepgram"); assert.equal(event.model, "deepgram/nova-3"); assert.equal(event.capability, "audio.transcription");
      assert.equal(event.credential_id, id); assert.equal(event.policy_id, id);
      // A received 307 owns the existing rejection classification even though
      // the router delivers sanitized 502 and never follows the redirect.
      const rejected = id === "deepgram_cancel" || id === "deepgram_redirect";
      assert.equal(event.status, rejected ? "client_error" : success.includes(id.slice(9)) ? "success" : "provider_error", id);
      assert.equal(event.status_code, id === "deepgram_cancel" ? 499 : success.includes(id.slice(9)) ? 200 : 502, id);
      assert.equal(event.actual_cost_micros, 7); assert.equal(event.cost_basis, "policy_fixed"); assert.equal(usage.budget.spentMicros, 7);
      assert.equal(event.content_retained, false);
      for (const field of ["input_tokens", "output_tokens", "total_tokens"]) assert.equal(event[field], null, "duration and channels are not tokens");
      assert.doesNotMatch(JSON.stringify(event), /synthetic one|fixture-upstream|fixture-secret|never-router/);
    }
    for (const id of denied) {
      const usage = await readUsage(origin, id);
      assert.equal(usage.budget.spentMicros, 0); assert.ok(usage.usage.events.every(event => event.actual_cost_micros === 0));
    }
    const final = await readJson(origin + "/fixture/state"), canceled = final.calls.find(call => call.id === "deepgram_cancel");
    assert.equal(canceled.canceled, true); assert.equal(canceled.bytes, 11); assert.equal(canceled.activeReads, 0);
    assert.equal(final.control.injected, true); assert.equal(final.control.status, 499); assert.equal(final.control.pending, false);
    assert.equal(final.capacity, 0); await network.closed;
    assert.deepEqual(network.metrics, { requests: 1, bytes: 11, closed: 1 });
    t.diagnostic("native host abort and controlled incoming Worker cleanup are separate; physical pre-header disconnect propagation is not certified");
  } finally { await mf?.dispose(); await network.close(); await rm(temporary, { recursive: true, force: true }); }
});
async function readJson(url, headers) {
  const response = await fetch(url, { headers }); assert.equal(response.status, 200); return response.json();
}
function readUsage(origin, id) {
  return readJson(origin + "/v1/usage", { authorization: "Bearer clawrouter-live-" + id + "-fixture-secret" });
}
async function settledUsage(origin, id) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = await readUsage(origin, id); if (value.usage.events.length) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail("original transcription receipt did not settle: " + id);
}
async function pendingJsonSource() {
  const metrics = { requests: 0, bytes: 0, closed: 0 }, sockets = new Set();
  let finish; const closed = new Promise(resolve => { finish = resolve; });
  const server = createServer((request, response) => {
    metrics.requests++; response.on("close", () => { metrics.closed++; finish(); });
    response.writeHead(200, { "content-type": "application/json" });
    response.write('{"results":'); metrics.bytes += 11;
  });
  server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return { metrics, closed, url: "http://127.0.0.1:" + server.address().port + "/pending",
    async close() { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); } };
}

function routerFixture() {
  return `import handler from "./worker/index.ts"; export * from "./worker/index.ts";
    import { bodyBudgetCharged } from "./worker/body-budget.ts";
    const requests = [], control = { pending: false, injected: false }; let caller, original;
    export default { ...handler, async fetch(request, env, context) {
      const path = new URL(request.url).pathname;
      if (path === "/fixture/state") {
        const calls = await (await fetch("https://fixture.example/state")).json();
        return Response.json({ requests, calls, control, capacity: bodyBudgetCharged() });
      }
      if (path === "/fixture/abort") {
        const calls = await (await fetch("https://fixture.example/state")).json();
        const active = calls.find(call => call.id === "deepgram_cancel");
        if (request.method !== "POST" || !control.pending || control.injected || !caller || caller.signal.aborted
          || !original || original.signal.aborted || active?.status !== 200 || active?.bytes !== 11 || active?.activeReads !== 1)
          return new Response("original pending read unavailable", { status: 409 });
        control.injected = true; caller.abort(new DOMException("controlled incoming cancellation", "AbortError"));
        return Response.json({ injected: true });
      }
      if (path !== "/v1/usage") requests.push({ path, method: request.method, authorization: request.headers.get("authorization"), otherKey: request.headers.get("x-api-key") });
      if (request.method === "POST" && request.headers.get("authorization") === "Bearer clawrouter-live-deepgram_cancel-fixture-secret") {
        caller = new AbortController(); original = request;
        request = new Request(request, { signal: AbortSignal.any([request.signal, caller.signal]) });
        control.pending = true;
        try { const response = await handler.fetch(request, env, context); control.status = response.status; return response; }
        finally { control.pending = false; }
      }
      return handler.fetch(request, env, context);
    } };`;
}
function upstreamFixture(pendingUrl) {
  return `const calls = [];
    export default { async fetch(request) {
      if (request.url === "https://fixture.example/state") return Response.json(calls);
      const url = new URL(request.url), id = url.searchParams.get("tag"), audio = await request.arrayBuffer();
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", audio))).map(value => value.toString(16).padStart(2, "0")).join("");
      const call = { id, url: request.url, method: request.method, redirect: request.redirect, headers: Object.fromEntries(request.headers), audioBytes: audio.byteLength, audioSha256: digest, status: 200, bytes: 0, activeReads: 0, canceled: false };
      calls.push(call);
      if (id === "deepgram_redirect") { call.status = 307; return new Response(null, { status: 307, headers: { location: "https://must-not-follow.example/listen" } }); }
      if (id === "deepgram_cancel") {
        const network = await fetch(${JSON.stringify(pendingUrl)}, { signal: request.signal }), reader = network.body.getReader();
        return new Response(new ReadableStream({ async pull(controller) {
          call.activeReads++;
          try {
            const part = await reader.read(); if (call.canceled) return;
            if (part.done) { reader.releaseLock(); controller.close(); return; }
            call.bytes += part.value.byteLength; controller.enqueue(part.value);
          } finally { call.activeReads--; }
        }, async cancel(reason) { call.canceled = true; try { await reader.cancel(reason); } finally { reader.releaseLock(); } } }, { highWaterMark: 0 }), { headers: { "content-type": "application/json" } });
      }
      const texts = id === "deepgram_silent" ? ["", "right"] : id === "deepgram_repeat" ? ["repeat", "repeat"] : [" left ", "right"];
      const payload = { metadata: { duration: 1.25, channels: 2 }, results: { channels: texts.map(transcript => ({ alternatives: [{ transcript }, { transcript: "unused alternative" }] })) } };
      if (id === "deepgram_malformed") payload.results.channels.push({ alternatives: [{}] });
      if (id === "deepgram_error") payload.err_code = "fixture-private-error";
      const encoded = new TextEncoder().encode(JSON.stringify(payload)), chunks = [encoded.subarray(0, 3), encoded.subarray(3, 19), encoded.subarray(19)];
      return new Response(new ReadableStream({ pull(controller) {
        if (id === "deepgram_eof" && chunks.length === 1) { chunks.length = 0; controller.error(new Error("fixture-private-incomplete")); return; }
        const chunk = chunks.shift(); if (chunk) controller.enqueue(chunk); else controller.close();
      } }), { headers: { "content-type": id === "deepgram_mime" ? "text/plain" : "application/json", "set-cookie": "fixture-private-cookie" } });
    } };`;
}
