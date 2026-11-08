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
  const parts = []; let maximumBacking = 0;
  try {
    for (;;) { const next = await reader.read(); if (next.done) break; maximumBacking = Math.max(maximumBacking, next.value.buffer.byteLength); parts.push(next.value); }
  } finally { await reader.cancel(); reader.releaseLock(); }
  assert.equal(await new Blob(parts).text(), expected);
  assert.ok(maximumBacking <= 32768); assert.equal(stream.locked, false); assert.equal(archive.retired, true);
  assert.equal(Object.isFrozen(source), false);
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
