import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { parse } from "yaml";
import { runOpenClawConsumer } from "./helpers/openclaw-consumer.mjs";

const source = process.env.CLAWROUTER_OPENCLAW_CHECKOUT;
const sourceHead = "542958f2c02754de72361bfbdc016a724a4572f1";
const video = JSON.parse(readFileSync(new URL("./fixtures/wan-output.json", import.meta.url)));
const fixture = new URL("./fixtures/openclaw-vydra-models-contract.test.ts", import.meta.url);
const asset = "https://example.com/clawrouter-vydra-fixture.mp4";
const ids = ["kling", "veo3", "failed", "overflow", "unpriced", "missingmotion", "samereference", "credentialreference", "local", "foreign"];
const contract = "vydra.models.kling-veo3.v1";
const key = id => "clawrouter-live-vydra_" + id + "-fixture-secret";
const body = id => ({ prompt: "Synthetic " + id, ...(id === "veo3" ? {} : { image_url: "https://example.com/reference.png", video_url: "https://example.com/motion.mp4" }) });

async function invokeNative(t, origin, invoke = runOpenClawConsumer) {
  const diagnostics = [];
  await invoke({ diagnostic(message) { diagnostics.push(String(message)); t.diagnostic(message); } }, {
    source, sourceHead, fixture, testPath: "extensions/vydra/worker-models-contract.test.ts",
    env: { CLAWROUTER_CONTRACT_ORIGIN: origin, CLAWROUTER_CONTRACT_VIDEO_BASE64: video.base64, CLAWROUTER_VYDRA_MODELS_CONTRACT: contract },
  });
  const lines = diagnostics.join("\n").split("\n").map(line => line.trim());
  for (const model of ["kling", "veo3"]) assert.equal(lines.filter(line => line === "VYDRA_MODELS_RETIRED " + model).length, 1, "exact original SDK completion receipt");
}

test("Vydra native runner binds exact source, fixture, environment, receipt and unique workflow row", async () => {
  const rows = parse(readFileSync(new URL("../.github/workflows/openclaw-contract.yml", import.meta.url), "utf8")).jobs.consumer.strategy.matrix.include;
  assert.deepEqual(rows.filter(row => row.consumer === "vydra-models"), [{ consumer: "vydra-models", ref: sourceHead, test: "test/openclaw-vydra-models.test.mjs" }]);
  assert.equal(new Set(rows.map(row => row.consumer)).size, rows.length);
  const fixtureText = readFileSync(fixture, "utf8"); assert.doesNotThrow(() => stripTypeScriptTypes(fixtureText));
  assert.match(fixtureText, /CLAWROUTER_VYDRA_MODELS_CONTRACT/); assert.match(fixtureText, /generateVideo/);
  await invokeNative({ diagnostic() {} }, "https://router.example", async (t, options) => {
    assert.equal(options.sourceHead, sourceHead); assert.equal(options.fixture.href, fixture.href);
    assert.equal(options.testPath, "extensions/vydra/worker-models-contract.test.ts");
    assert.deepEqual(options.env, { CLAWROUTER_CONTRACT_ORIGIN: "https://router.example", CLAWROUTER_CONTRACT_VIDEO_BASE64: video.base64, CLAWROUTER_VYDRA_MODELS_CONTRACT: contract });
    t.diagnostic("VYDRA_MODELS_RETIRED kling\nVYDRA_MODELS_RETIRED veo3");
  });
  for (const wrong of ["", "MISTRAL_CANCEL_RETIRED", "VYDRA_MODELS_RETIRED kling\nVYDRA_MODELS_RETIRED kling"]) {
    await assert.rejects(invokeNative({ diagnostic() {} }, "https://router.example", async t => t.diagnostic(wrong)));
  }
});

async function withFixture(t, fn) {
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-vydra-models-"));
  const { startWorkerdFixture } = await import("./helpers/workerd.mjs");
  const failures = []; let mf;
  try {
    mf = await startWorkerdFixture(temporary, routerFixture(), upstreamFixture());
    const kv = await mf.getKVNamespace("POLICY_KV", "router");
    for (const id of ids) {
      await kv.put("policies/vydra_" + id, JSON.stringify({ enabled: true, generation: "fixture", providers: ["vydra"], models: null,
        tenantId: "fixture", monthlyBudgetMicros: 100, requestCostMicros: id === "unpriced" ? null : 7, budgetMode: "reserve", retainRequestContent: false }));
      await kv.put("credentials/vydra_" + id, JSON.stringify({ enabled: true, secretSha256: createHash("sha256").update("fixture-secret").digest("hex"), policyId: "vydra_" + id, policyGeneration: "fixture" }));
    }
    await kv.put("connections/vydra", JSON.stringify({ providerId: "vydra", enabled: true }));
    const origin = String(await mf.ready).replace(/\/$/, ""), upstream = await mf.getWorker("upstream");
    assert.equal((await fetch(origin + "/fixture/grants", { method: "POST" })).status, 204);
    const call = (id, path, data, method = data === undefined ? "GET" : "POST") => fetch(origin + path, { method,
      headers: { authorization: "Bearer " + key(id), "content-type": "application/json", "Idempotency-Key": id },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    await fn({ origin, upstream, call });
  } catch (error) { failures.push(error); }
  finally {
    try { await mf?.dispose(); } catch (error) { failures.push(error); }
    try { await rm(temporary, { recursive: true, force: true }); } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, "Vydra original operation and fixture retirement");
}
async function json(response, status = 200) { const text = await response.text(); assert.equal(response.status, status, text); return JSON.parse(text); }
async function usage(origin, id, expected) {
  let result;
  for (let i = 0; i < 200; i++) {
    result = await json(await fetch(origin + "/v1/usage", { headers: { authorization: "Bearer " + key(id) } }));
    if (expected === undefined || result.usage.events.length >= expected) return result;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return result;
}
function assertReceipt(result, id, amount) {
  assert.equal(result.usage.events.length, 1); const event = result.usage.events[0];
  assert.deepEqual([event.provider, event.credential_id, event.policy_id, event.actual_cost_micros, event.cost_basis], ["vydra", "vydra_" + id, "vydra_" + id, amount, "policy_fixed"]);
  assert.deepEqual([event.input_tokens, event.output_tokens, event.total_tokens], [null, null, null]);
  assert.equal(result.budget.spentMicros, amount);
  assert.doesNotMatch(JSON.stringify(event), /Synthetic|fixture-upstream|fixture-secret/);
}

test("actual Workerd keeps Models original GET, pending output, financial and foreign-control boundaries", { timeout: 30000 }, async t => {
  await withFixture(t, async ({ origin, upstream, call }) => {
    const created = await json(await call("local", "/v1/native/vydra/api/v1/models/kling", body("local")), 202);
    assert.equal(created.jobId, "vydra_local"); assert.equal(created.outputUrl, undefined);
    assert.equal((await call("foreign", "/v1/native/vydra/api/v1/jobs/vydra_local")).status, 409);
    assert.equal((await call("local", "/v1/native/vydra/api/v1/jobs/vydra_local", undefined, "DELETE")).status, 409);
    const pending = await json(await call("local", "/v1/native/vydra/api/v1/jobs/vydra_local")); assert.equal(pending.output, undefined);
    const completed = await json(await call("local", "/v1/native/vydra/api/v1/jobs/vydra_local")); assert.equal(completed.output.videoUrl, asset);
    assertReceipt(await usage(origin, "local", 1), "local", 7);
    assert.equal((await call("unpriced", "/v1/native/vydra/api/v1/models/kling", body("unpriced"))).status, 400);
    const calls = await json(await upstream.fetch("https://fixture.example/state"));
    assert.equal(calls.length, 3); assert.deepEqual(calls.map(row => row.method), ["POST", "GET", "GET"]);
    assert.equal(calls[0].url, "https://www.vydra.ai/api/v1/models/kling"); assert.deepEqual(calls[0].body, body("local"));
    assert.ok(calls.every(row => row.headers.authorization === "Bearer fixture-upstream-vydra-key" && row.redirect === "manual"));
    const denied = await usage(origin, "unpriced"); assert.equal(denied.budget.spentMicros, 0); assert.equal(denied.usage.events.length, 0);
  });
});

test("actual registered Vydra SDK Models through Worker and SQLite", { skip: !source, timeout: 300000 }, async t => {
  await withFixture(t, async ({ origin, upstream }) => {
    await invokeNative(t, origin);
    const calls = await json(await upstream.fetch("https://fixture.example/state"));
    for (const id of ["kling", "veo3", "failed", "overflow"]) {
      const posts = calls.filter(row => row.body?.prompt === "Synthetic " + id);
      assert.equal(posts.length, 1, "exactly one original create without retries");
      assert.deepEqual(posts[0].body, body(id));
      assert.equal(posts[0].url, "https://www.vydra.ai/api/v1/models/" + (id === "veo3" ? "veo3" : "kling"));
      const gets = calls.filter(row => row.method === "GET" && row.url.endsWith("/vydra_" + id));
      assert.equal(gets.length, 2);
      assertReceipt(await usage(origin, id, 1), id, 7);
    }
    assert.equal(calls.length, 12);
    for (const row of calls) {
      assert.equal(row.headers.authorization, "Bearer fixture-upstream-vydra-key"); assert.equal(row.redirect, "manual");
      assert.doesNotMatch(JSON.stringify(row), /clawrouter-live-|must-not-fallback/);
    }
    const requests = await json(await fetch(origin + "/fixture/requests"));
    const downloads = requests.filter(row => row.path === "/fixture/output");
    assert.equal(downloads.length, 3); assert.ok(downloads.every(row => row.authorization === null));
    for (const row of requests.filter(row => row.path.startsWith("/v1/native/"))) assert.match(row.authorization, /^Bearer clawrouter-live-vydra_[a-z]+-fixture-secret$/);
    for (const id of ["unpriced", "missingmotion", "samereference", "credentialreference"]) {
      const denied = await usage(origin, id); assert.equal(denied.budget.spentMicros, 0);
      assert.equal(denied.usage.events.length, 0);
    }
  });
});

function routerFixture() {
  return `import handler from "./worker/index.ts"; export * from "./worker/index.ts";
    import { putGrantCredentials } from "./worker/grant-credentials.ts";
    const requests = [], video = Uint8Array.from(atob(${JSON.stringify(video.base64)}), c => c.charCodeAt(0));
    export default { ...handler, async fetch(request, env, context) {
      const path = new URL(request.url).pathname;
      if (path === "/fixture/grants") {
        for (const id of ${JSON.stringify(ids)}) await putGrantCredentials(env, "oauth/vydra_" + id + "/vydra", { provider: "vydra", kind: "api_key", enabled: true, credential: "fixture-upstream-vydra-key" });
        return new Response(null, { status: 204 });
      }
      if (path === "/fixture/requests") return Response.json(requests);
      if (path !== "/v1/usage") requests.push({ path, method: request.method, authorization: request.headers.get("authorization") });
      if (path === "/fixture/output") return new Response(video, { headers: { "content-type": "video/mp4" } });
      return handler.fetch(request, { ...env, VYDRA_API_KEY: "must-not-fallback" }, context);
    } };`;
}
function upstreamFixture() {
  return `const calls = [], polls = new Map();
    export default { async fetch(request) {
      if (request.url === "https://fixture.example/state") return Response.json(calls);
      const body = request.method === "POST" ? await request.json() : null;
      calls.push({ url: request.url, method: request.method, headers: Object.fromEntries(request.headers), redirect: request.redirect, body });
      const id = body ? body.prompt?.replace("Synthetic ", "") : new URL(request.url).pathname.split("/").pop()?.replace("vydra_", "");
      if (!["kling", "veo3", "failed", "overflow", "local"].includes(id)) return new Response("unknown fixture job", { status: 404 });
      if (body) return Response.json({ jobId: "vydra_" + id, status: "pending", outputUrl: "https://example.com/premature.mp4" }, { status: 202 });
      const count = (polls.get(id) ?? 0) + 1; polls.set(id, count);
      if (count === 1) return Response.json({ id: "vydra_" + id, status: "running", output: { videoUrl: "https://example.com/premature.mp4" } });
      return Response.json(id === "failed" ? { id: "vydra_" + id, status: "failed", error: { message: "Synthetic provider failure" }, outputUrl: "https://example.com/premature.mp4" }
        : { id: "vydra_" + id, status: "completed", output: { videoUrl: ${JSON.stringify(asset)} }, creditsCharged: 50 });
    } };`;
}


test("actual SDK observer preserves original promise, receiver, arguments and falsey failures", async () => {
  const text = readFileSync(fixture, "utf8"), start = text.indexOf("function observe<T>"), end = text.indexOf("beforeEach(() =>", start);
  assert.ok(start > 0 && end > start);
  const rows = [], tails = [], faults = [], context = { rows, tails, faults };
  runInNewContext(stripTypeScriptTypes(text.slice(start, end)) + ";globalThis.invoke = call;", context);
  const receiver = {}, argument = {}, result = {}, promise = Promise.resolve(result);
  const actual = context.invoke("release", function (value) { assert.equal(this, receiver); assert.equal(value, argument); return promise; }, receiver, [argument]);
  assert.equal(actual, promise); assert.equal(await actual, result); await Promise.all(tails.splice(0));
  assert.equal(rows[0].state, "fulfilled");
  let caught = false; try { context.invoke("release", () => { throw undefined; }, receiver, []); } catch (error) { caught = true; assert.equal(error, undefined); }
  assert.equal(caught, true); assert.equal(rows[1].state, "rejected"); assert.equal(rows[1].error, undefined);
  const reason = {}, rejected = Promise.reject(reason);
  assert.equal(context.invoke("read", () => rejected, receiver, []), rejected); await rejected.catch(error => assert.equal(error, reason));
  await Promise.all(tails.splice(0)); assert.equal(rows[2].state, "rejected"); assert.equal(rows[2].error, reason);
  const observed = context.invoke("guard", () => promise, receiver, [], () => { throw undefined; });
  assert.equal(observed, promise); await Promise.all(tails.splice(0)); assert.deepEqual(faults, [undefined]);
});
