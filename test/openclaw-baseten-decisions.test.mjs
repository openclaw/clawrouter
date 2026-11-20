import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { stripVTControlCharacters } from "node:util";
import test from "node:test";
import { parse } from "yaml";
import { runOpenClawConsumer } from "./helpers/openclaw-consumer.mjs";
import { startWorkerdFixture } from "./helpers/workerd.mjs";
import { basetenGuardPin, basetenGuardPrelude, overlayBasetenGuardSource, registerBasetenDatabaseOwner, restoreBasetenGuardSource, withBasetenGuardObservation } from "./helpers/openclaw-baseten-guard-observer.mjs";

const source = process.env.CLAWROUTER_OPENCLAW_CHECKOUT;
const sourceHead = "761748e1824e2ee43e886fcce4376c3b20055015";
const fixture = new URL("./fixtures/openclaw-baseten-decisions-contract.test.ts", import.meta.url);
const contract = "baseten.systemone.v1";
const models = ["decision-models/baseten-elephant-9b-latest", "decision-models/baseten-mammoth-27b-latest", "decision-models/baseten-joey-2b-latest"];
const ids = ["elephant", "mammoth", "joey", "text", "rotated", "unmetered", "malformed", "usage", "overflow", "provider_error", "invalid", "foreign", "budget", "unpriced", "revoked", "stale", "foreign_offer", "wrong_format", "preabort", "unsupported", "options_over"];
const reaching = ids.slice(0, 10), positives = reaching.slice(0, 6);
const directIds = ["native", "manifest", "unpriced", "unmetered", "malformed", "usage", "overflow", "provider_error"];
const key = id => "clawrouter-live-baseten_" + id + "-fixture-secret";
const secret = id => "synthetic-baseten-" + id + (id === "rotated" ? "-new" : "");
const selectedModel = id => models[Math.max(0, ["elephant", "mammoth", "joey"].indexOf(id))];
const nativePath = "/v1/native/baseten/systemone";
const manifestPath = "/v1/proxy/baseten/systemone";
const nativeBody = id => ({ model: selectedModel(id), state: id === "text" ? "synthetic damaged parcel" : '{"parcel":"synthetic damaged parcel"}', questions: {
  damaged: { type: "noul", instructions: 'Inspect\nTrue criterion: {"damaged":true}\nFalse criterion: Intact' },
  route: { type: "choice", instructions: "", criteria: { support: '{"team":"support"}', billing: "Billing" } },
  severity: { type: "score", instructions: "", criteria: ["Low", '{"level":"Medium"}', "High"] },
} });
const nativeOutput = { model: "synthetic-served-backend", answers: {
  damaged: { type: "noul", noul: 0.9 },
  route: { type: "choice", choice: "support", probabilities: { support: 0.8, billing: 0.2 }, confidence: 0.2 },
  severity: { type: "score", score: 1.25, probabilities: { "0": 0.2, "1": 0.35, "2": 0.45 }, confidence: 0.3, legend: { "0": "Low", "1": '{"level":"Medium"}', "2": "High" } },
}, usage: { input_tokens: 11, output_tokens: 3 } };

// Reuse the original-operation implementation, not another provider's proof or
// cancellation dispositions. No SDK/Worker exception mode is enabled here.
const donor = readFileSync(new URL("./fixtures/openclaw-qianfan-contract.test.ts", import.meta.url), "utf8");
const observerSource = donor.slice(donor.indexOf("type OriginalOperation ="), donor.indexOf("// END ORIGINAL LIFETIME OBSERVERS"));
const observerSHA = "cf00bd435b61c4b49fdad7bd6b95ed683238c4ba469c71f4df18af25655463d1";
assert.equal(createHash("sha256").update(observerSource).digest("hex"), observerSHA);
const observerCode = stripTypeScriptTypes(observerSource);
const { preserveFailures, createLifetimeObserver } = new Function(observerCode + "; return { preserveFailures, createLifetimeObserver };")();
const hash = bytes => createHash("sha256").update(bytes).digest("hex");

async function invokeNative(t, origin, invoke = runOpenClawConsumer, bind = withBasetenGuardObservation) {
  const diagnostics = [];
  await bind(source, hash(readFileSync(fixture)), guardContract => invoke({ diagnostic(message) { diagnostics.push(String(message)); t.diagnostic(message); } }, {
    source, sourceHead, fixture, testPath: "extensions/clawrouter/worker-baseten-decisions-contract.test.ts",
    env: { CLAWROUTER_CONTRACT_ORIGIN: origin, CLAWROUTER_BASETEN_CONTRACT: contract, CLAWROUTER_BASETEN_GUARD_CONTRACT: guardContract, NO_COLOR: "1" },
  }));
  const records = stripVTControlCharacters(diagnostics.join("\n")).split("\n").map(line => line.trim()).filter(line => line.startsWith("BASETEN_DECISIONS_RETIRED "))
    .map(line => JSON.parse(line.slice("BASETEN_DECISIONS_RETIRED ".length)));
  assert.deepEqual(records.map(row => row.id).sort(), [...ids].sort(), "exact unique original SDK case receipts");
  for (const row of records) {
    assert.deepEqual(Object.keys(row).sort(), ["acquisitions", "id", "readers", "reads", "releases"]);
    for (const field of ["acquisitions", "readers", "reads", "releases"]) assert.ok(Number.isSafeInteger(row[field]) && row[field] > 0, row.id + " original " + field);
    assert.equal(row.releases, row.acquisitions, row.id + " guard retirement");
    assert.ok(row.acquisitions >= (reaching.includes(row.id) ? 2 : 1), row.id + " actual transport acquisitions");
  }
  return records;
}

function routerFixture(allIds, expected, native) {
  return `import handler from "./worker/index.ts"; export * from "./worker/index.ts";
import { putGrantCredentials, revokeGrantCredentials } from "./worker/grant-credentials.ts";
${observerCode}
const ids = ${JSON.stringify(allIds)}, expected = ${JSON.stringify(expected)}, native = ${JSON.stringify(native)};
const lifetime = createLifetimeObserver(), ingress = createRequestBindings(), outbound = createRequestBindings(), requests = [], transitioned = new Set();
for (const id of expected) {
  ingress.expect(id, "decision", id === "manifest" ? ${JSON.stringify(manifestPath)} : ${JSON.stringify(nativePath)}, "POST", "clawrouter-live-baseten_" + id + "-fixture-secret");
  outbound.expect(id, "decision", "https://inference.baseten.co/v1/systemone", "POST", "synthetic-baseten-" + id + (id === "rotated" ? "-new" : ""));
}
const originalFetch = globalThis.fetch;
lifetime.patch(globalThis, "fetch", function (...args) {
  let owner;
  try {
    owner = outbound.claim(args[0], args[1], "decision");
    owner.ingress = ingress.bindings.find(row => row.id === owner.id && row.claimed);
    if (!owner.ingress) throw new Error("unbound Baseten outbound");
  } catch (error) { lifetime.errors.push(error); throw error; }
  lifetime.signal(owner, args[1]?.signal ?? (args[0] instanceof Request ? args[0].signal : undefined));
  return lifetime.invoke("fetch", originalFetch, this, args, owner, response => lifetime.response(response, owner));
});
function observeContext(context, owner) {
  const original = context.waitUntil;
  lifetime.patch(context, "waitUntil", function (...args) { lifetime.watch("waitUntil", args[0], owner); return Reflect.apply(original, context, args); });
}
async function transition(id, env) {
  if (!ids.includes(id) || transitioned.has(id)) throw new Error("unknown or duplicate Baseten transition");
  transitioned.add(id);
  const name = "baseten_" + id, policy = await env.POLICY_KV.get("policies/" + name, "json");
  if (id === "invalid") { const credential = await env.POLICY_KV.get("credentials/" + name, "json"); credential.enabled = false; await env.POLICY_KV.put("credentials/" + name, JSON.stringify(credential)); }
  if (id === "foreign") policy.providers = ["openai"];
  if (id === "budget") policy.monthlyBudgetMicros = 0;
  if (id === "unpriced") policy.requestCostMicros = null;
  if (id === "unmetered") { policy.monthlyBudgetMicros = null; policy.requestCostMicros = null; }
  await env.POLICY_KV.put("policies/" + name, JSON.stringify(policy));
  if (id === "revoked") await revokeGrantCredentials(env, "oauth/" + name + "/baseten", { provider: "baseten", kind: "api_key" });
  if (id === "rotated") await putGrantCredentials(env, "oauth/" + name + "/baseten", { provider: "baseten", kind: "api_key", enabled: true, credential: "synthetic-baseten-rotated-new" });
}
async function catalog(request, env, context, id) {
  const owner = { id, kind: "catalog" }; observeContext(context, owner);
  const response = await lifetime.invoke("catalog.handler", handler.fetch, handler, [request, env, context], owner);
  requests.push({ id, path: new URL(request.url).pathname, status: response.status });
  if (!transitioned.has(id) || !["stale", "foreign_offer", "wrong_format"].includes(id) || response.status !== 200) return response;
  // Negative projections only. Every successful offer comes from the shipping
  // Worker; no positive row, eligibility or route is fabricated.
  const body = await lifetime.invoke("catalog.json", response.json, response, [], owner);
  if (id === "stale") body.observedAt = "2000-01-01T00:00:00.000Z";
  if (id === "foreign_offer") for (const provider of body.providers) for (const offer of provider.offers ?? []) if (offer.endpoint === "systemone") offer.route = "https://foreign.example/systemone";
  if (id === "wrong_format") for (const provider of body.providers) for (const route of provider.routes ?? []) if (route.endpoint === "systemone") route.requestFormat = "openai.chat.completions";
  return Response.json(body, { status: response.status, headers: response.headers });
}
export default { ...handler, async fetch(request, env, context) {
  const path = new URL(request.url).pathname;
  if (path === "/fixture/grants") { for (const id of ids) await putGrantCredentials(env, "oauth/baseten_" + id + "/baseten", { provider: "baseten", kind: "api_key", enabled: true, credential: "synthetic-baseten-" + id }); return new Response(null, { status: 204 }); }
  if (path.startsWith("/fixture/transition/")) { await transition(path.split("/").pop(), env); return new Response(null, { status: 204 }); }
  if (path === "/fixture/requests") return Response.json(requests);
  if (path === "/fixture/retire") {
    let accepted = false;
    try { await preserveFailures(async () => { await lifetime.join(); ingress.verify(); outbound.verify(); }, [() => lifetime.restore()]); accepted = true; } catch (error) { lifetime.errors.push(error); }
    return Response.json({ ...lifetime.summary(), accepted, join: lifetime.joinDiagnostic() });
  }
  const configured = { ...env, BASETEN_API_KEY: "must-not-fallback", OPENAI_API_KEY: "must-not-fallback" };
  const auth = request.headers.get("authorization"), id = ids.find(id => auth === "Bearer clawrouter-live-baseten_" + id + "-fixture-secret");
  if (path === "/v1/catalog") return catalog(request, configured, context, id);
  if (![${JSON.stringify(nativePath)}, ${JSON.stringify(manifestPath)}].includes(path)) return handler.fetch(request, configured, context);
  requests.push({ id, path, method: request.method, authorization: auth });
  // Unpriced direct calls are intentionally denied before an outbound owner.
  const owner = expected.includes(id) ? (() => {
    for (const row of ingress.bindings) if (row.url.startsWith("/")) row.url = new URL(request.url).origin + row.url;
    try { return ingress.claim(request, undefined, "decision"); } catch (error) { lifetime.errors.push(error); throw error; }
  })() : { id, kind: "denied" };
  owner.request = request; lifetime.signal(owner, request.signal); observeContext(context, owner);
  return lifetime.invoke("handler", handler.fetch, handler, [request, configured, context], owner);
} };`;
}

function upstreamFixture(expected) {
  return `${observerCode}
const lifetime = createLifetimeObserver(), bindings = createRequestBindings(), calls = [];
for (const id of ${JSON.stringify(expected)}) bindings.expect(id, "decision", "https://inference.baseten.co/v1/systemone", "POST", "synthetic-baseten-" + id + (id === "rotated" ? "-new" : ""));
async function serve(request, context, owner) {
  const body = await lifetime.invoke("request.json", request.json, request, [], owner), id = owner.id;
  const row = { id, url: request.url, authorization: request.headers.get("authorization"), body, redirect: request.redirect, completed: false, canceled: 0, expired: false };
  calls.push(row);
  const output = ${JSON.stringify(nativeOutput)};
  if (id === "malformed") delete output.answers.route;
  if (id === "usage") output.usage.output_tokens = 4;
  if (id === "overflow") output.padding = "x".repeat(1024 * 1024 + 1);
  const bytes = new TextEncoder().encode(JSON.stringify(id === "provider_error" ? { error: { message: "synthetic provider failure" } } : output));
  let offset = 0, finished = false, timer, resolve, reject;
  const completion = new Promise((yes, no) => { resolve = yes; reject = no; });
  lifetime.watch("source.completion", completion, owner); context.waitUntil(completion);
  const finish = error => { if (finished) return; finished = true; clearTimeout(timer); row.completed = true; if (error !== undefined) reject(error); else resolve(); };
  timer = setTimeout(() => { row.expired = true; finish(new Error("Baseten source deadline")); }, 10000);
  const source = {
    pull(controller) { if (offset === bytes.length) { controller.close(); finish(); return; } const end = Math.min(offset + (id === "overflow" ? 8192 : 19), bytes.length); controller.enqueue(bytes.slice(offset, end)); offset = end; },
    cancel() { row.canceled++; finish(); },
  };
  for (const kind of ["pull", "cancel"]) { const original = source[kind]; lifetime.patch(source, kind, function (...args) { return lifetime.invoke("source." + kind, original, this, args, owner); }); }
  return new Response(new ReadableStream(source, { highWaterMark: 0 }), { status: id === "provider_error" ? 503 : 200, headers: { "content-type": "application/json" } });
}
export default { fetch(request, env, context) {
  if (request.url === "https://fixture.example/state") return Response.json(calls);
  if (request.url === "https://fixture.example/retire") return (async () => {
    let accepted = false;
    try { await preserveFailures(async () => { await lifetime.join(); bindings.verify(); if (calls.some(row => !row.completed || row.expired || row.canceled > 1)) throw new Error("Baseten source retirement failed"); }, [() => lifetime.restore()]); accepted = true; } catch (error) { lifetime.errors.push(error); }
    return Response.json({ ...lifetime.summary(), accepted, calls, join: lifetime.joinDiagnostic() });
  })();
  let owner; try { owner = bindings.claim(request, undefined, "decision"); } catch (error) { lifetime.errors.push(error); throw error; }
  lifetime.signal(owner, request.signal);
  const original = context.waitUntil;
  lifetime.patch(context, "waitUntil", function (...args) { lifetime.watch("waitUntil", args[0], owner); return Reflect.apply(original, context, args); });
  return lifetime.invoke("handler", serve, undefined, [request, context, owner], owner);
} };`;
}

function assertProof(value) {
  assert.equal(value.accepted, true, JSON.stringify(value)); assert.equal(value.operations, value.settled);
  assert.equal(value.rejected, 0); assert.equal(value.readers, value.unlocked);
}
async function json(response, expected = 200) { const text = await response.text(); assert.equal(response.status, expected, text); return text ? JSON.parse(text) : null; }
async function withFixture(native, run) {
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-baseten-decisions-"));
  const allIds = native ? ids : directIds, expected = native ? reaching : directIds.filter(id => id !== "unpriced"); let mf;
  await preserveFailures(async () => {
    mf = await startWorkerdFixture(temporary, routerFixture(allIds, expected, native), upstreamFixture(expected));
    const kv = await mf.getKVNamespace("POLICY_KV", "router");
    for (const id of allIds) {
      const name = "baseten_" + id;
      await kv.put("policies/" + name, JSON.stringify({ enabled: true, generation: "fixture", providers: ["baseten"], tenantId: "fixture",
        grantRouting: { eligibleGrants: { baseten: ["baseten"] }, environmentFallback: false }, monthlyBudgetMicros: 100000,
        budgetMode: "reserve", requestCostMicros: 17, retainRequestContent: false }));
      await kv.put("credentials/" + name, JSON.stringify({ enabled: true, secretSha256: hash("fixture-secret"), policyId: name, policyGeneration: "fixture" }));
    }
    await kv.put("connections/baseten", JSON.stringify({ providerId: "baseten", enabled: true }));
    const origin = String(await mf.ready).replace(/\/$/, ""), upstream = await mf.getWorker("upstream");
    await json(await fetch(origin + "/fixture/grants"), 204);
    const catalog = await json(await fetch(origin + "/v1/catalog", { headers: { authorization: "Bearer " + key(allIds[0]) } }));
    const allOffers = catalog.providers.find(provider => provider.id === "baseten").offers.filter(row => row.endpoint === "systemone");
    const offers = allOffers.filter(row => row.modelId !== null);
    assert.deepEqual(offers.map(row => row.modelId).sort(), models.map(model => "baseten/" + model).sort());
    assert.ok(offers.every(row => row.eligible && row.routeKind === "native" && row.route === nativePath), JSON.stringify(offers));
    assert.equal(catalog.providers.find(row => row.id === "baseten").routes.find(row => row.endpoint === "systemone").requestFormat, "baseten.systemone");
    await run({ mf, origin, upstream });
  }, [async () => {
    if (mf) await preserveFailures(async () => assertProof(await json(await (await mf.getWorker("upstream")).fetch("https://fixture.example/retire"))), [async () => assertProof(await json(await mf.dispatchFetch("https://fixture.example/fixture/retire")))]);
  }, async () => { await mf?.dispose(); }, () => rm(temporary, { recursive: true, force: true })]);
}

async function verifyCallsAndUsage(origin, upstream, expected) {
  const calls = await json(await upstream.fetch("https://fixture.example/state"));
  assert.deepEqual(calls.map(row => row.id).sort(), [...expected].sort(), "one original dispatch per independent request");
  for (const row of calls) {
    assert.equal(row.url, "https://inference.baseten.co/v1/systemone"); assert.equal(row.authorization, "Bearer " + secret(row.id)); assert.equal(row.redirect, "manual");
    assert.deepEqual(row.body, nativeBody(row.id), row.id + " exact encoded wire");
    assert.doesNotMatch(JSON.stringify(row.body), /clawrouter-live-|must-not-fallback|synthetic-baseten-/);
    let usage;
    const amount = row.id === "unmetered" ? 1 : 17;
    for (let i = 0; i < 200; i++) {
      usage = await json(await fetch(origin + "/v1/usage", { headers: { authorization: "Bearer " + key(row.id) } }));
      if (usage.usage.events.length === 1 && (row.id === "unmetered" || usage.budget.spentMicros === amount)) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(usage.usage.events.length, 1, row.id + " delivered accounting receipt");
    const event = usage.usage.events[0];
    assert.deepEqual([event.provider, event.credential_id, event.policy_id, event.model, event.capability], ["baseten", "baseten_" + row.id, "baseten_" + row.id, "baseten/" + selectedModel(row.id), "llm.decisions"], row.id);
    assert.equal(event.actual_cost_micros, amount, row.id); assert.equal(event.cost_basis, row.id === "unmetered" ? "flat_fallback" : "policy_fixed", row.id);
    if (positives.includes(row.id) || ["native", "manifest"].includes(row.id)) {
      assert.equal(event.status, "success", row.id); assert.deepEqual([event.input_tokens, event.output_tokens, event.total_tokens], [11, 3, 14], row.id);
    } else { assert.equal(event.status, "provider_error", row.id); assert.deepEqual([event.input_tokens, event.output_tokens, event.total_tokens], [null, null, null], row.id); }
    if (row.id !== "unmetered") assert.equal(usage.budget.spentMicros, amount, row.id + " settled budget");
    assert.doesNotMatch(JSON.stringify(event), /synthetic damaged|synthetic-baseten-|fixture-secret/);
  }
}

test("actual Baseten native and manifest routes preserve finite decisions, limits and SQLite settlement", { timeout: 60000 }, async () => {
  await withFixture(false, async ({ origin, upstream }) => {
    for (const id of directIds) {
      await json(await fetch(origin + "/fixture/transition/" + id, { method: "POST" }), 204);
      const body = nativeBody(id), response = await fetch(origin + (id === "manifest" ? manifestPath : nativePath), { method: "POST", headers: { authorization: "Bearer " + key(id), "content-type": "application/json" },
        body: JSON.stringify(id === "manifest" ? { model: "baseten/" + selectedModel(id), body } : body) });
      const expected = id === "unpriced" ? 400 : ["malformed", "usage", "overflow"].includes(id) ? 502 : id === "provider_error" ? 502 : 200;
      const value = await json(response, expected);
      if (expected === 200) assert.deepEqual(value, nativeOutput);
    }
    await verifyCallsAndUsage(origin, upstream, directIds.filter(id => id !== "unpriced"));
  });
});

test("actual registered Baseten DecisionV2 SDK through Worker and SQLite", { skip: !source, timeout: 300000 }, async t => {
  await withFixture(true, async ({ origin, upstream }) => {
    await invokeNative(t, origin);
    await verifyCallsAndUsage(origin, upstream, reaching);
    const requests = await json(await fetch(origin + "/fixture/requests"));
    assert.deepEqual(requests.filter(row => row.method === "POST").map(row => row.id).sort(), [...reaching].sort());
    assert.ok(requests.some(row => row.id === "invalid" && row.path === "/v1/catalog" && row.status === 401));
    for (const id of ids.filter(id => !reaching.includes(id) && id !== "invalid")) {
      const receipt = await json(await fetch(origin + "/v1/usage", { headers: { authorization: "Bearer " + key(id) } }));
      assert.equal(receipt.usage.events.length, 0, id + " no inference receipt"); assert.equal(receipt.budget.spentMicros, 0, id + " no debit");
    }
  });
});

test("Baseten runner binds exact source, real registry path, both callsites and complete original receipts", async () => {
  const rows = parse(readFileSync(new URL("../.github/workflows/openclaw-contract.yml", import.meta.url), "utf8")).jobs.consumer.strategy.matrix.include;
  assert.deepEqual(rows.filter(row => row.consumer === "baseten-decisions"), [{ consumer: "baseten-decisions", ref: sourceHead, test: "test/openclaw-baseten-decisions.test.mjs" }]);
  assert.equal(new Set(rows.map(row => row.consumer)).size, rows.length); assert.equal(basetenGuardPin, sourceHead);
  const text = readFileSync(fixture, "utf8"); assert.doesNotThrow(() => stripTypeScriptTypes(text));
  assert.match(text, /acquireAgentRunPreparedModelRuntime/); assert.match(text, /createDecisionTool/); assert.doesNotMatch(text, /vi\.spyOn|offers:\s*\[/);
  assert.match(text, /expect\(isMainThread\)\.toBe\(true\)/);
  const guardContract = "a".repeat(64), bind = async (root, sha, run) => { assert.equal(root, source); assert.equal(sha, hash(readFileSync(fixture))); return run(guardContract); };
  const receipts = ids.map(id => "BASETEN_DECISIONS_RETIRED " + JSON.stringify({ id, acquisitions: 2, reads: 3, readers: 2, releases: 2 }));
  const invoke = lines => async (t, options) => {
    assert.equal(options.sourceHead, sourceHead); assert.equal(options.fixture.href, fixture.href); assert.equal(options.testPath, "extensions/clawrouter/worker-baseten-decisions-contract.test.ts");
    assert.deepEqual(options.env, { CLAWROUTER_CONTRACT_ORIGIN: "https://router.example", CLAWROUTER_BASETEN_CONTRACT: contract, CLAWROUTER_BASETEN_GUARD_CONTRACT: guardContract, NO_COLOR: "1" });
    t.diagnostic(lines.join("\n"));
  };
  await invokeNative({ diagnostic() {} }, "https://router.example", invoke(receipts), bind);
  for (const lines of [[], receipts.slice(1), [...receipts, receipts[0]], receipts.map(line => line.replace("BASETEN_DECISIONS", "VYDRA_MODELS")), receipts.map(line => line.replace('"releases":2', '"releases":0'))])
    await assert.rejects(invokeNative({ diagnostic() {} }, "https://router.example", invoke(lines), bind));
});

test("Baseten injected fixture joins the native database owner without changing existing members", () => {
  const original = 'export const databaseWorkerExtensionTestRoots = ["extensions/memory-core"];\nexport const databaseWorkerExtensionTestFiles = [\n  "extensions/clawrouter/speech-provider.test.ts",\n];\n';
  const added = '  "extensions/clawrouter/worker-baseten-decisions-contract.test.ts",\n';
  const output = registerBasetenDatabaseOwner(original);
  assert.equal(output.split(added).length, 2); assert.equal(output.replace(added, ""), original);
  assert.throws(() => registerBasetenDatabaseOwner(output), /already has an owner/);
  assert.throws(() => registerBasetenDatabaseOwner(original + original), /one native database owner list/);
  assert.throws(() => registerBasetenDatabaseOwner("export const files = [];"), /one native database owner list/);
});

test("Baseten original ledger retains undefined failures, held work and independent cleanup", async () => {
  for (const reason of [undefined, null, new Error("synthetic independent fault")]) {
    const life = createLifetimeObserver(), original = Promise.reject(reason); original.catch(() => {});
    assert.equal(life.watch("release", original, {}), original); await assert.rejects(life.join(), error => error.errors.includes(reason));
  }
  const life = createLifetimeObserver(); let release, completed = false;
  life.watch("source.completion", new Promise(resolve => { release = resolve; }), {});
  const joining = life.join().then(() => { completed = true; }); await Promise.resolve(); assert.equal(completed, false); release(); await joining;
  const attempted = [];
  await assert.rejects(preserveFailures(() => { throw undefined; }, [() => { attempted.push(1); throw null; }, () => attempted.push(2)]), error => error.errors[0] === undefined && error.errors[1] === null);
  assert.deepEqual(attempted, [1, 2]);
});

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

test("compiled Baseten callsite preserves operands, promise and falsey outcomes independently of observation", async () => {
  const contract = "b".repeat(64), modules = new Set(), observed = [], context = {};
  runInNewContext('"use strict";\n' + stripTypeScriptTypes(basetenGuardPrelude(contract)) + ";globalThis.invoke = __basetenGuardInvoke;", context);
  context[Symbol.for("clawrouter.baseten.guard." + contract)] = { modules, observe(...args) { observed.push(args); } };
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
  context[Symbol.for("clawrouter.baseten.guard." + contract)].observe = () => { throw undefined; };
  assert.equal(context.invoke(() => promise, input), promise);
  assert.deepEqual(Array.from([...modules][0].faults), [undefined]);
  assert.throws(() => basetenGuardPrelude("wrong"));
  assert.throws(() => overlayBasetenGuardSource(Buffer.from("changed source"), contract), /callsite changed/);
});


test("Baseten restoration rejects a pathname replacement before or during the held-inode write", async () => {
  const stat = { dev: 1, ino: 2, uid: 3, nlink: 1, mode: 0o100644 };
  const original = Buffer.from("original"), output = Buffer.from("observed");
  for (const replacement of ["none", "before", "during"]) {
    let pathStat = replacement === "before" ? { ...stat, ino: 4 } : stat, held = output, writes = 0;
    const file = { stat: async () => stat }, row = { file, path: "owned.ts", stat, bytes: original, output, changed: true, applied: true };
    const restoration = restoreBasetenGuardSource(row, async () => ({ bytes: held, stat }), async (target, bytes) => {
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
  await restoreBasetenGuardSource(row, async () => ({ bytes: Buffer.from("partial"), stat }), async (_file, bytes) => { restored = bytes; }, async () => stat);
  assert.equal(restored, original);
});

test("Baseten observation binds actual site, credential, callee and acquired object, including detached release", async () => {
  const text = readFileSync(fixture, "utf8"), start = text.indexOf("function observe<T>"), end = text.indexOf("beforeEach(() =>", start);
  const rows = [], tails = [], faults = [], acquisitions = [], readers = [], identities = new Map();
  const origin = "https://router.example", activeId = "elephant";
  const context = { rows, tails, faults, acquisitions, readers, identities, origin, activeId, assert, URL, Headers, key,
    expect(value) { return { toBe: expected => assert.equal(value, expected), toHaveLength: expected => assert.equal(value.length, expected),
      toContain: expected => assert.ok(value.includes(expected)), toBeDefined: () => assert.notEqual(value, undefined), toBeNull: () => assert.equal(value, null) }; } };
  runInNewContext('"use strict";\n' + stripTypeScriptTypes(text.slice(start, end)) + ";globalThis.observed = observeGuard;", context);
  const module = { site: "decision", faults: [] }, callee = () => {};
  const input = { url: origin + nativePath, init: { headers: { authorization: "Bearer " + key(activeId) } } };
  const releasePromise = Promise.resolve(), response = new Response(new Uint8Array([1])); let released = 0;
  const result = { response, release: function (...args) { assert.equal(this, undefined); assert.deepEqual(args, []); released++; return releasePromise; } };
  const original = Promise.resolve(result);
  context.observed(module, callee, undefined, [input], true, original); await Promise.all(tails.splice(0));
  assert.equal(rows[0].original, original); assert.equal(rows[0].result, result); assert.equal(rows[0].fn, callee); assert.equal(rows[0].args[0], input);
  assert.equal(acquisitions[0].result, result);
  const reader = response.body.getReader(); await reader.read(); await reader.read(); reader.releaseLock();
  const detached = result.release; assert.equal(detached(), releasePromise); await Promise.all(tails.splice(0));
  assert.equal(released, 1); assert.equal(acquisitions[0].releases, 1); assert.equal(readers[0].unlocks, 1); assert.equal(response.body.locked, false);
  assert.deepEqual(faults, []); assert.ok(rows.every(row => row.state === "fulfilled"));
  for (const args of [
    [{ site: "decision", faults: [] }, callee, undefined, [input]], [module, () => {}, undefined, [input]], [module, callee, {}, [input]],
    [module, callee, undefined, []], [module, callee, undefined, [{ ...input, url: "https://foreign.example/systemone" }]],
    [module, callee, undefined, [{ ...input, init: { headers: { authorization: "Bearer foreign" } } }]],
  ]) assert.throws(() => context.observed(...args, true, original));
  let reads = 0;
  const accessor = { get url() { reads++; throw undefined; }, init: input.init };
  assert.throws(() => context.observed(module, callee, undefined, [accessor], true, original)); assert.equal(reads, 0);
  context.observed(module, callee, undefined, [input], false, undefined);
  assert.equal(rows.at(-1).state, "rejected"); assert.equal(rows.at(-1).error, undefined); assert.equal(acquisitions.length, 1);
});

test("Baseten acquired body cancellation preserves originals and cannot hide held or falsey cleanup failures", async () => {
  const text = readFileSync(fixture, "utf8"), start = text.indexOf("function observe<T>"), end = text.indexOf("function observeGuard(", start);
  const cleanupStart = text.indexOf("afterEach(async () =>"), cleanupEnd = text.indexOf("const batch =", cleanupStart);
  for (const mode of ["fulfilled", "held", "rejected-undefined", "cancel-and-release", "foreign-body"]) {
    const rows = [], tails = [], faults = [], acquisitions = [], readers = []; let cleanup, joined = false, finish, calls = 0, releases = 0;
    const reason = {}, cancelPromise = mode === "held" ? new Promise(resolve => { finish = resolve; })
      : mode === "rejected-undefined" || mode === "cancel-and-release" ? Promise.reject(undefined) : Promise.resolve();
    cancelPromise.catch(() => {});
    const releasePromise = mode === "cancel-and-release" ? Promise.reject(reason) : Promise.resolve(); releasePromise.catch(() => {});
    const body = { getReader() { throw new Error("not used by this original-body control"); }, cancel: function (...args) { calls++; assert.equal(args[0], reason); assert.equal(this, mode === "foreign-body" ? foreign : body); return cancelPromise; } }, foreign = {};
    const result = { response: { body }, release: function () { assert.equal(this, undefined); releases++; return releasePromise; } };
    const context = { rows, tails, faults, acquisitions, readers, identities: new Map(), guardChannel: undefined, guardKey: Symbol("unused"), retired: undefined,
      afterEach(fn) { cleanup = fn; }, expect(value) { return { toBe: expected => assert.equal(value, expected), toEqual: expected => assert.deepEqual(Array.from(value), Array.from(expected)) }; } };
    runInNewContext('"use strict";\n' + stripTypeScriptTypes(text.slice(start, end)) + ";globalThis.install = installAcquisition;\n" + stripTypeScriptTypes(text.slice(cleanupStart, cleanupEnd)), context);
    // An empty channel is the actual no-observer cleanup state for this isolated
    // acquired-body control; there is no manufactured transport acquisition.
    context.guardChannel = { modules: new Set() }; context[context.guardKey] = context.guardChannel;
    context.install(result);
    assert.equal(body.cancel.call(mode === "foreign-body" ? foreign : body, reason), cancelPromise);
    const detached = result.release; assert.equal(detached(), releasePromise);
    const joining = cleanup().then(() => { joined = true; return { accepted: true }; }, error => { joined = true; return { accepted: false, error }; });
    if (mode === "held") { await Promise.resolve(); await Promise.resolve(); assert.equal(joined, false); finish(); }
    const outcome = await joining; assert.equal(outcome.accepted, mode === "fulfilled" || mode === "held", mode);
    assert.equal(calls, 1); assert.equal(releases, 1);
    const cancel = rows.find(row => row.kind === "body.cancel"); assert.equal(cancel.original, cancelPromise); assert.equal(cancel.args[0], reason); assert.equal(cancel.receiver, mode === "foreign-body" ? foreign : body);
    if (mode === "rejected-undefined" || mode === "cancel-and-release") { assert.equal(cancel.state, "rejected"); assert.equal(cancel.error, undefined); }
    if (mode === "cancel-and-release") { assert.equal(rows.filter(row => row.state === "rejected").length, 2); assert.equal(rows.find(row => row.kind === "release").error, reason); }
  }
});

