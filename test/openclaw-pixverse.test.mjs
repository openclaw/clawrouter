import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runOpenClawConsumer } from "./helpers/openclaw-consumer.mjs";
const source = process.env.CLAWROUTER_OPENCLAW_CHECKOUT;
const sourceHead = "d8bb939408aa4d2be7df0161748edb52ebf3b1fb";
const jobs = { v6: 1001, c1: 1002, empty: 1003, deleted: 1004 };

test("actual PixVerse video host through real Worker lifecycle and SQLite", { skip: !source, timeout: 300_000 }, async t => {
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-openclaw-pixverse-"));
  const { startWorkerdFixture } = await import("./helpers/workerd.mjs"); let mf;
  try {
    mf = await startWorkerdFixture(temporary, routerFixture(), upstreamFixture());
    const kv = await mf.getKVNamespace("POLICY_KV", "router");
    for (const id of [...Object.keys(jobs), "budget", "denied"]) {
      await kv.put(`policies/pixverse_${id}`, JSON.stringify({ enabled: true, generation: "fixture", providers: id === "denied" ? ["openai"] : ["pixverse"], models: null,
        tenantId: "fixture", monthlyBudgetMicros: 100, requestCostMicros: id === "budget" ? null : 7, budgetMode: "reserve", retainRequestContent: false }));
      await kv.put(`credentials/pixverse_${id}`, JSON.stringify({ enabled: true, secretSha256: createHash("sha256").update("fixture-secret").digest("hex"), policyId: `pixverse_${id}`, policyGeneration: "fixture" }));
    }
    await kv.put("connections/pixverse", JSON.stringify({ providerId: "pixverse", enabled: true }));
    const origin = String(await mf.ready).replace(/\/$/, ""), upstream = await mf.getWorker("upstream");
    await runOpenClawConsumer(t, { source, sourceHead, fixture: new URL("./fixtures/openclaw-pixverse-contract.test.ts", import.meta.url),
      testPath: "src/video-generation/worker-contract.test.ts", env: { CLAWROUTER_CONTRACT_ORIGIN: origin } });
    const calls = await (await upstream.fetch("https://fixture.example/state")).json(), posts = calls.filter(call => call.method === "POST");
    assert.equal(posts.length, 4, "denied calls never dispatch and native failures never replay creation");
    for (const [id, task] of Object.entries(jobs)) {
      const post = posts.find(call => call.body.prompt === `Synthetic ${id}`); assert.ok(post);
      assert.equal(post.url, "https://app-api.pixverse.ai/openapi/v2/video/text/generate");
      assert.deepEqual(post.body, { model: id === "c1" ? "c1" : "v6", prompt: `Synthetic ${id}`, duration: 5, quality: "540p", aspect_ratio: "16:9", seed: 0, generate_audio_switch: false });
      assert.ok(calls.some(call => call.method === "GET" && call.url === `https://app-api.pixverse.ai/openapi/v2/video/result/${task}`));
      const receipt = await settledUsage(origin, id); assert.equal(receipt.usage.events.length, 1); const [event] = receipt.usage.events;
      assert.equal(event.provider, "pixverse"); assert.equal(event.credential_id, `pixverse_${id}`); assert.equal(event.policy_id, `pixverse_${id}`);
      assert.equal(event.actual_cost_micros, 7); assert.equal(event.cost_basis, "policy_fixed");
      assert.equal(event.total_tokens, null); assert.equal(receipt.budget.spentMicros, 7);
      assert.doesNotMatch(JSON.stringify(event), /Synthetic|fixture-upstream|fixture-secret/);
    }
    const incoming = await (await fetch(origin + "/fixture/requests")).json();
    assert.ok(incoming.every(call => call.path.startsWith("/v1/native/pixverse/openapi/v2/")));
    const callerTraces = new Set(incoming.map(call => call.trace));
    for (const call of incoming) {
      assert.match(call.key, /^clawrouter-live-pixverse_[a-z0-9]+-fixture-secret$/); assert.equal(call.authorization, null);
    }
    const traces = calls.map(call => call.headers["ai-trace-id"]); assert.equal(new Set(traces).size, calls.length);
    for (const call of calls) {
      assert.equal(call.headers["api-key"], "fixture-upstream-pixverse-key"); assert.equal(call.headers.authorization, undefined);
      assert.equal(new URL(call.url).origin, "https://app-api.pixverse.ai"); assert.equal(call.redirect, "manual");
      assert.match(call.headers["ai-trace-id"], /^[a-f0-9-]{36}$/); assert.equal(callerTraces.has(call.headers["ai-trace-id"]), false);
      assert.doesNotMatch(JSON.stringify(call), /clawrouter-live-/);
    }
    for (const id of ["budget", "denied"]) {
      const receipt = await usage(origin, id); assert.equal(receipt.budget.spentMicros, 0);
      assert.ok(receipt.usage.events.every(event => event.actual_cost_micros === 0));
    }
  } finally { await mf?.dispose(); await rm(temporary, { recursive: true, force: true }); }
});
async function usage(origin, id) {
  const response = await fetch(origin + "/v1/usage", { headers: { authorization: `Bearer clawrouter-live-pixverse_${id}-fixture-secret` } });
  assert.equal(response.status, 200); return response.json();
}
async function settledUsage(origin, id) {
  let result;
  for (let i = 0; i < 200; i++) { result = await usage(origin, id); if (result.usage.events.length) return result; await new Promise(resolve => setTimeout(resolve, 50)); }
  return result;
}
function routerFixture() {
  return `import handler from "./worker/index.ts"; export * from "./worker/index.ts";
    const requests = [];
    export default { ...handler, fetch(request, env, context) {
      const path = new URL(request.url).pathname;
      if (path === "/fixture/requests") return Response.json(requests);
      if (path !== "/v1/usage") requests.push({ path, method: request.method, authorization: request.headers.get("authorization"), key: request.headers.get("api-key"), trace: request.headers.get("ai-trace-id") });
      return handler.fetch(request, { ...env, PIXVERSE_API_KEY: "fixture-upstream-pixverse-key" }, context);
    } };`;
}
function upstreamFixture() {
  return `const calls = [], jobs = ${JSON.stringify(jobs)};
    export default { async fetch(request) {
      if (request.url === "https://fixture.example/state") return Response.json(calls);
      const body = request.method === "POST" ? await request.json() : null;
      calls.push({ url: request.url, method: request.method, headers: Object.fromEntries(request.headers), redirect: request.redirect, body });
      if (body) return Response.json({ ErrCode: 0, Resp: { video_id: jobs[body.prompt.slice("Synthetic ".length)], credits: 35 } });
      const id = Number(new URL(request.url).pathname.split("/").at(-1));
      return Response.json({ ErrCode: 0, Resp: { video_id: id, status: id === 1004 ? 6 : 1,
        ...(id <= 1002 ? { url: "https://media.example/pixverse-" + id + ".mp4" } : {}) } });
    } };`;
}
