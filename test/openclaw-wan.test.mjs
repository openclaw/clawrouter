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
const ids = ["complete", "empty", "unknown", "budget", "denied"];

test("actual Alibaba video host through real Worker lifecycle and SQLite", { skip: !source, timeout: 300_000 }, async t => {
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-openclaw-wan-"));
  const { startWorkerdFixture } = await import("./helpers/workerd.mjs");
  let mf;
  try {
    mf = await startWorkerdFixture(temporary, routerFixture(), upstreamFixture());
    const kv = await mf.getKVNamespace("POLICY_KV", "router");
    for (const id of ids) {
      await kv.put(`policies/wan_${id}`, JSON.stringify({ enabled: true, generation: "fixture", providers: id === "denied" ? ["openai"] : ["alibaba"], models: null,
        tenantId: "fixture", monthlyBudgetMicros: 100, requestCostMicros: id === "budget" ? null : 7, budgetMode: "reserve", retainRequestContent: false }));
      await kv.put(`credentials/wan_${id}`, JSON.stringify({ enabled: true, secretSha256: createHash("sha256").update("fixture-secret").digest("hex"), policyId: `wan_${id}`, policyGeneration: "fixture" }));
    }
    await kv.put("connections/alibaba", JSON.stringify({ providerId: "alibaba", enabled: true }));
    const origin = String(await mf.ready).replace(/\/$/, ""), upstream = await mf.getWorker("upstream");
    await upstream.fetch("https://fixture.example/config", { method: "POST", body: origin });
    await runOpenClawConsumer(t, { source, sourceHead, fixture: new URL("./fixtures/openclaw-wan-contract.test.ts", import.meta.url),
      testPath: "src/video-generation/worker-contract.test.ts", env: { CLAWROUTER_CONTRACT_ORIGIN: origin, CLAWROUTER_CONTRACT_VIDEO_BASE64: video.base64 } });
    const calls = await (await upstream.fetch("https://fixture.example/state")).json();
    const posts = calls.filter(call => call.method === "POST");
    assert.equal(posts.length, 3, "denied calls never dispatch; native failures never replay creation");
    for (const id of ["complete", "empty", "unknown"]) {
      const post = posts.find(call => call.body.input.prompt === `Synthetic ${id}`); assert.ok(post);
      assert.equal(post.url, "https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis");
      assert.deepEqual(post.body, { model: "wan2.6-t2v", input: { prompt: `Synthetic ${id}` }, parameters: { size: "1280*720", duration: 5, watermark: true } });
      assert.equal(post.headers["x-dashscope-async"], "enable");
      assert.ok(calls.some(call => call.method === "GET" && call.url === `https://dashscope-intl.aliyuncs.com/api/v1/tasks/wan_${id}`));
      const receipt = await settledUsage(origin, id);
      assert.equal(receipt.usage.events.length, 1); const [event] = receipt.usage.events;
      assert.equal(event.provider, "alibaba"); assert.equal(event.credential_id, `wan_${id}`); assert.equal(event.policy_id, `wan_${id}`);
      assert.equal(event.actual_cost_micros, 7); assert.equal(event.cost_basis, "policy_fixed");
      assert.equal(event.total_tokens, null); assert.equal(receipt.budget.spentMicros, 7);
      assert.doesNotMatch(JSON.stringify(event), /Synthetic|fixture-upstream|fixture-secret/);
    }
    for (const call of calls) {
      assert.equal(call.headers.authorization, "Bearer fixture-upstream-standard-key");
      assert.equal(new URL(call.url).origin, "https://dashscope-intl.aliyuncs.com"); assert.equal(call.redirect, "manual");
      assert.doesNotMatch(JSON.stringify(call), /clawrouter-live-/);
    }
    const incoming = await (await fetch(origin + "/fixture/requests")).json();
    for (const call of incoming.filter(call => call.path.startsWith("/v1/native/"))) {
      assert.match(call.authorization, /^Bearer clawrouter-live-wan_[a-z]+-fixture-secret$/);
      assert.equal(call.vendorKey, null);
    }
    const downloads = incoming.filter(call => call.path === "/fixture/output");
    assert.equal(downloads.length, 1); assert.equal(downloads[0].authorization, null, "video URL downloads do not carry the proxy key");
    const before = calls.length;
    const again = await fetch(origin + "/v1/native/alibaba/api/v1/tasks/wan_unknown", { headers: { authorization: "Bearer clawrouter-live-wan_unknown-fixture-secret" } });
    assert.equal(again.status, 410);
    assert.equal((await (await upstream.fetch("https://fixture.example/state")).json()).length, before, "observation loss prevents further upstream polling");
    for (const id of ["budget", "denied"]) {
      const receipt = await usage(origin, id); assert.equal(receipt.budget.spentMicros, 0);
      assert.ok(receipt.usage.events.every(event => event.actual_cost_micros === 0));
    }
  } finally { await mf?.dispose(); await rm(temporary, { recursive: true, force: true }); }
});

async function usage(origin, id) {
  const response = await fetch(origin + "/v1/usage", { headers: { authorization: `Bearer clawrouter-live-wan_${id}-fixture-secret` } });
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
      return handler.fetch(request, { ...env, MODELSTUDIO_API_KEY: "fixture-upstream-standard-key" }, context);
    } };`;
}
function upstreamFixture() {
  return `const calls = []; let origin;
    export default { async fetch(request) {
      if (request.url === "https://fixture.example/config") { origin = await request.text(); return new Response("ok"); }
      if (request.url === "https://fixture.example/state") return Response.json(calls);
      const body = request.method === "POST" ? await request.json() : null;
      calls.push({ url: request.url, method: request.method, headers: Object.fromEntries(request.headers), redirect: request.redirect, body });
      const id = body ? "wan_" + body.input.prompt.slice("Synthetic ".length) : new URL(request.url).pathname.split("/").at(-1);
      return Response.json({ output: { task_id: id, task_status: body ? "PENDING" : id === "wan_unknown" ? "UNKNOWN" : "SUCCEEDED",
        ...(!body && id === "wan_complete" ? { video_url: origin + "/fixture/output" } : {}) } });
    } };`;
}
