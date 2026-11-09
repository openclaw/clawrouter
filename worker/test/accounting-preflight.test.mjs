import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
const { admitAccountingJson, accountingArchive, accountingIdentity, isAccountingAdmissionFailure } = await import("../json-body.ts");
const { createProxyAccounting, accountingReceipt, admitAccountingFacts } = await import("../proxy-accounting.ts");
const { planBudgetReservation, reserveBudget } = await import("../accounting.ts");
const { prepareSoftBudget } = await import("../soft-budget.ts");
const { prepareContentRetention } = await import("../content-retention.ts");
const { normalizeFusionConfig, prepareFusionAccounting, buildFusionReservationProposals } = await import("../fusion.ts");
const { searchJsonBytes, MiniMaxSearchOperation } = await import("../minimax-search-operation.ts");
const { fundRealtimeUnit } = await import("../realtime-accounting.ts");
const { accessBytesResponse } = await import("./access-byte-fixture.mjs");

const denied = error => error?.status === 503 && error.code === "accounting_preflight_unavailable" && isAccountingAdmissionFailure(error);
const auth = () => ({ policyId: "fixture", credentialId: "key", principalId: "member", authType: "proxy_key",
  policy: { tenantId: "tenant", monthlyBudgetMicros: 1000, dailyBudgetMicros: 1000, weeklyBudgetMicros: 1000, retainRequestContent: true } });
const connection = { providerId: "fixture", monthlyBudgetMicros: 1000 };
const cost = { reserveMicros: 10, basis: "policy_fixed", inputTokens: null, outputTokens: null };
const selection = () => ({ provider: { id: "fixture" }, model: null, capability: "llm.chat", method: "POST",
  endpoint: { request_format: "openai.chat_completions", response_format: "openai.chat_completions" }, body: { messages: [{ role: "user", content: "fixture" }] } });
const request = () => new Request("https://router.example/v1/chat/completions", { headers: { "x-request-id": "fixture-request" } });

async function consumeArchiveReader(reader) {
  const parts = [], cleanup = [];
  let maximumBacking = 0, hasPrimary = false, primary;
  try {
    for (;;) { const next = await reader.read(); if (next.done) break; maximumBacking = Math.max(maximumBacking, next.value.buffer.byteLength); parts.push(next.value); }
  } catch (error) { hasPrimary = true; primary = error; }
  finally {
    try { await reader.cancel(); } catch (error) { cleanup.push(error); }
    try { reader.releaseLock(); } catch (error) { cleanup.push(error); }
  }
  if (cleanup.length) throw new AggregateError(hasPrimary ? [primary, ...cleanup] : cleanup, "archive reader cleanup failed");
  if (hasPrimary) throw primary;
  return { parts, maximumBacking };
}

for (const [name, profile, accepted, rejected] of [
  ["intent scalar", "intent", "a".repeat(2048), "a".repeat(2049)],
  ["intent key", "intent", { ["k".repeat(128)]: 0 }, { ["k".repeat(129)]: 0 }],
  ["intent array entries", "intent", Array(64).fill(0), Array(65).fill(0)],
  ["intent members", "intent", Object.fromEntries(Array.from({ length: 128 }, (_, i) => [String(i), 0])), Object.fromEntries(Array.from({ length: 129 }, (_, i) => [String(i), 0]))],
  ["intent containers", "intent", Array.from({ length: 63 }, () => ({})), Array.from({ length: 64 }, () => ({}))],
  ["capsule array entries", "capsule", Array(256).fill(0), Array(257).fill(0)],
  ["capsule members", "capsule", Object.fromEntries(Array.from({ length: 512 }, (_, i) => [String(i), 0])), Object.fromEntries(Array.from({ length: 513 }, (_, i) => [String(i), 0]))],
]) test(`accounting preflight ${name}: exact and +1`, () => {
  assert.doesNotThrow(() => admitAccountingJson(accepted, profile));
  assert.throws(() => admitAccountingJson(rejected, profile), denied);
});

test("serialized escaped bytes/text and cumulative strings are independent", () => {
  // Two values stay below scalar/string/member ceilings; escapes reach wire first.
  const exact = { a: "\0".repeat(2048), b: "x".repeat(2048), c: "x".repeat(2032) };
  assert.equal(JSON.stringify(exact).length, 16390);
  exact.c = exact.c.slice(6);
  assert.equal(admitAccountingJson(exact, "intent").bytes, 16384);
  assert.throws(() => admitAccountingJson({ ...exact, c: exact.c + "x" }, "intent"), denied);
  const strings = Array(4).fill("x".repeat(2048));
  assert.doesNotThrow(() => admitAccountingJson(strings, "intent"));
  assert.throws(() => admitAccountingJson([...strings, "x"], "intent"), denied);
  assert.doesNotThrow(() => accountingIdentity("x".repeat(1024)));
  assert.throws(() => accountingIdentity("x".repeat(1025)), denied);
});

test("four-leg last-provider overflow precedes ALL reserve attempts and status preparation", async () => {
  let attempts = 0;
  const env = { BUDGET_LEDGER: { idFromName() { attempts++; throw new Error("must not materialize"); } } };
  const plan = planBudgetReservation(auth(), "llm.chat", cost, connection);
  assert.deepEqual(plan.legs.map(leg => leg.kind), ["policy", "daily", "weekly", "provider"]);
  await assert.rejects(reserveBudget(env, auth(), "llm.chat", cost, { ...connection, providerId: "p".repeat(1025) }), denied);
  assert.throws(() => prepareSoftBudget(auth(), "llm.chat", { ...connection, providerId: "p".repeat(1025) }, "usage"), denied);
  assert.equal(attempts, 0);
});

for (const [name, provider, limit, providerLimit, status, code] of [
  ["unpriced modifier", "anthropic", 1000, 1000, 400, "pricing_required"],
  ["policy zero", "openai", 0, 1000, 402, "budget_exhausted"],
  ["provider zero", "openai", 1000, 0, 402, "provider_budget_exhausted"],
]) test(`HTTP pure-plan ${name} preserves one ordinary failure receipt before effects`, async t => {
  const { default: handler } = await import("../index.ts");
  const { usageEnv, proxyKey } = await import("./usage-budget-fixture.mjs");
  const env = usageEnv([], { provider, limit, providerLimit, fixedCost: null, retainContent: true });
  env[provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"] = "fixture-key";
  const events = [], roots = [], effects = { budget: 0, posts: 0, archive: 0 };
  let hasPrimary = false, primary;
  const track = root => { roots.push(root.then(() => ({ failed: false }), error => ({ failed: true, error }))); return root; };
  t.after(async () => {
    const failures = []; let index = 0;
    while (index < roots.length) { const batch = roots.slice(index); index = roots.length; for (const value of await Promise.all(batch)) if (value.failed) failures.push(value.error); }
    if (failures.length) throw new AggregateError(hasPrimary ? [primary, ...failures] : failures, "plan-denial roots");
  });
  env.USAGE_QUEUE = { async send(event) { events.push(event); } };
  env.BUDGET_LEDGER = { idFromName: value => value, get: () => ({ async fetch() { effects.budget++; throw Error("unexpected budget I/O"); } }) };
  env.CONTENT_ARCHIVE = { async put() { effects.archive++; throw Error("unexpected archive I/O"); } };
  t.mock.method(globalThis, "fetch", async () => { effects.posts++; throw Error("unexpected provider I/O"); });
  try {
    const anthropic = provider === "anthropic", requestId = "fixture-plan-denial";
    const body = { model: anthropic ? "anthropic/claude-sonnet-5-5" : "openai/gpt-6-astra",
      messages: [{ role: "user", content: "fixture" }], max_tokens: 32, ...(anthropic ? { speed: "fast" } : {}) };
    const result = await track(handler.fetch(new Request("https://router.example" + (anthropic ? "/v1/messages" : "/v1/chat/completions"), {
      method: "POST", headers: { authorization: `Bearer ${proxyKey()}`, "content-type": "application/json", "x-request-id": requestId }, body: JSON.stringify(body),
    }), env, { waitUntil: track }).then(async response => ({ status: response.status, code: response.headers.get("x-clawrouter-error-code"), body: await response.json() })));
    assert.equal(result.status, status);
    assert.equal(anthropic ? result.code : result.body.error.code, code);
    let index = 0; while (index < roots.length) { const batch = roots.slice(index); index = roots.length; await Promise.all(batch); }
    assert.equal(events.length, 1); assert.equal(events[0].request_id, requestId);
    assert.equal(events[0].status_code, status); assert.equal(events[0].status, status === 402 ? "denied" : "client_error");
    assert.equal(events[0].actual_cost_micros, 0); assert.equal(events[0].reserved_cost_micros, 0);
    assert.deepEqual(effects, { budget: 0, posts: 0, archive: 0 });
  } catch (error) { hasPrimary = true; primary = error; throw error; }
});

for (const target of ["policy", "provider", "capacity"]) test(`Realtime pure-plan ${target} keeps existing failure accounting and terminal capacity denial`, async () => {
  const a = auth(), c = { ...connection }, events = [];
  let budgetCalls = 0;
  if (target === "policy") a.policy.monthlyBudgetMicros = 0;
  if (target === "provider") c.monthlyBudgetMicros = 0;
  if (target === "capacity") c.providerId = "p".repeat(1025);
  const env = { USAGE_QUEUE: { async send(event) { events.push(event); } },
    BUDGET_LEDGER: { idFromName() { budgetCalls++; throw Error("unexpected budget I/O"); } } };
  await assert.rejects(fundRealtimeUnit({ request: request(), env, context: {}, auth: a, selection: selection(), connection: c,
    grantKey: null, grantLane: "api_key", signal: new AbortController().signal, unitId: "fixture-unit", outputCap: 100 }),
  target === "capacity" ? denied : error => error.status === 402 && error.code === (target === "policy" ? "budget_exhausted" : "provider_budget_exhausted"));
  assert.equal(budgetCalls, 0); assert.equal(events.length, target === "capacity" ? 0 : 1);
  if (events.length) {
    assert.equal(events[0].request_id, "fixture-request");
    // Preserve this owner's existing failure receipt classification.
    assert.equal(events[0].status_code, 503); assert.equal(events[0].status, "provider_error");
    assert.equal(events[0].actual_cost_micros, 0); assert.equal(events[0].reserved_cost_micros, 0);
  }
});

test("private facts survive borrowed mutation and terminal receipt growth without re-admission", async () => {
  const a = auth(), selected = selection(), borrowedCost = { ...cost };
  const events = [], roots = [];
  const accounting = createProxyAccounting({ env: { USAGE_QUEUE: { send: async event => events.push(event) } },
    context: { waitUntil: root => roots.push(root) }, auth: a, selection: selected, request: request(), cost: borrowedCost });
  const original = JSON.stringify(accounting.facts);
  a.policyId = "changed"; selected.provider.id = "changed"; borrowedCost.reserveMicros = 999;
  selected.body.messages[0].content = "changed";
  assert.equal(JSON.stringify(accounting.facts), original);
  assert.equal(Object.isFrozen(a), false); assert.equal(Object.isFrozen(borrowedCost), false);
  assert.throws(() => { accounting.facts.event.policy_id = "forged"; }, TypeError);
  const reservation = { reservations: [], reservedMicros: 10 };
  for (const status of ["success", "client_error", "provider_error"]) {
    const event = accountingReceipt(accounting.facts, { occurredAtMs: Date.now(), statusCode: 200, status,
      billable: true, tokens: null, reservation, contentRef: "content_" + "a".repeat(32) });
    assert.doesNotThrow(() => admitAccountingJson(event, "capsule"));
    assert.equal(event.policy_id, "fixture");
  }
  assert.equal(await accounting.settle(200, "success", true, null, reservation, null), true);
  assert.equal(events.length, 1); assert.equal(events[0].id, accounting.facts.event.id);
  await Promise.all(roots);
});

test("future event capacity is admitted with the complete capsule, before copying prices", () => {
  const accounting = createProxyAccounting({ env: {}, context: {}, auth: auth(), selection: selection(), request: request(), cost });
  assert.doesNotThrow(() => admitAccountingFacts(accounting.facts));
  const facts = { ...accounting.facts, model: { upstream: "fixture", pricing: { source: "x".repeat(2049) } } };
  assert.throws(() => admitAccountingFacts(facts), denied);
});

test("TEXT archive bytes preserve JSON semantics, own proto and borrowed mutation", async () => {
  const source = JSON.parse('{"__proto__":{"value":"own"},"first":1,"last":2}');
  Object.assign(source, { unicode: "a\ud800😀\udfff", absent: undefined, values: [undefined, -0, NaN, Infinity, null] });
  const expected = JSON.stringify(source), archive = accountingArchive(source);
  source.first = 9; source.__proto__.value = "changed";
  const stream = archive.stream(), reader = stream.getReader();
  const { parts, maximumBacking } = await consumeArchiveReader(reader);
  assert.equal(await new Blob(parts).text(), expected);
  assert.ok(maximumBacking <= 32768); assert.equal(stream.locked, false); assert.equal(archive.retired, true);
  assert.equal(Object.isFrozen(source), false);
});

test("CPU archive sink drains original bounded chunks through EOF without materializing JSON", async () => {
  const { consumeCpuArchive } = await import("../../test/helpers/http-cpu.mjs");
  let pulls = 0, eof = false, writes = 0;
  const stream = new ReadableStream({ pull(controller) {
    if (pulls++ < 2) controller.enqueue(new Uint8Array(32768));
    else { eof = true; controller.close(); }
  } }, { highWaterMark: 0 });
  await consumeCpuArchive(stream);
  assert.equal(eof, true); writes++;
  assert.equal(pulls, 3); assert.equal(stream.locked, false); assert.equal(writes, 1);
  await consumeCpuArchive("{}");
});

for (const reason of [undefined, new Error("shared CPU sink failure")]) test(`CPU archive joins held original cancellation and independent unlock failure: ${reason === undefined ? "undefined" : "shared reason"}`, async t => {
  const { consumeCpuArchive } = await import("../../test/helpers/http-cpu.mjs");
  let release, arrived, outcome, expectedFailure = false, hasPrimary = false, primary, unlocked = 0;
  const held = new Promise(resolve => { release = resolve; }), entered = new Promise(resolve => { arrived = resolve; });
  const stream = new ReadableStream({ async cancel() { arrived(); await held; throw reason; } }, { highWaterMark: 0 });
  const reader = stream.getReader(), unlock = reader.releaseLock.bind(reader);
  t.after(async () => {
    release();
    const result = await outcome;
    if (stream.locked) unlock();
    if (result?.failed && !expectedFailure) throw new AggregateError(hasPrimary ? [primary, result.error] : [result.error], "CPU sink root");
  });
  t.mock.method(stream, "getReader", () => reader);
  // Labelled read failure; cancellation below is the ORIGINAL native operation.
  t.mock.method(reader, "read", () => Promise.reject(reason));
  t.mock.method(reader, "releaseLock", () => { unlock(); unlocked++; throw reason; });
  try {
    const work = consumeCpuArchive(stream);
    outcome = work.then(() => ({ failed: false }), error => ({ failed: true, error }));
    let done = false; void outcome.then(() => { done = true; });
    await Promise.race([entered, outcome.then(result => { if (result.failed) throw result.error; throw Error("CPU sink settled before cancellation"); })]);
    assert.equal(done, false); assert.equal(stream.locked, true); assert.equal(unlocked, 0);
    release();
    const result = await outcome;
    assert.equal(result.failed, true); assert.ok(result.error instanceof AggregateError);
    assert.equal(result.error.errors.length, 3);
    for (const error of result.error.errors) assert.strictEqual(error, reason);
    assert.equal(unlocked, 1); assert.equal(stream.locked, false); expectedFailure = true;
  } catch (error) { hasPrimary = true; primary = error; throw error; }
});

for (const reason of [undefined, new Error("synthetic shared reader failure")]) test(`archive reader unlock survives rejected cancellation and preserves ${reason === undefined ? "undefined" : "shared Error"} occurrences`, async t => {
  const stream = new ReadableStream({ pull(controller) { controller.error(reason); } }, { highWaterMark: 0 });
  const reader = stream.getReader(), cancel = reader.cancel.bind(reader), unlock = reader.releaseLock.bind(reader);
  let cancelCalls = 0, unlockCalls = 0;
  t.after(() => { if (stream.locked) unlock(); });
  t.mock.method(reader, "cancel", () => { cancelCalls++; return cancel(); });
  // Real unlock happens first; the injected post-unlock failure shares the
  // original reason to prove that reason equality never deduplicates roots.
  t.mock.method(reader, "releaseLock", () => { unlockCalls++; unlock(); throw reason; });
  await assert.rejects(consumeArchiveReader(reader), error => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors.length, 3);
    for (const failure of error.errors) assert.strictEqual(failure, reason);
    return true;
  });
  assert.equal(cancelCalls, 1); assert.equal(unlockCalls, 1); assert.equal(stream.locked, false);
});

test("privacy-filtered archive is copied before a held injected R2 write", async t => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const roots = []; t.after(async () => { release(); await Promise.all(roots); });
  const selected = { ...selection(), endpoint: { request_format: "cloudflare_ai_gateway.universal" },
    body: [{ provider: "fixture", headers: { authorization: "synthetic-private" }, authorization: "synthetic-private", body: { value: "original" }, unknown: 7 }] };
  let saved;
  const prepared = prepareContentRetention({ CONTENT_ARCHIVE: { async put(_key, body) { await gate; saved = JSON.parse(body); } } }, auth(), selected, "fixture");
  const write = prepared.write(); roots.push(write); void write.catch(() => undefined);
  selected.body[0].body.value = "mutated";
  release(); await write;
  assert.deepEqual(saved.body, [{ provider: "fixture", body: { value: "original" }, unknown: 7 }]);
  assert.equal(Object.isFrozen(selected.body[0].body), false);
});

test("Fusion reserves every subset before placeholders and uses containment after capture", () => {
  const config = normalizeFusionConfig({ enabled: true, adviserModels: ["fixture/a", "fixture/b", "fixture/c", "fixture/d"], aggregatorModel: "fixture/final", maxProposalChars: 20000 });
  const original = { model: "clawrouter/fusion", messages: [{ role: "user", content: "question" }], max_tokens: 12 };
  let shapes = 0;
  const certificate = prepareFusionAccounting(original, config, { provider: "fixture", endpoint: "chat", upstream: "final", renames: [{ from: "max_tokens", to: "max_completion_tokens" }] }, view => { admitAccountingJson(view, "archive"); shapes++; });
  assert.equal(shapes, 16);
  original.messages[0].content = "changed"; config.maxProposalChars = 1;
  const maximum = buildFusionReservationProposals(certificate.config), body = certificate.assemble(maximum);
  assert.equal(body.messages.find(message => message.role === "user").content, "question");
  const routed = { ...body, model: "final", max_completion_tokens: body.max_tokens }; delete routed.max_tokens;
  assert.doesNotThrow(() => certificate.assertRoute(body, routed, "fixture", "chat", "final"));
  assert.throws(() => certificate.assemble([{ model: "fixture/a", content: "x".repeat(20001) }]), /certificate mismatch/);
  const tooLarge = { messages: [{ role: "user", content: "x".repeat(8 * 1024 * 1024 - 100000) }] };
  assert.throws(() => prepareFusionAccounting(tooLarge, certificate.config, certificate.route, () => {}), denied);
});

test("Fusion prospective API tier variants follow renames without changing subscription bodies", async () => {
  const { assertServiceTier } = await import("../service-tiers.ts");
  const config = normalizeFusionConfig({ enabled: true, strategy: "single", aggregatorModel: "openai/gpt-6-astra" });
  for (const tier of [undefined, "auto"]) for (const renameTier of [false, true]) {
    const original = { model: "clawrouter/fusion", messages: [{ role: "user", content: "fixture" }],
      ...(tier === undefined ? {} : { service_tier: tier }) };
    const renames = renameTier ? [{ from: "service_tier", to: "client_tier" }] : [];
    const measured = [], route = { provider: "openai", endpoint: "chat", upstream: "gpt-6-astra", renames };
    const certificate = prepareFusionAccounting(original, config, route, view => measured.push(admitAccountingJson(view, "archive")));
    const raw = { ...original, model: route.upstream };
    if (renameTier && Object.hasOwn(raw, "service_tier")) { raw.client_tier = raw.service_tier; delete raw.service_tier; }
    const apiBody = { ...raw, service_tier: "default" };
    assert.deepEqual(measured, [admitAccountingJson(raw, "archive"), admitAccountingJson(apiBody, "archive")]);
    assert.equal(measured[1].bytes - measured[0].bytes, tier === "auto" && !renameTier ? 3 : 25);
    const selected = body => ({ provider: { id: "openai" }, model: null, endpoint: { request_format: "openai.chat_completions" }, body });
    const api = selected(raw), subscription = selected(raw);
    assertServiceTier(auth(), api, null);
    assertServiceTier(auth(), subscription, { id: "fixture-subscription" });
    assert.deepEqual(api.body, apiBody); assert.strictEqual(subscription.body, raw);
    const assembled = certificate.assemble([]);
    assert.equal(Object.hasOwn(assembled, "service_tier"), tier !== undefined);
    assert.equal(assembled.service_tier, tier); assert.equal(original.service_tier, tier);
  }
});

test("Fusion prepares a mutable admitted MiB dispatch body while its certificate stays immutable", async t => {
  const { usageEnv, proxyKey } = await import("./usage-budget-fixture.mjs");
  const { authenticateProxyKey } = await import("../proxy-auth.ts");
  const { concreteOpenAiSelection, isSelectionFailure } = await import("../proxy-selection.ts");
  const { prepareSelected } = await import("../proxy.ts");
  const env = usageEnv([], { fixedCost: null, retainContent: false });
  env.OPENAI_API_KEY = "synthetic-openai-key";
  const req = new Request("https://router.example/v1/chat/completions", { method: "POST", headers: { authorization: `Bearer ${proxyKey()}` } });
  const identity = await authenticateProxyKey(req.headers, env, [{ id: "openai", tokenRef: "openai" }]);
  assert.ok(!(identity instanceof Response));
  const config = normalizeFusionConfig({ enabled: true, adviserModels: ["openai/gpt-4.1-mini"], aggregatorModel: "openai/gpt-6-astra", maxProposalChars: 256 });
  const original = { model: "clawrouter/fusion", messages: [{ role: "user", content: "x".repeat(1024 * 1024) }], max_tokens: 32 };
  const probe = concreteOpenAiSelection("/v1/chat/completions", { model: config.aggregatorModel, messages: [] }, env);
  assert.equal(isSelectionFailure(probe), false);
  const certificate = prepareFusionAccounting(original, config, { provider: probe.provider.id, endpoint: probe.endpoint.id, upstream: probe.pathParams.model, renames: [] }, () => {});
  let posts = 0;
  t.mock.method(globalThis, "fetch", () => { posts++; throw Error("preparation must not invoke a vendor"); });
  for (const proposals of [buildFusionReservationProposals(certificate.config), [{ model: config.adviserModels[0], content: "fixture answer" }]]) {
    const dispatch = certificate.assemble(proposals);
    const selected = concreteOpenAiSelection("/v1/chat/completions", dispatch, env, undefined, probe.preparation);
    assert.equal(isSelectionFailure(selected), false);
    const prepared = await prepareSelected(req, env, selected, {}, identity, new Set(), false);
    // Own and consume the actual prepared stream before any later assertion.
    const body = typeof prepared.requestBody === "string" ? prepared.requestBody
      : await new Blob((await consumeArchiveReader(prepared.requestBody.getReader())).parts).text();
    assert.ok(prepared.requestBody instanceof ReadableStream, "the existing MiB media serializer was reached");
    const sent = JSON.parse(body), message = sent.messages.find(value => value.role === "user");
    assert.equal(message.content, original.messages[0].content); assert.equal(sent.service_tier, "default");
    assert.notStrictEqual(dispatch.messages, certificate.input.messages);
    assert.equal(Object.isFrozen(dispatch.messages[0]), false);
    assert.equal(certificate.input.messages[0].content, original.messages[0].content);
    assert.equal(Object.isFrozen(certificate.input.messages[0]), true);
  }
  assert.equal(posts, 0); assert.equal(Object.isFrozen(original.messages[0]), false);
});

test("Search seed fits its old sink but prospective growth denies before any owned effect", () => {
  const base = createProxyAccounting({ env: {}, context: {}, auth: auth(), selection: selection(), request: request(), cost }).facts;
  let witnessed = false;
  for (let length = 1; length <= 1024; length++) {
    const facts = { ...base, event: { ...base.event, policy_id: "\0".repeat(length), credential_id: "\0".repeat(length), principal_id: "\0".repeat(length) } };
    try { admitAccountingJson(facts.event, "search"); } catch { break; }
    try { admitAccountingFacts(facts, undefined, true); }
    catch (error) { assert.ok(denied(error)); witnessed = true; break; }
  }
  assert.equal(witnessed, true, "actual 16 KiB sink, not just generic 64 KiB, must be prospective");
});

test("actual Search sink exact bytes and +1 retain its existing smaller profile", () => {
  const value = { data: "\0".repeat(2720), tail: "x".repeat(43) };
  assert.equal(admitAccountingJson(value, "search").bytes, 16384);
  assert.equal(searchJsonBytes(value), 16384);
  assert.throws(() => admitAccountingJson({ ...value, tail: value.tail + "x" }, "search"), denied);
  // Generic accounting permits a larger capsule; this is specifically a sink denial.
  assert.doesNotThrow(() => admitAccountingJson({ ...value, tail: value.tail + "x" }, "archive"));
  assert.throws(() => searchJsonBytes({ ...value, tail: value.tail + "x" }), error => error.code === "minimax_search_unavailable");
});

test("actual Search owner rejects seed-fitting receipt growth before ledger or queue invocation", async t => {
  const search = new MiniMaxSearchOperation(request(), 10000);
  t.after(() => search.finish());
  let effects = 0;
  const env = { BUDGET_LEDGER: { idFromName() { effects++; throw Error("unexpected ledger"); } },
    USAGE_QUEUE: { send() { effects++; throw Error("unexpected queue"); } } };
  const selected = { ...selection(), provider: { id: "minimax" }, capability: "search.web",
    endpoint: { request_format: "minimax.search", response_format: "json" } };
  const base = createProxyAccounting({ env, context: {}, auth: auth(), selection: selected, request: request(), cost, search }).facts;
  let candidate;
  for (let length = 1; length <= 1024; length++) {
    const value = "\0".repeat(length), a = auth(); a.policy.tenantId = value; a.credentialId = value; a.principalId = value;
    const event = { ...base.event, tenant_id: value, credential_id: value, key_id: value, principal_id: value };
    try { searchJsonBytes(event); } catch { break; }
    try { admitAccountingFacts({ ...base, event }, undefined, true); }
    catch (error) { assert.ok(denied(error)); candidate = a; break; }
  }
  assert.ok(candidate, "seed fits the actual sink while permitted growth does not");
  assert.throws(() => createProxyAccounting({ env, context: {}, auth: candidate, selection: selected, request: request(), cost, search }), denied);
  assert.equal(effects, 0);
});

test("retained image pricing excludes the generation graph and copies the selected rates", () => {
  const selected = selection();
  const pricing = { unit: "image_token", effectiveAt: "2026-11-01", source: "https://example.com/prices",
    textInputMicrosPerMillion: 10, imageInputMicrosPerMillion: 20, imageOutputMicrosPerMillion: 30,
    generation: { qualityFactors: { low: 1 }, unused: "synthetic-generation" } };
  selected.model = { id: "fixture/image", upstream: "image", pricing };
  selected.endpoint.request_format = "openai.images_generations";
  const accounting = createProxyAccounting({ env: {}, context: {}, auth: auth(), selection: selected, request: request(), cost });
  assert.equal(Object.hasOwn(accounting.facts.model.pricing, "generation"), false);
  pricing.textInputMicrosPerMillion = 999; pricing.generation.qualityFactors.low = 999;
  assert.equal(accounting.facts.model.pricing.textInputMicrosPerMillion, 10);
  assert.equal(Object.isFrozen(pricing.generation), false);
});

test("valid Realtime input forks are already admitted before funded media and retain their own IDs", async t => {
  const a = auth(); a.policy.budgetMode = "soft";
  const events = [], charges = [], roots = [];
  let hasPrimary = false, primary;
  const track = root => { roots.push(root.then(() => ({ failed: false }), error => ({ failed: true, error }))); return root; };
  t.after(async () => {
    const failed = (await Promise.all(roots)).filter(outcome => outcome.failed).map(outcome => outcome.error);
    if (failed.length) throw new AggregateError(hasPrimary ? [primary, ...failed] : failed, "unit roots");
  });
  const env = { USAGE_QUEUE: { async send(event) { events.push(event); } }, BUDGET_LEDGER: {
    idFromName: name => name, get: () => ({ async fetch(url, init) {
      if (new URL(url).pathname === "/status") return accessBytesResponse('{"spentMicros":0}', "");
      const value = JSON.parse(init.body); charges.push(value);
      return Response.json({ charged: true, chargeId: value.chargeId });
    } }),
  } };
  try {
    const funded = await track(fundRealtimeUnit({ request: request(), env, context: { waitUntil: track }, auth: a,
      selection: { ...selection(), capability: "audio.transcription", endpoint: { request_format: "openai.audio_transcription", response_format: "json" } },
      connection, grantKey: "synthetic-grant", grantLane: "api_key", signal: new AbortController().signal,
      unitId: "input", outputCap: 100, input: true }));
    const child = funded.forkInput();
    assert.throws(() => funded.forkInput(), error => error.code === "realtime_input_ownership");
    a.policyId = "x".repeat(100000); a.policy.requestCostMicros = 999;
    env.USAGE_QUEUE = { async send() { throw Error("borrowed Env reread"); } };
    await track(funded.settle(null, true, false, "parent-item"));
    await track(child.settle(null, true, false, "child-item"));
    assert.equal(events.length, 2); assert.notEqual(events[0].id, events[1].id);
    assert.equal(charges.length, 8); assert.equal(new Set(charges.map(item => item.chargeId)).size, 8);
    assert.ok(events.every(event => event.policy_id === "fixture" && event.actual_cost_micros === 0 && event.cost_basis === "unpriced_usage"));
    assert.deepEqual(events.map(event => event.realtime_usage.item_id), ["parent-item", "child-item"]);
  } catch (error) { hasPrimary = true; primary = error; throw error; }
});

for (const [profile, depth] of [["intent", 8], ["capsule", 8], ["archive", 32]]) test(`${profile} root-depth boundary is reachable`, () => {
  const nest = count => { let value = 0; while (count--) value = [value]; return value; };
  assert.doesNotThrow(() => admitAccountingJson(nest(depth), profile));
  assert.throws(() => admitAccountingJson(nest(depth + 1), profile), denied);
});

test("capsule container and archive combined-occurrence boundaries", () => {
  assert.doesNotThrow(() => admitAccountingJson(Array.from({ length: 127 }, () => ({})), "capsule"));
  assert.throws(() => admitAccountingJson(Array.from({ length: 128 }, () => ({})), "capsule"), denied);
  assert.doesNotThrow(() => admitAccountingJson(Array(32768).fill(0), "archive"));
  assert.throws(() => admitAccountingJson(Array(32769).fill(0), "archive"), denied);
  assert.doesNotThrow(() => admitAccountingJson(Array.from({ length: 16383 }, () => []), "archive"));
  assert.throws(() => admitAccountingJson(Array.from({ length: 16384 }, () => []), "archive"), denied);
});

test("archive exact wire/text cap differs from decoded-string cap", () => {
  const units = 8 * 1024 * 1024;
  const exact = "\0".repeat(13106) + '"'.repeat(4) + "a".repeat(units - 13110);
  assert.deepEqual(admitAccountingJson(exact, "archive"), { bytes: units + 65536, text: units + 65536 });
  assert.throws(() => admitAccountingJson(exact.replace("a", '"'), "archive"), denied);
  assert.doesNotThrow(() => admitAccountingJson("a".repeat(units), "archive"));
  assert.throws(() => admitAccountingJson("a".repeat(units + 1), "archive"), denied);
  // IEEE number serialization is <=24 units. The closed 64-token ceiling and
  // values ceilings dominated by member/entry ceilings are not fake +1 proofs.
  assert.doesNotThrow(() => admitAccountingJson(-Number.MAX_VALUE, "intent"));
});
