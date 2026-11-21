import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { inspect, stripVTControlCharacters } from "node:util";
import test from "node:test";
import { parse } from "yaml";
import { runOpenClawConsumer } from "./helpers/openclaw-consumer.mjs";
import { overlayPixVerseGuardSource, restorePixVerseGuardSource, pixverseGuardPin, pixverseGuardPrelude, withPixVerseGuardObservation } from "./helpers/openclaw-pixverse-guard-observer.mjs";

const source = process.env.CLAWROUTER_OPENCLAW_CHECKOUT;
const sourceHead = "b0d33f09ba5d8d0e6db804f01cbf79dcf269a351";
const fixture = new URL("./fixtures/openclaw-pixverse-image-contract.test.ts", import.meta.url);
const asset = "https://example.com/clawrouter-pixverse-fixture.mp4";
const png64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";
const paid = ["v6", "c1", "failed", "ambiguous", "local"];
const denied = ["unpriced", "globalfee", "nouploadprice", "nocreateprice", "retention", "foreign", "foreignprofile", "budget", "forged", "remote", "badmime"];
const ids = [...paid, ...denied];
const contract = "pixverse.composed-image.v1";
const profile = "clawrouter.pixverse-image-input.v1";
const path = "/v1/native/pixverse/openapi/v2/video/img/generate";
const key = id => "clawrouter-live-piximage_" + id + "-fixture-secret";
const job = id => String(1000 + ids.indexOf(id));
function multipart(id, extras = {}) {
  const form = new FormData();
  for (const [name, value] of Object.entries({ model: id === "c1" ? "c1" : "v6", prompt: "Synthetic " + id, duration: 5, quality: "720p", ...extras })) form.append(name, String(value));
  form.append("image", new Blob([Buffer.from(png64, "base64")], { type: "image/png" }), "input.png");
  return form;
}
async function invokeNative(t, origin, invoke = runOpenClawConsumer, bind = withPixVerseGuardObservation) {
  const diagnostics = [];
  await bind(source, createHash("sha256").update(readFileSync(fixture)).digest("hex"), guardContract => invoke({ diagnostic(message) { diagnostics.push(String(message)); t.diagnostic(message); } }, {
    source, sourceHead, fixture, testPath: "extensions/clawrouter/worker-pixverse-image-contract.test.ts",
    env: { CLAWROUTER_CONTRACT_ORIGIN: origin, CLAWROUTER_PIXVERSE_IMAGE_CONTRACT: contract, CLAWROUTER_PIXVERSE_GUARD_CONTRACT: guardContract },
  }));
  const lines = stripVTControlCharacters(diagnostics.join("\n")).split("\n").map(line => line.trim());
  for (const model of ["v6", "c1"]) assert.equal(lines.filter(line => line === "PIXVERSE_IMAGE_RETIRED " + model).length, 1, "exact original SDK completion receipt");
}
async function json(response, status = 200) { const text = await response.text(); assert.equal(response.status, status, text); return JSON.parse(text); }
async function withFixture(t, run) {
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-pixverse-image-"));
  const { startWorkerdFixture } = await import("./helpers/workerd.mjs");
  const failures = []; let mf;
  const options = { persistencePath: join(temporary, "state") };
  try {
    mf = await startWorkerdFixture(temporary, routerFixture(), upstreamFixture(), options);
    const kv = await mf.getKVNamespace("POLICY_KV", "router");
    for (const id of ids) {
      const costs = { "pixverse.image_upload": 13, "video.generate": 700 };
      if (["unpriced", "globalfee"].includes(id)) { delete costs["pixverse.image_upload"]; delete costs["video.generate"]; }
      if (id === "nouploadprice") delete costs["pixverse.image_upload"];
      if (id === "nocreateprice") delete costs["video.generate"];
      await kv.put("policies/piximage_" + id, JSON.stringify({ enabled: true, generation: "fixture", providers: ["pixverse"], models: null,
        tenantId: "fixture", monthlyBudgetMicros: id === "budget" ? 712 : 10000, requestCostMicros: id === "globalfee" ? 713 : null, requestCostsMicros: costs,
        upstreamRetention: { version: "clawrouter.upstream-retention.v1", allow: id === "retention" ? [] : [{ providerId: "pixverse", protocol: "pixverse.video" }] },
        grantRouting: { environmentFallback: false, eligibleGrants: { pixverse: ["pixverse"] } },
        budgetMode: "reserve", retainRequestContent: false }));
      await kv.put("credentials/piximage_" + id, JSON.stringify({ enabled: true, secretSha256: createHash("sha256").update("fixture-secret").digest("hex"), policyId: "piximage_" + id, policyGeneration: "fixture" }));
    }
    await kv.put("connections/pixverse", JSON.stringify({ providerId: "pixverse", enabled: true }));
    const bootstrap = String(await mf.ready).replace(/\/$/, "");
    const bindings = await json(await fetch(bootstrap + "/fixture/grants", { method: "POST" }));
    assert.equal(bindings.bindings.length, ids.length - 1);
    await mf.dispose(); mf = undefined;
    // Static deployment configuration is installed only after the real original
    // credential owners exist. Persistence retains their exact lineage/SQLite.
    mf = await startWorkerdFixture(temporary, routerFixture(), upstreamFixture(), { ...options, bindings: { CLAWROUTER_UPSTREAM_RETENTION_BINDINGS: JSON.stringify(bindings) } });
    const origin = String(await mf.ready).replace(/\/$/, ""), upstream = await mf.getWorker("upstream");
    const call = (id, route, body, method = body === undefined ? "GET" : "POST") => fetch(origin + route, { method,
      headers: { authorization: "Bearer " + key(id), ...(body === undefined || body instanceof FormData ? {} : { "content-type": "application/json" }), "Idempotency-Key": "piximage-" + id },
      ...(body === undefined ? {} : { body: body instanceof FormData ? body : JSON.stringify(body) }) });
    await run({ origin, upstream, call });
    const retired = await json(await fetch(origin + "/fixture/retire"));
    assert.ok(retired.operations > 0); assert.equal(retired.pending, 0); assert.equal(retired.rejected, 0);
    const sourceProof = await json(await upstream.fetch("https://fixture.example/retire"));
    assert.equal(sourceProof.pending, 0); assert.equal(sourceProof.rejected, 0);
  } catch (error) { failures.push(error); }
  finally {
    // A failed assertion never bypasses independent original work/restoration.
    if (mf) for (const retire of [async () => json(await fetch(String(await mf.ready).replace(/\/$/, "") + "/fixture/retire")), async () => json(await (await mf.getWorker("upstream")).fetch("https://fixture.example/retire"))]) {
      try { const proof = await retire(); assert.equal(proof.pending, 0); assert.equal(proof.rejected, 0); } catch (error) { failures.push(error); }
    }
    try { await mf?.dispose(); } catch (error) { failures.push(error); }
    try { await rm(temporary, { recursive: true, force: true }); } catch (error) { failures.push(error); }
  }
  if (failures.length) { for (const error of failures) t.diagnostic(inspect(error, { depth: 4 })); throw new AggregateError(failures, "PixVerse original operation and fixture retirement"); }
}
async function usage(origin, id, count = 0, spent = 0) {
  let result;
  for (let i = 0; i < 200; i++) {
    result = await json(await fetch(origin + "/v1/usage", { headers: { authorization: "Bearer " + key(id) } }));
    if (result.usage.events.length >= count && result.budget.spentMicros === spent) return result;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail(id + " accounting did not settle: " + JSON.stringify(result));
}
function assertReceipt(result, id) {
  assert.equal(result.usage.events.length, 2, id);
  assert.equal(new Set(result.usage.events.map(row => row.request_id)).size, 2, "distinct upload/create request receipts");
  assert.deepEqual(result.usage.events.map(row => [row.capability, row.actual_cost_micros, row.cost_basis]).sort(), [["pixverse.image_upload", 13, "policy_fixed"], ["video.generate", 700, "policy_fixed"]]);
  for (const event of result.usage.events) {
    assert.equal(event.provider, "pixverse"); assert.equal(event.credential_id, "piximage_" + id); assert.equal(event.policy_id, "piximage_" + id);
    assert.deepEqual([event.input_tokens, event.output_tokens, event.total_tokens], [null, null, null]);
    assert.doesNotMatch(JSON.stringify(event), /Synthetic|fixture-upstream|fixture-secret/);
  }
  assert.equal(result.budget.spentMicros, 713);
}
async function assertAmbiguousReservation(origin) {
  const receipt = await usage(origin, "ambiguous", 0, 713);
  assert.equal(receipt.usage.events.length, 0, "unknown create has no invented terminal event");
  const job = await json(await fetch(origin + "/fixture/job/ambiguous"));
  assert.notEqual(job.requestId, job.inputReceipt.upload.requestId);
  assert.equal(job.owner.grantKey, "oauth/piximage_ambiguous/pixverse");
  assert.equal(job.owner.endpointId, "image_video");
  assert.equal(job.inputReceipt.binding.inputProfile, profile);
  assert.equal(job.inputReceipt.state, "bound"); assert.equal(job.inputReceipt.createClaimed, true);
  assert.ok(job.legs.every(row => row.reserve === "accepted"));
  assert.ok(job.inputReceipt.upload.legs.every(row => row.reserve === "accepted"));
  assert.equal(job.facts.cost.reserveMicros, 700); assert.equal(job.reservedMicros, 700);
  assert.equal(job.inputReceipt.upload.reservedMicros, 13); assert.equal(job.inputReceipt.upload.amount, 13); assert.equal(job.inputReceipt.upload.basis, "policy_fixed");
  assert.equal(job.event, null, "original durable owner retains unknown result for recovery");
}
function assertCalls(calls, selected) {
  for (const id of selected) {
    const rows = calls.filter(row => row.id === id);
    assert.equal(rows.filter(row => row.path === "/openapi/v2/image/upload").length, 1, id + " one paid upload");
    const creates = rows.filter(row => row.path === "/openapi/v2/video/img/generate"); assert.equal(creates.length, 1, id + " no ambiguous POST replay");
    assert.deepEqual(creates[0].body, { model: id === "c1" ? "c1" : "v6", prompt: "Synthetic " + id, duration: 5, quality: "720p", img_id: Number(job(id)) });
    for (const row of rows) {
      assert.equal(row.origin, "https://app-api.pixverse.ai"); assert.equal(row.headers["api-key"], "fixture-upstream-piximage-" + id);
      assert.equal(row.headers.authorization, undefined); assert.equal(row.redirect, "manual");
      if (row.method === "GET") assert.equal(row.path, "/openapi/v2/video/result/" + job(id));
    }
    if (id === "ambiguous") assert.equal(rows.length, 2, "unknown create never polls an invented ID");
    else assert.equal(rows.filter(row => row.method === "GET").length, 2, id + " original ID pending then terminal poll");
  }
  assert.equal(calls.length, selected.reduce((sum, id) => sum + (id === "ambiguous" ? 2 : 4), 0));
}

test("actual Worker catalog gates composed profile and separate prices on real credential owners", { timeout: 30000 }, async t => {
  await withFixture(t, async ({ origin, call }) => {
    for (const id of ["v6", ...denied.slice(0, 6), "budget"]) {
      const catalog = await json(await call(id, "/v1/catalog"));
      const offers = catalog.providers.find(row => row.id === "pixverse").offers.filter(row => row.endpoint === "image_video");
      assert.deepEqual(offers.filter(row => row.modelId).map(row => row.modelId).sort(), ["pixverse/c1", "pixverse/v6"]); assert.ok(offers.filter(row => row.modelId).every(row => row.eligible === (id === "v6")), id + " actual eligibility");
      for (const offer of offers) { assert.equal(offer.routeKind, "native"); assert.equal(offer.inputProfile, profile); assert.equal(offer.route, path); }
    }
    const rejected = await call("local", "/v1/proxy/pixverse/image_video", { body: { model: "v6", img_id: 1 } });
    assert.equal(rejected.status, 400); assert.equal((await rejected.json()).error.code, "managed_input_profile_required");
    for (const id of [...denied.slice(0, 6), "budget"]) { const response = await call(id, path, multipart(id)); assert.ok(response.status >= 400, id); await response.arrayBuffer(); }
    const forged = await call("local", path, multipart("local", { img_id: 1 })); assert.ok(forged.status >= 400); await forged.arrayBuffer();
    for (const id of [...denied.slice(0, 6), "local"]) { const receipt = await usage(origin, id); assert.equal(receipt.usage.events.length, 0, id); }
    const budget = await usage(origin, "budget", 2, 0);
    assert.equal(budget.usage.events.length, 2, "both allocated operations publish unsent budget-denial receipts");
    assert.equal(new Set(budget.usage.events.map(row => row.request_id)).size, 2);
    assert.deepEqual(budget.usage.events.map(row => [row.capability, row.actual_cost_micros]).sort(), [["pixverse.image_upload", 0], ["video.generate", 0]]);
  });
});

test("actual Worker composes selected upload/create and original-key GET without foreign controls", { timeout: 30000 }, async t => {
  await withFixture(t, async ({ origin, upstream, call }) => {
    const created = await json(await call("local", path, multipart("local"))); assert.equal(String(created.Resp.video_id), job("local"));
    const route = "/v1/native/pixverse/openapi/v2/video/result/" + job("local");
    for (const [id, method] of [["foreign", "GET"], ["local", "DELETE"]]) { const r = await call(id, route, undefined, method); assert.ok(r.status >= 400); await r.arrayBuffer(); }
    assert.equal((await json(await call("local", route))).Resp.status, 5);
    assert.equal((await json(await call("local", route))).Resp.status, 1);
    assertCalls(await json(await upstream.fetch("https://fixture.example/state")), ["local"]);
    assertReceipt(await usage(origin, "local", 2, 713), "local");
  });
});

test("ambiguous paid create retains both original financial legs without replay or invented polling", { timeout: 30000 }, async t => {
  await withFixture(t, async ({ origin, upstream, call }) => {
    const response = await call("ambiguous", path, multipart("ambiguous")); assert.ok(response.status >= 400); await response.arrayBuffer();
    assertCalls(await json(await upstream.fetch("https://fixture.example/state")), ["ambiguous"]);
    await assertAmbiguousReservation(origin);
  });
});

test("actual registered PixVerse image SDK through Worker and SQLite", { skip: !source, timeout: 300000 }, async t => {
  await withFixture(t, async ({ origin, upstream }) => {
    await invokeNative(t, origin);
    assertCalls(await json(await upstream.fetch("https://fixture.example/state")), paid.filter(id => id !== "local"));
    for (const id of ["v6", "c1", "failed"]) assertReceipt(await usage(origin, id, 2, 713), id);
    await assertAmbiguousReservation(origin);
    for (const id of denied) assert.equal((await usage(origin, id)).usage.events.length, 0, id);
    const requests = await json(await fetch(origin + "/fixture/requests"));
    const downloads = requests.filter(row => row.path === "/fixture/output"); assert.equal(downloads.length, 0, "the registered client returns a URL; it does not download the asset");
    const expected = new Set(paid.map(id => "Bearer " + key(id)));
    for (const row of requests.filter(row => row.path.startsWith("/v1/native/"))) assert.ok(expected.has(row.authorization), "exact configured native credential");
  });
});

function routerFixture() {
  return `import handler from "./worker/index.ts"; export * from "./worker/index.ts";
    import { putGrantCredentials } from "./worker/grant-credentials.ts";
    import { authenticateProxyKey } from "./worker/proxy-auth.ts";
    import { providerById, upstreamAuth } from "./worker/providers.ts";
    import { inputRouteDigest } from "./worker/pixverse-input-dispatch.ts";
    import { continuationScope } from "./worker/http-continuation.ts";
    import { backgroundCall } from "./worker/http-background.ts";
    const requests = [], operations = [];
    function own(promise) { const row = { state: "pending", promise }; operations.push(row); row.tail = promise.then(() => { row.state = "fulfilled"; }, error => { row.state = "rejected"; row.error = error; }); return promise; }
    async function retire() { for (let n = 0; n < operations.length;) { const batch = operations.slice(n); n = operations.length; await Promise.all(batch.map(row => row.tail)); } return { operations: operations.length, pending: operations.filter(row => row.state === "pending").length, rejected: operations.filter(row => row.state === "rejected").length }; }
    export default { ...handler, async fetch(request, env, context) {
      const route = new URL(request.url).pathname;
      if (route === "/fixture/retire") return Response.json(await retire());
      if (route === "/fixture/requests") return Response.json(requests);
      if (route === "/fixture/job/ambiguous") {
        const authorization = "Bearer clawrouter-live-piximage_ambiguous-fixture-secret";
        const request = requests.find(row => row.method === "POST" && row.authorization === authorization && row.recovery);
        if (!request) throw new Error("missing actual original recovery locator");
        const auth = await authenticateProxyKey(new Headers({ authorization }), env, [{ id: "pixverse", tokenRef: "pixverse" }]);
        if (auth instanceof Response) throw new Error("recovery owner authentication failed");
        const scope = await continuationScope(auth), prefix = scope.slice("http-continuations:".length) + ".";
        if (!request.recovery.startsWith(prefix)) throw new Error("foreign recovery owner");
        return Response.json(await backgroundCall(env, scope, { action: "get", id: request.recovery.slice(prefix.length) }));
      }
      if (route === "/fixture/grants") {
        const bindings = [], provider = providerById("pixverse"), endpoint = provider.endpoints.find(row => row.id === "image_video");
        for (const id of ${JSON.stringify(ids.filter(id => id !== "foreign"))}) {
          const grantKey = "oauth/piximage_" + id + "/pixverse";
          await putGrantCredentials(env, grantKey, { provider: "pixverse", kind: "api_key", enabled: true, credential: "fixture-upstream-piximage-" + id });
          const auth = await authenticateProxyKey(new Headers({ authorization: "Bearer clawrouter-live-piximage_" + id + "-fixture-secret" }), env, [{ id: "pixverse", tokenRef: "pixverse" }]);
          if (auth instanceof Response) throw new Error("bootstrap authentication failed");
          const upstream = await upstreamAuth(provider, auth, env), destination = await inputRouteDigest(provider, endpoint, upstream.grant, env);
          bindings.push({ providerId: "pixverse", protocol: "pixverse.video", grantKey, routeSha256: destination.digest, retention: "allow", expiresAt: new Date(Date.now() + 600000).toISOString() });
        }
        return Response.json({ version: "clawrouter.upstream-retention-bindings.v1", bindings });
      }
      const recorded = { path: route, method: request.method, authorization: request.headers.get("authorization"), recovery: null };
      if (route !== "/v1/usage") requests.push(recorded);
      const response = await own(handler.fetch(request, { ...env, PIXVERSE_API_KEY: "must-not-fallback" }, { ...context, waitUntil(promise) { own(promise); context.waitUntil(promise); } }));
      recorded.recovery = response.headers.get("x-clawrouter-background-recovery");
      if (route === "/v1/catalog" && request.headers.get("authorization") === "Bearer clawrouter-live-piximage_foreignprofile-fixture-secret") {
        // Negative-only projection of the actual catalog; never manufacture an eligible offer.
        const body = await own(response.text());
        return new Response(body.replaceAll("clawrouter.pixverse-image-input.v1", "foreign.pixverse-image-input.v1"), { status: response.status, headers: response.headers });
      }
      return response;
    } };`;
}
function upstreamFixture() {
  return `const calls = [], operations = [], polls = new Map(), ids = ${JSON.stringify(ids)};
    function own(promise) { const row = { state: "pending", promise }; operations.push(row); row.tail = promise.then(() => { row.state = "fulfilled"; }, error => { row.state = "rejected"; row.error = error; }); return promise; }
    export default { async fetch(request) {
      if (request.url === "https://fixture.example/state") return Response.json(calls);
      if (request.url === "https://fixture.example/retire") { for (let n = 0; n < operations.length;) { const batch = operations.slice(n); n = operations.length; await Promise.all(batch.map(row => row.tail)); } return Response.json({ pending: operations.filter(row => row.state === "pending").length, rejected: operations.filter(row => row.state === "rejected").length }); }
      return own((async () => {
        const url = new URL(request.url), id = request.headers.get("api-key")?.replace("fixture-upstream-piximage-", "");
        if (!${JSON.stringify(paid)}.includes(id)) throw new Error("unselected upstream credential");
        let body = null;
        if (url.pathname === "/openapi/v2/image/upload") {
          const form = await own(request.formData()); if (JSON.stringify([...form.keys()]) !== '["image"]') throw new Error("upload fields changed");
          const file = form.get("image"), bytes = new Uint8Array(await own(file.arrayBuffer()));
          if (file.name !== "input-image" || file.type !== "image/png" || btoa(String.fromCharCode(...bytes)) !== ${JSON.stringify(png64)}) throw new Error("upload bytes changed");
        } else if (request.method === "POST") body = await own(request.json());
        calls.push({ id, origin: url.origin, path: url.pathname, method: request.method, headers: Object.fromEntries(request.headers), redirect: request.redirect, body });
        const number = 1000 + ids.indexOf(id);
        if (url.pathname === "/openapi/v2/image/upload") return Response.json({ ErrCode: 0, Resp: { img_id: number } });
        if (request.method === "POST") return Response.json(id === "ambiguous" ? { ErrCode: 0, Resp: {} } : { ErrCode: 0, Resp: { video_id: number } });
        if (url.pathname !== "/openapi/v2/video/result/" + number) throw new Error("foreign original ID");
        const count = (polls.get(id) ?? 0) + 1; polls.set(id, count);
        return Response.json({ ErrCode: 0, Resp: { video_id: number, status: count === 1 ? 5 : id === "failed" ? 7 : 1, ...(count > 1 && id !== "failed" ? { url: ${JSON.stringify(asset)} } : {}) } });
      })());
    } };`;
}

test("actual SDK observer preserves original promise, receiver, arguments and falsey failures", async () => {
  const text = readFileSync(fixture, "utf8"), start = text.indexOf("function observe<T>"), end = text.indexOf("beforeEach(() =>", start);
  assert.ok(start > 0 && end > start);
  const rows = [], tails = [], faults = [], context = { rows, tails, faults };
  runInNewContext('"use strict";\n' + stripTypeScriptTypes(text.slice(start, end)) + ";globalThis.invoke = call;", context);
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

test("compiled PixVerse callsite preserves operands, promise and falsey outcomes independently of observation", async () => {
  const contract = "b".repeat(64), modules = new Set(), observed = [], context = {};
  runInNewContext('"use strict";\n' + stripTypeScriptTypes(pixverseGuardPrelude(contract)) + ";globalThis.invoke = __pixverseGuardInvoke;", context);
  context[Symbol.for("clawrouter.pixverse.guard." + contract)] = { modules, observe(...args) { observed.push(args); } };
  const order = [], input = {}, value = {}, promise = Promise.resolve(value);
  context.operands = {
    get callee() { order.push("callee"); return function (actual) { order.push("call"); assert.equal(this, undefined); assert.equal(actual.input, input); return promise; }; },
    get input() { order.push("input"); return input; },
  };
  const returned = runInNewContext("invoke(operands.callee, {input: operands.input})", context);
  assert.equal(returned, promise); assert.equal(await returned, value); assert.deepEqual(order, ["callee", "input", "call"]);
  assert.equal(modules.size, 1); assert.equal(observed[0][2], undefined); assert.equal(observed[0][3][0].input, input);
  assert.equal(observed[0][4], true); assert.equal(observed[0][5], promise);
  const reason = {}, rejected = Promise.reject(reason);
  assert.equal(context.invoke(() => rejected, input), rejected);
  await rejected.catch(error => assert.equal(error, reason)); assert.equal(observed[1][5], rejected);
  let threw = false;
  try { context.invoke(() => { throw undefined; }, input); } catch (error) { threw = true; assert.equal(error, undefined); }
  assert.equal(threw, true); assert.equal(observed[2][4], false); assert.equal(observed[2][5], undefined);
  context[Symbol.for("clawrouter.pixverse.guard." + contract)].observe = () => { throw undefined; };
  assert.equal(context.invoke(() => promise, input), promise);
  assert.deepEqual(Array.from([...modules][0].faults), [undefined]);
  assert.throws(() => pixverseGuardPrelude("wrong"));
  assert.throws(() => overlayPixVerseGuardSource(Buffer.from("changed source"), contract), /source changed/);
});

test("executing PixVerse guard identity binds original acquisitions and detached release without accepting foreign generations", async () => {
  const text = readFileSync(fixture, "utf8"), start = text.indexOf("function observe<T>"), end = text.indexOf("beforeEach(() =>", start);
  const rows = [], tails = [], faults = [], acquisitions = [], readers = [];
  const context = { rows, tails, faults, acquisitions, readers, guardIdentity: undefined, URL, Headers, origin: "https://router.example", currentId: "control",
    expect(value) { return { toBe: expected => assert.equal(value, expected), toHaveLength: expected => assert.equal(value.length, expected) }; } };
  runInNewContext('"use strict";\n' + stripTypeScriptTypes(text.slice(start, end)) + ";globalThis.observeGuardCall = observeGuard;", context);
  const module = { faults: [] }, callee = () => {}, input = {url: "https://router.example/v1/catalog", init: {headers: {authorization: "Bearer clawrouter-live-piximage_control-fixture-secret"}}}, releaseResult = Promise.resolve();
  const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1])); controller.close(); } });
  let released = 0;
  const result = { response: new Response(body), release: function (...args) { assert.equal(this, undefined); assert.deepEqual(args, []); released++; return releaseResult; } };
  const original = Promise.resolve(result);
  context.observeGuardCall(module, callee, undefined, [input], true, original);
  await Promise.all(tails.splice(0));
  assert.equal(rows[0].original, original); assert.equal(rows[0].result, result); assert.equal(rows[0].fn, callee); assert.equal(rows[0].args[0], input);
  assert.equal(acquisitions[0].result, result);
  const reader = result.response.body.getReader(); await reader.read(); await reader.read(); reader.releaseLock();
  const detached = result.release; assert.equal(detached(), releaseResult);
  await Promise.all(tails.splice(0));
  assert.equal(released, 1); assert.equal(acquisitions[0].releases, 1); assert.equal(readers[0].unlocks, 1); assert.equal(body.locked, false);
  assert.deepEqual(faults, []); assert.ok(rows.every(row => row.state === "fulfilled"));
  for (const args of [[{ faults: [] }, callee, undefined, [input]], [module, () => {}, undefined, [input]], [module, callee, {}, [input]], [module, callee, undefined, []]]) {
    assert.throws(() => context.observeGuardCall(...args, true, original));
  }
  context.observeGuardCall(module, callee, undefined, [input], false, undefined);
  assert.equal(rows.at(-1).state, "rejected"); assert.equal(rows.at(-1).error, undefined);
  assert.equal(rows.at(-1).args[0], input); assert.equal(acquisitions.length, 1);
});

test("PixVerse restoration rejects a pathname replacement before or during the held-inode write", async () => {
  const stat = { dev: 1, ino: 2, uid: 3, nlink: 1, mode: 0o100644 };
  const original = Buffer.from("original"), output = Buffer.from("observed");
  for (const replacement of ["none", "before", "during"]) {
    let pathStat = replacement === "before" ? { ...stat, ino: 4 } : stat, held = output, writes = 0;
    const file = { stat: async () => stat }, row = { file, path: "owned.ts", stat, bytes: original, output, changed: true, applied: true };
    const restoration = restorePixVerseGuardSource(row, async () => ({ bytes: held, stat }), async (target, bytes) => {
      assert.equal(target, file); writes++; held = bytes;
      if (replacement === "during") pathStat = { ...stat, ino: 4 };
    }, async path => { assert.equal(path, row.path); return pathStat; });
    if (replacement === "none") await restoration;
    else await assert.rejects(restoration, replacement === "before" ? /source inode changed/ : /restored pathname changed/);
    assert.equal(writes, replacement === "before" ? 0 : 1);
    assert.equal(held, replacement === "before" ? output : original);
  }
  const row = { file: { stat: async () => stat }, path: "owned.ts", stat, bytes: original, output, changed: true, applied: false };
  let restored;
  await restorePixVerseGuardSource(row, async () => ({ bytes: Buffer.from("partial"), stat }), async (_file, bytes) => { restored = bytes; }, async () => stat);
  assert.equal(restored, original);
});

test("PixVerse cleanup joins originals and restores mocks after observer admission fails, retaining undefined faults", async () => {
  const text = readFileSync(fixture, "utf8"), start = text.indexOf("afterEach(async () =>"), end = text.indexOf("const png =", start);
  let cleanup, joined = false, restored = false;
  const key = Symbol("foreign channel"), foreign = {}, context = {
    tails: [Promise.reject(undefined), Promise.resolve().then(() => { joined = true; })],
    faults: [], rows: [], acquisitions: [], readers: [], guardChannel: undefined, guardKey: key, retired: undefined,
    afterEach(fn) { cleanup = fn; }, vi: { restoreAllMocks() { restored = true; throw undefined; } },
    expect(value) { return { toBe: expected => assert.equal(value, expected), toEqual: expected => assert.equal(JSON.stringify(value), JSON.stringify(expected)) }; },
  };
  context[key] = foreign;
  runInNewContext('"use strict";\n' + stripTypeScriptTypes(text.slice(start, end)), context);
  await assert.rejects(cleanup(), error => {
    assert.equal(error.errors.length, 3); assert.equal(error.errors[0], undefined); assert.equal(error.errors[2], undefined); return true;
  });
  assert.equal(joined, true); assert.equal(restored, true); assert.equal(context[key], foreign);
});

test("PixVerse terminal output is an exact URL-only result, not an inferred download", () => {
  const sdk = readFileSync(fixture, "utf8");
  const start = sdk.indexOf("expect(result.videos[0])"), end = sdk.indexOf("expect(globalThis.fetch)", start);
  const check = value => runInNewContext(sdk.slice(start, end), { result: { videos: [value] }, asset,
    expect(actual) { return { toEqual: expected => assert.equal(JSON.stringify(actual), JSON.stringify(expected)) }; } });
  check({ url: asset, mimeType: "video/mp4" });
  for (const value of [{ buffer: [1], mimeType: "video/mp4" }, { url: "https://example.com/foreign.mp4", mimeType: "video/mp4" }, { url: asset, mimeType: "image/png" }, { url: asset, mimeType: "video/mp4", buffer: [1] }]) assert.throws(() => check(value));
});

test("PixVerse actual runner binds the registered provider, exact pin, environment and completion receipts", async () => {
  const strategy = parse(readFileSync(new URL("../.github/workflows/openclaw-contract.yml", import.meta.url), "utf8")).jobs.consumer.strategy;
  const matrix = strategy.matrix; assert.equal(strategy["max-parallel"], 4);
  assert.deepEqual(matrix.include.filter(row => row.consumer === "pixverse-image"), [{ consumer: "pixverse-image", ref: sourceHead, test: "test/openclaw-pixverse-image.test.mjs" }]);
  assert.equal(new Set(matrix.include.map(row => row.consumer)).size, matrix.include.length);
  const sdk = readFileSync(fixture, "utf8"); assert.doesNotThrow(() => stripTypeScriptTypes(sdk)); assert.match(sdk, /primary: "clawrouter\/pixverse\/"/);
  assert.equal(pixverseGuardPin, sourceHead);
  const contractHash = "a".repeat(64);
  const bind = async (root, hash, run) => { assert.equal(root, source); assert.equal(hash, createHash("sha256").update(sdk).digest("hex")); return run(contractHash); };
  await invokeNative({ diagnostic() {} }, "https://router.example", async (t, options) => {
    assert.equal(options.sourceHead, sourceHead); assert.equal(options.fixture.href, fixture.href);
    assert.equal(options.testPath, "extensions/clawrouter/worker-pixverse-image-contract.test.ts");
    assert.deepEqual(options.env, { CLAWROUTER_CONTRACT_ORIGIN: "https://router.example", CLAWROUTER_PIXVERSE_IMAGE_CONTRACT: contract, CLAWROUTER_PIXVERSE_GUARD_CONTRACT: contractHash });
    t.diagnostic("PIXVERSE_IMAGE_RETIRED v6\nPIXVERSE_IMAGE_RETIRED c1");
  }, bind);
  for (const receipt of ["", "VYDRA_MODELS_RETIRED v6", "PIXVERSE_IMAGE_RETIRED v6\nPIXVERSE_IMAGE_RETIRED v6", "PIXVERSE_IMAGE_RETIRED v6\nPIXVERSE_IMAGE_RETIRED c1\nPIXVERSE_IMAGE_RETIRED c1"]) {
    await assert.rejects(invokeNative({ diagnostic() {} }, "https://router.example", async t => t.diagnostic(receipt), bind));
  }
});

test("PixVerse original body.cancel stays joined when fulfilled, held or rejected with undefined", async () => {
  const text = readFileSync(fixture, "utf8"), start = text.indexOf("function observe<T>"), end = text.indexOf("beforeEach(() =>", start);
  for (const mode of ["fulfilled", "held", "undefined", "both"]) {
    const rows = [], tails = [], faults = [], acquisitions = [], readers = [];
    const context = { rows, tails, faults, acquisitions, readers };
    runInNewContext(stripTypeScriptTypes(text.slice(start, end)) + ";globalThis.install = installAcquisition;", context);
    let finish; const reason = {}; const pending = new Promise(resolve => { finish = resolve; });
    const original = mode === "held" ? pending : mode === "fulfilled" ? Promise.resolve() : Promise.reject(undefined);
    const body = { cancel(...args) { assert.equal(this, body); assert.deepEqual(args, [reason]); return original; } };
    const releasePromise = mode === "both" ? Promise.reject(reason) : Promise.resolve();
    const result = { response: { body }, release() { return releasePromise; } }; context.install(result);
    assert.equal(result.response.body.cancel(reason), original); assert.equal(result.release(), releasePromise);
    if (mode === "held") { await Promise.resolve(); assert.equal(rows.find(row => row.kind === "body.cancel").state, "pending"); finish(); }
    await Promise.all(tails);
    const cancel = rows.find(row => row.kind === "body.cancel"); assert.equal(cancel.fn !== body.cancel, true); assert.equal(cancel.receiver, body); assert.equal(cancel.original, original);
    assert.equal(cancel.state, ["undefined", "both"].includes(mode) ? "rejected" : "fulfilled");
    if (["undefined", "both"].includes(mode)) { assert.ok(Object.hasOwn(cancel, "error")); assert.equal(cancel.error, undefined); }
    if (mode === "both") assert.equal(rows.find(row => row.kind === "release").error, reason);
    assert.deepEqual(faults, []);
    const foreign = {}; assert.throws(() => body.cancel.call(foreign, reason)); assert.equal(faults.length, 1); assert.equal(rows.at(-1).state, "rejected");
  }
});
