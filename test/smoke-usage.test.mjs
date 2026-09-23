import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { runLiveProviderSmokes, runProviderTarget, waitForSmokeUsage } from "../scripts/provider-smoke-plan.mjs";

const baseUrl = "https://router.example";
const result = { provider: "fixture", requestId: "smoke_current", statusCode: 201 };
const event = { id: "usage_independent", request_id: result.requestId, provider: result.provider, status: "success", status_code: 201, occurred_at_ms: 0 };
const snapshot = (events) => Response.json({ usage: { events } });
const provider = (id) => ({ id, target: { kind: "openai_chat", route: "/v1/chat/completions", body: { model: `${id}/fixture` } } });

function clock() {
  let now = 0;
  const delays = [];
  return { nowImpl: () => now, sleepImpl: async (ms) => { delays.push(ms); now += ms; }, delays };
}

test("usage polling waits through stale and missing snapshots with the same caller key", async () => {
  const time = clock();
  let reads = 0;
  const id = await waitForSmokeUsage({
    baseUrl: `${baseUrl}/`, smokeKey: "fixture-key", result, ...time,
    fetchImpl: async (url, init) => {
      reads += 1;
      assert.equal(url, `${baseUrl}/v1/usage`);
      assert.equal(init.headers.authorization, "Bearer fixture-key");
      assert.equal(init.redirect, "manual");
      assert.equal(init.method, undefined);
      assert.equal(init.signal.aborted, false);
      return snapshot(reads === 1 ? [{ ...event, request_id: "smoke_previous" }] : reads === 2 ? [] : [event]);
    },
  });
  assert.equal(id, event.id, "event ID is independent of request ID; no cross-host time comparison");
  assert.deepEqual(time.delays, [2_000, 2_000]);
});

test("only transient reads retry and the final polling delay is clipped", async () => {
  const time = clock();
  let reads = 0;
  await assert.rejects(waitForSmokeUsage({
    baseUrl, smokeKey: "fixture-key", result, timeoutMs: 5_001, ...time,
    fetchImpl: async () => { reads += 1; return snapshot([]); },
  }), /visibility unconfirmed.*5001ms.*latest 100 caller-visible events.*do not repeat the provider POST/);
  assert.equal(reads, 3);
  assert.deepEqual(time.delays, [2_000, 2_000, 1_001]);
});

for (const failure of ["transport", "body", 408, 429, 503]) {
  test(`usage polling recovers after transient ${failure}`, async () => {
    let reads = 0;
    const id = await waitForSmokeUsage({
      baseUrl, smokeKey: "fixture-key", result, ...clock(),
      fetchImpl: async () => {
        if (++reads > 1) return snapshot([event]);
        if (failure === "transport") throw new Error("private transport diagnostic");
        if (failure === "body") return new Response(new ReadableStream({ start(controller) { controller.error(new Error("private body diagnostic")); } }), { headers: { "content-type": "application/json" } });
        return new Response("private error body", { status: failure });
      },
    });
    assert.equal(id, event.id);
    assert.equal(reads, 2);
  });
}

for (const [name, response, message] of [
  ...[302, 401, 403, 404].map((status) => [`HTTP ${status}`, () => new Response("private body", { status }), new RegExp(`HTTP ${status}`)]),
  ["HTML", () => new Response("private HTML", { headers: { "content-type": "text/html" } }), /non-JSON content/],
  ["invalid JSON", () => new Response("private parse excerpt", { headers: { "content-type": "application/json" } }), /invalid JSON/],
  ["missing events", () => Response.json({ events: [event] }), /invalid usage.events envelope/],
  ["invalid event array", () => snapshot([null]), /invalid usage.events envelope/],
]) {
  test(`${name} is terminal and never prints response contents`, async () => {
    let reads = 0;
    await assert.rejects(waitForSmokeUsage({
      baseUrl, smokeKey: "fixture-key", result, ...clock(),
      fetchImpl: async () => { reads += 1; return response(); },
    }), (error) => { assert.match(error.message, message); assert.doesNotMatch(error.message, /private|fixture-key/); return true; });
    assert.equal(reads, 1);
  });
}

for (const fields of [{ id: "" }, { occurred_at_ms: "0" }, { occurred_at_ms: null }, { provider: "other" }, { status: "provider_error" }, { status_code: 200 }]) {
  test(`matching request with incorrect ${Object.keys(fields)[0]} cannot qualify`, async () => {
    await assert.rejects(waitForSmokeUsage({
      baseUrl, smokeKey: "fixture-key", result, ...clock(),
      fetchImpl: async () => snapshot([{ ...event, ...fields }]),
    }), /does not match the successful provider response/);
  });
}

test("each provider POST has a unique bounded request ID returned in its result", async (t) => {
  const ids = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    ids.push(init.headers["x-request-id"]);
    return new Response("ok", { headers: { "x-clawrouter-upstream-provider": "fixture" } });
  });
  for (let index = 0; index < 2; index++) {
    const actual = await runProviderTarget(baseUrl, "fixture-key", provider("fixture"));
    assert.equal(actual.requestId, ids[index]);
    assert.match(actual.requestId, /^smoke_[a-f0-9-]{36}$/);
    assert.ok(actual.requestId.length <= 128);
  }
  assert.notEqual(ids[0], ids[1]);
});

test("health is recorded before polling and successful results expose the observed event ID", async (t) => {
  let requestId;
  const order = [], health = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (init.method === "POST") {
      requestId = init.headers["x-request-id"]; order.push("POST");
      return new Response("ok", { status: 201, headers: { "x-clawrouter-upstream-provider": "fixture" } });
    }
    order.push("usage");
    assert.equal(url, `${baseUrl}/v1/usage`);
    assert.equal(health.length, 1);
    return snapshot([{ ...event, request_id: requestId }]);
  });
  const results = await runLiveProviderSmokes({ baseUrl, smokeKey: "fixture-key", plan: { providers: [provider("fixture")] }, liveProviders: ["all"], onResult: (value) => { order.push("health"); health.push(structuredClone(value)); } });
  assert.deepEqual(order, ["POST", "health", "usage"]);
  assert.equal(results[0].usageEventId, event.id);
  const { usageEventId, ...unchangedHealth } = results[0];
  assert.deepEqual(unchangedHealth, health[0]);
});

test("usage failure preserves health and aggregates later provider failures without another POST", async (t) => {
  const posts = [], health = [];
  let usageReads = 0;
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    if (init.method !== "POST") { usageReads += 1; return new Response(null, { status: 403 }); }
    const id = JSON.parse(init.body).model.split("/")[0]; posts.push(id);
    return new Response("ok", { status: id === "second" ? 503 : 200, headers: { "x-clawrouter-upstream-provider": id } });
  });
  await assert.rejects(runLiveProviderSmokes({
    baseUrl, smokeKey: "fixture-key", plan: { providers: [provider("first"), provider("second")] }, liveProviders: ["all"],
    onResult: (value) => { health.push(structuredClone(value)); if (value.provider === "first") throw new Error("fixture health unavailable"); },
  }), /first health record failed: fixture health unavailable; first usage visibility failed:.*403; second smoke failed: HTTP 503/);
  assert.deepEqual(posts, ["first", "second"]);
  assert.equal(usageReads, 1);
  assert.deepEqual(health.map(({ status, statusCode }) => [status, statusCode]), [["verified", 200], ["failed", 503]]);
  assert.ok(health.every(({ latencyMs }) => Number.isFinite(latencyMs)));
});

for (const phase of ["fetch", "body", "cancel"]) {
  test(`standalone usage ${phase} stall ends under the owned deadline`, async () => {
    const source = `
      import { waitForSmokeUsage } from ${JSON.stringify(new URL("../scripts/provider-smoke-plan.mjs", import.meta.url).href)};
      const pending = () => new Promise(() => {});
      await waitForSmokeUsage({
        baseUrl: ${JSON.stringify(baseUrl)}, smokeKey: 'fixture-key', result: ${JSON.stringify(result)}, timeoutMs: 80,
        fetchImpl: async (_url, { signal }) => {
          signal.addEventListener('abort', () => console.log('aborted'));
          return ${phase === "fetch" ? "pending()" : phase === "body" ? "{ ok: true, headers: new Headers({ 'content-type': 'application/json' }), json: pending }" : "{ ok: false, status: 403, body: { cancel: pending } }"};
        },
      });`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", source], { stdio: ["ignore", "pipe", "pipe"], timeout: 3_000 });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const [code, signal] = await new Promise((resolve, reject) => { child.on("error", reject); child.on("close", (...args) => resolve(args)); });
    assert.equal(code, 1, stderr);
    assert.equal(signal, null, stderr);
    assert.match(stdout, /aborted/);
    assert.match(stderr, phase === "cancel" ? /GET \/v1\/usage returned HTTP 403/ : /usage visibility unconfirmed/);
    assert.doesNotMatch(stderr, /unsettled top-level await|fixture-key/);
  });
}

test("a body arriving after the deadline cannot qualify a successful event", async () => {
  await assert.rejects(waitForSmokeUsage({
    baseUrl, smokeKey: "fixture-key", result, timeoutMs: 20,
    fetchImpl: async () => ({ ok: true, headers: new Headers({ "content-type": "application/json" }), json: () => new Promise((resolve) => setTimeout(() => resolve({ usage: { events: [event] } }), 50)) }),
  }), /visibility unconfirmed/);
});
