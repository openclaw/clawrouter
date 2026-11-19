import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runOpenClawConsumer } from "./helpers/openclaw-consumer.mjs";

const source = process.env.CLAWROUTER_OPENCLAW_CHECKOUT;
const sourceHead = "d8bb939408aa4d2be7df0161748edb52ebf3b1fb";
const video = JSON.parse(readFileSync(new URL("./fixtures/wan-output.json", import.meta.url)));
const cases = [{ id: "gen45", model: "gen4.5", duration: 5 },
  ...["veo3.1", "veo3.1_fast"].flatMap(model => [4, 6, 8].map(duration => ({ id: model === "veo3.1" ? `veo${duration}` : `fast${duration}`, model, duration })))];
const created = [...cases, ...["empty", "failed", "private"].map(id => ({ id, model: "gen4.5", duration: 5 }))]
  .map((entry, i) => ({ ...entry, task: "00000000-0000-4000-8000-" + String(i + 1).padStart(12, "0") }));
const ids = [...created.map(entry => entry.id), "budget", "denied"];

test("actual Runway video host through real Worker lifecycle and SQLite", { skip: !source, timeout: 300_000 }, async t => {
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-openclaw-runway-"));
  const { startWorkerdFixture } = await import("./helpers/workerd.mjs");
  let mf;
  try {
    mf = await startWorkerdFixture(temporary, routerFixture(), upstreamFixture());
    const kv = await mf.getKVNamespace("POLICY_KV", "router");
    for (const id of ids) {
      await kv.put(`policies/runway_${id}`, JSON.stringify({ enabled: true, generation: "fixture", providers: id === "denied" ? ["openai"] : ["runway"], models: null,
        tenantId: "fixture", monthlyBudgetMicros: 100, requestCostMicros: id === "budget" ? null : 7, budgetMode: "reserve", retainRequestContent: false }));
      await kv.put(`credentials/runway_${id}`, JSON.stringify({ enabled: true, secretSha256: createHash("sha256").update("fixture-secret").digest("hex"), policyId: `runway_${id}`, policyGeneration: "fixture" }));
    }
    await kv.put("connections/runway", JSON.stringify({ providerId: "runway", enabled: true }));
    const origin = String(await mf.ready).replace(/\/$/, ""), upstream = await mf.getWorker("upstream");
    await upstream.fetch("https://fixture.example/config", { method: "POST", body: origin });
    await runOpenClawConsumer(t, { source, sourceHead, fixture: new URL("./fixtures/openclaw-runway-contract.test.ts", import.meta.url),
      testPath: "src/video-generation/worker-contract.test.ts", env: { CLAWROUTER_CONTRACT_ORIGIN: origin, CLAWROUTER_CONTRACT_VIDEO_BASE64: video.base64 } });
    const calls = await (await upstream.fetch("https://fixture.example/state")).json();
    const posts = calls.filter(call => call.method === "POST");
    assert.equal(posts.length, created.length, "denied calls never dispatch; native failures never replay creation");
    for (const { id, model, duration, task } of created) {
      const post = posts.find(call => call.body.promptText === `Synthetic ${id}`); assert.ok(post);
      assert.equal(post.url, "https://api.dev.runwayml.com/v1/text_to_video");
      assert.deepEqual(post.body, { model, promptText: `Synthetic ${id}`, ratio: "1280:720", duration });
      assert.ok(calls.some(call => call.method === "GET" && call.url === `https://api.dev.runwayml.com/v1/tasks/${task}`));
      const receipt = await settledUsage(origin, id);
      assert.equal(receipt.usage.events.length, 1); const [event] = receipt.usage.events;
      assert.equal(event.provider, "runway"); assert.equal(event.credential_id, `runway_${id}`); assert.equal(event.policy_id, `runway_${id}`);
      assert.equal(event.actual_cost_micros, 7); assert.equal(event.cost_basis, "policy_fixed");
      assert.equal(event.total_tokens, null); assert.equal(receipt.budget.spentMicros, 7);
      assert.doesNotMatch(JSON.stringify(event), /Synthetic|fixture-upstream|fixture-secret/);
    }
    for (const call of calls) {
      assert.equal(call.headers.authorization, "Bearer fixture-upstream-runway-key");
      assert.equal(call.headers["x-runway-version"], "2024-11-06");
      assert.equal(new URL(call.url).origin, "https://api.dev.runwayml.com"); assert.equal(call.redirect, "manual");
      assert.doesNotMatch(JSON.stringify(call), /clawrouter-live-/);
    }
    const incoming = await (await fetch(origin + "/fixture/requests")).json();
    for (const call of incoming.filter(call => call.path.startsWith("/v1/native/"))) {
      assert.match(call.authorization, /^Bearer clawrouter-live-runway_[a-z0-9]+-fixture-secret$/);
      assert.equal(call.vendorKey, null);
    }
    const downloads = incoming.filter(call => call.path === "/fixture/output");
    assert.equal(incoming.filter(call => call.path === "/fixture/private-output").length, 0, "strict result SSRF rejection happens before private output fetch");
    assert.equal(downloads.length, cases.length); assert.ok(downloads.every(call => call.authorization === null), "video URL downloads do not carry the proxy key");
    for (const id of ["budget", "denied"]) {
      const receipt = await usage(origin, id); assert.equal(receipt.budget.spentMicros, 0);
      assert.ok(receipt.usage.events.every(event => event.actual_cost_micros === 0));
    }
  } finally { await mf?.dispose(); await rm(temporary, { recursive: true, force: true }); }
});

async function usage(origin, id) {
  const response = await fetch(origin + "/v1/usage", { headers: { authorization: `Bearer clawrouter-live-runway_${id}-fixture-secret` } });
  assert.equal(response.status, 200); return response.json();
}
async function settledUsage(origin, id) {
  let result;
  for (let i = 0; i < 200; i++) {
    result = await usage(origin, id); if (result.usage.events.length) return result;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return result;
}
function routerFixture() {
  return `import handler from "./worker/index.ts"; export * from "./worker/index.ts";
    const requests = [], video = Uint8Array.from(atob(${JSON.stringify(video.base64)}), c => c.charCodeAt(0));
    export default { ...handler, fetch(request, env, context) {
      const path = new URL(request.url).pathname;
      if (path === "/fixture/requests") return Response.json(requests);
      if (path !== "/v1/usage") requests.push({ path, method: request.method, authorization: request.headers.get("authorization"), vendorKey: request.headers.get("x-api-key") });
      if (path === "/fixture/output") return new Response(video, { headers: { "content-type": "video/mp4" } });
      return handler.fetch(request, { ...env, RUNWAYML_API_SECRET: "fixture-upstream-runway-key" }, context);
    } };`;
}
function upstreamFixture() {
  return `const calls = [], jobs = ${JSON.stringify(created)}; let origin;
    export default { async fetch(request) {
      if (request.url === "https://fixture.example/config") { origin = await request.text(); return new Response("ok"); }
      if (request.url === "https://fixture.example/state") return Response.json(calls);
      const body = request.method === "POST" ? await request.json() : null;
      calls.push({ url: request.url, method: request.method, headers: Object.fromEntries(request.headers), redirect: request.redirect, body });
      const job = body ? jobs.find(job => body.promptText === "Synthetic " + job.id) : jobs.find(job => request.url.endsWith("/" + job.task));
      if (!job) return new Response("unknown fixture task", { status: 404 });
      return Response.json(body ? { id: job.task } : { id: job.task, status: job.id === "failed" ? "FAILED" : "SUCCEEDED",
        ...(job.id === "failed" ? { failure: "Synthetic failure" } : { output: job.id === "empty" ? [] : [job.id === "private" ? origin + "/fixture/private-output" : "https://93.184.216.34/clawrouter-runway-fixture.mp4"] }) });
    } };`;
}
