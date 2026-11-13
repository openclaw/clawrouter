import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { sqlBudgetNamespace } from "./sql-budget-namespace.mjs";
import { proxyKey, usageEnv } from "./usage-budget-fixture.mjs";

const { default: handler } = await import("../index.ts");

test("Fusion settles the final body estimate while retaining both original reservation receipts", async (t) => {
  const { estimateCost } = await import("../proxy-accounting.ts");
  const { modelRoute } = await import("../providers.ts");
  const { concreteOpenAiSelection } = await import("../proxy-selection.ts");
  const { DEFAULT_FUSION_CONFIG, buildAggregatorBody, buildFusionReservationProposals } = await import("../fusion.ts");
  const config = { ...DEFAULT_FUSION_CONFIG, enabled: true, adviserModels: ["openai/gpt-4.1-mini"], aggregatorModel: "openai/gpt-6-astra", maxProposalChars: 256 };
  const body = { model: "clawrouter/fusion", messages: [{ role: "user", content: "fixture" }], max_tokens: 32 };
  const route = modelRoute(config.aggregatorModel, "llm.chat");
  const prepared = concreteOpenAiSelection("/v1/chat/completions", buildAggregatorBody(body, config, buildFusionReservationProposals(config)), {});
  prepared.body = { ...prepared.body, service_tier: "default" };
  const initial = estimateCost(route.model, prepared.body, null, "llm.chat", prepared.endpoint);
  const env = usageEnv([], { limit: 1_000_000, fixedCost: null, retainContent: false });
  env.OPENAI_API_KEY = "fixture-openai-key";
  env.POLICY_KV.get = async (key) => key === "config/fusion" ? config : Array.isArray(key) ? new Map() : null;
  const ledger = sqlBudgetNamespace(t), calls = [], events = [], pending = [], bodies = [];
  env.BUDGET_LEDGER = { ...ledger, get: (name) => ({ fetch: (url, init) => {
    calls.push({ name, path: new URL(url).pathname, body: JSON.parse(init.body) });
    return ledger.get(name).fetch(url, init);
  } }) };
  env.USAGE_QUEUE = { send: async (event) => events.push(event) };
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return Response.json({ choices: [{ finish_reason: "stop", message: { content: "short fixture answer" } }] });
  });
  const response = await handler.fetch(new Request("https://router.example/v1/chat/completions", {
    method: "POST", headers: { authorization: `Bearer ${proxyKey()}`, "content-type": "application/json" }, body: JSON.stringify(body),
  }), env, { waitUntil: (promise) => pending.push(promise) });
  assert.equal(response.status, 200); await response.text();
  while (pending.length) await Promise.all(pending.splice(0));
  assert.deepEqual(bodies.map(({ model }) => model), ["gpt-4.1-mini", "gpt-6-astra"]);
  const final = estimateCost(route.model, bodies[1], null, "llm.chat", prepared.endpoint);
  assert.ok(final.reserveMicros < initial.reserveMicros);
  const event = events.find(({ compound_request_stage }) => compound_request_stage === "fusion_synthesizer");
  assert.equal(event.reserved_cost_micros, initial.reserveMicros);
  assert.equal(event.actual_cost_micros, final.reserveMicros);
  assert.equal(event.reserved_input_tokens, final.inputTokens);
  assert.equal(event.cost_basis, "manifest_reservation");
  const original = calls.filter(({ path }) => path === "/reserve").slice(0, 2);
  assert.deepEqual(original.map(({ body }) => body.costMicros), [initial.reserveMicros, initial.reserveMicros]);
  for (const { name, body: held } of original) {
    const receipt = calls.filter((call) => call.name === name && call.body.reservationId === held.reservationId);
    assert.deepEqual(receipt.map(({ path }) => path), ["/reserve", "/dispatch", "/settle"]);
    assert.equal(receipt[2].body.actualCostMicros, final.reserveMicros);
  }
});

test("Fusion omitted-tier retained-envelope growth denies before reserve, advisers and R2 (routed Node fixture)", async t => {
  const { authenticateProxyKey } = await import("../proxy-auth.ts");
  const { concreteOpenAiSelection, isSelectionFailure } = await import("../proxy-selection.ts");
  const { DEFAULT_FUSION_CONFIG, prepareFusionAccounting, buildAggregatorBody, buildFusionReservationProposals } = await import("../fusion.ts");
  const { admitAccountingJson, isAccountingAdmissionFailure } = await import("../json-body.ts");
  const { admitProspectiveContentRetention } = await import("../content-retention.ts");
  const config = { ...DEFAULT_FUSION_CONFIG, enabled: true, maxProposalChars: 20000,
    adviserModels: ["openai/gpt-4.1-mini", "openai/gpt-6-astra", "openai/gpt-6.1-sol", "openai/gpt-6.1-terra"], aggregatorModel: "openai/gpt-6-astra" };
  const env = usageEnv([], { limit: 1_000_000, fixedCost: 7, retainContent: true });
  env.OPENAI_API_KEY = "fixture-openai-key";
  env.POLICY_KV.get = async key => key === "config/fusion" ? config : Array.isArray(key) ? new Map() : null;
  const requestId = "fixture-fusion-tier", headers = { authorization: `Bearer ${proxyKey()}`, "content-type": "application/json", "x-request-id": requestId };
  const roots = [], effects = { budget: 0, posts: 0, r2: 0 };
  let hasPrimary = false, primary;
  const track = root => { roots.push(root.then(value => ({ failed: false, value }), error => ({ failed: true, error }))); return root; };
  t.after(async () => {
    const failures = []; let index = 0;
    while (index < roots.length) { const batch = roots.slice(index); index = roots.length; for (const result of await Promise.all(batch)) if (result.failed) failures.push(result.error); }
    if (failures.length) throw new AggregateError(hasPrimary ? [primary, ...failures] : failures, "Fusion tier fixture roots");
  });
  env.BUDGET_LEDGER = { idFromName: name => name, get: () => ({ async fetch() { effects.budget++; throw Error("unexpected budget effect"); } }) };
  env.CONTENT_ARCHIVE = { async put() { effects.r2++; throw Error("unexpected archive effect"); } };
  t.mock.method(globalThis, "fetch", async () => { effects.posts++; throw Error("unexpected provider effect"); });
  try {
    const identity = await track(authenticateProxyKey(new Headers(headers), env, [{ id: "openai", tokenRef: "openai" }])
      .then(async value => { if (value instanceof Response) await value.text(); return value; }));
    assert.ok(!(identity instanceof Response));
    const probe = concreteOpenAiSelection("/v1/chat/completions", { model: config.aggregatorModel, messages: [] }, env);
    if (isSelectionFailure(probe)) await track(probe.response.text());
    assert.equal(isSelectionFailure(probe), false);
    const route = { provider: probe.provider.id, endpoint: probe.endpoint.id, upstream: probe.pathParams.model, renames: [] };
    const original = { model: "clawrouter/fusion", messages: [{ role: "user", content: "" }] };
    // Test oracle: four valid maximum NUL drafts. Production must deny BEFORE
    // constructing its own placeholders or funding any request.
    const proposals = buildFusionReservationProposals(config);
    assert.equal(proposals.length, 4);
    for (const proposal of proposals) { assert.equal(proposal.content.length, 20000); assert.equal(proposal.content.trim(), proposal.content); }
    const envelope = body => ({ version: "clawrouter.retained-request.v1", contentRef: "content_00000000000000000000000000000000",
      requestId, occurredAtMs: Number.MAX_SAFE_INTEGER, expiresAtMs: Number.MAX_SAFE_INTEGER,
      tenantId: identity.policy.tenantId ?? "default", policyId: identity.policyId, credentialId: identity.credentialId,
      principalId: identity.principalId, provider: probe.provider.id, capability: probe.capability, model: probe.model?.id ?? null, body });
    const assembled = () => ({ ...buildAggregatorBody(original, config, proposals), model: route.upstream });
    const cap = 8 * 1024 * 1024 + 65536, gap = cap - admitAccountingJson(envelope(assembled()), "archive").bytes;
    const fill = bytes => { original.messages[0].content = "\0".repeat(Math.floor(bytes / 6)) + "x".repeat(bytes % 6); };
    const admit = () => prepareFusionAccounting(original, config, route, view => admitProspectiveContentRetention(identity, probe, requestId, view));
    fill(gap - 25);
    assert.deepEqual(admitAccountingJson(envelope({ ...assembled(), service_tier: "default" }), "archive"), { bytes: cap, text: cap });
    assert.doesNotThrow(admit, "normalized complete envelope exact boundary");
    fill(gap - 24);
    assert.throws(admit, isAccountingAdmissionFailure, "normalized complete envelope +1");
    fill(gap);
    assert.deepEqual(admitAccountingJson(envelope(assembled()), "archive"), { bytes: cap, text: cap });
    const wire = JSON.stringify(original);
    assert.ok(Buffer.byteLength(wire) < 8 * 1024 * 1024, "ingress remains valid");
    const actual = envelope({ ...assembled(), service_tier: "default" });
    actual.occurredAtMs = Date.now(); actual.expiresAtMs = actual.occurredAtMs + 30 * 86400000;
    assert.ok(Buffer.byteLength(JSON.stringify(actual)) > cap, "timestamp conservatism cannot cover tier growth");
    assert.throws(admit, isAccountingAdmissionFailure);
    const result = await track(handler.fetch(new Request("https://router.example/v1/chat/completions", {
      method: "POST", headers, body: wire,
    }), env, { waitUntil: track }).then(async response => ({ status: response.status, body: await response.json() })));
    assert.equal(result.status, 503); assert.equal(result.body.error.code, "accounting_preflight_unavailable");
    let index = 0; while (index < roots.length) { const batch = roots.slice(index); index = roots.length; await Promise.all(batch); }
    assert.deepEqual(effects, { budget: 0, posts: 0, r2: 0 });
  } catch (error) { hasPrimary = true; primary = error; throw error; }
});

test("Fusion injected post-reserve route containment failure releases the original unclaimed IDs once", async t => {
  const { modelRoute } = await import("../providers.ts");
  const { DEFAULT_FUSION_CONFIG } = await import("../fusion.ts");
  const config = { ...DEFAULT_FUSION_CONFIG, enabled: true, adviserModels: ["openai/gpt-4.1-mini"], aggregatorModel: "openai/gpt-6-astra", maxProposalChars: 256 };
  const env = usageEnv([], { limit: 1_000_000, fixedCost: 7, retainContent: false });
  env.OPENAI_API_KEY = "fixture-openai-key";
  env.POLICY_KV.get = async key => key === "config/fusion" ? config : Array.isArray(key) ? new Map() : null;
  const ledger = sqlBudgetNamespace(t), calls = [], events = [], roots = [];
  let hasPrimary = false, primary, posts = 0;
  const route = modelRoute(config.aggregatorModel, "llm.chat"), transforms = route.provider.adapter.requestTransforms;
  const descriptor = Object.getOwnPropertyDescriptor(transforms, "renameFields");
  const track = root => { roots.push(root.then(value => ({ failed: false, value }), error => ({ failed: true, error }))); return root; };
  t.after(async () => {
    Object.defineProperty(transforms, "renameFields", descriptor);
    const failures = []; let index = 0;
    while (index < roots.length) { const batch = roots.slice(index); index = roots.length; for (const result of await Promise.all(batch)) if (result.failed) failures.push(result.error); }
    if (failures.length) throw new AggregateError(hasPrimary ? [primary, ...failures] : failures, "Fusion fixture roots");
  });
  env.BUDGET_LEDGER = { ...ledger, get: name => ({ fetch(url, init) {
    calls.push({ name, path: new URL(url).pathname, body: JSON.parse(init.body) }); return ledger.get(name).fetch(url, init);
  } }) };
  env.USAGE_QUEUE = { async send(event) { events.push(event); } };
  t.mock.method(globalThis, "fetch", async () => {
    posts++;
    // Labelled containment fault, not a normal post-paid capacity decision.
    Object.defineProperty(transforms, "renameFields", { ...descriptor, value: [...descriptor.value,
      { from: "fixture_field", to: "fixture_changed", paths: [], upstreams: [route.model.upstream] }] });
    return Response.json({ choices: [{ finish_reason: "stop", message: { content: "fixture adviser" } }] });
  });
  try {
    const response = await track(handler.fetch(new Request("https://router.example/v1/chat/completions", {
      method: "POST", headers: { authorization: `Bearer ${proxyKey()}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "clawrouter/fusion", messages: [{ role: "user", content: "fixture" }], fixture_field: "value" }),
    }), env, { waitUntil: track }).then(async response => { await response.text(); return response; }));
    assert.equal(response.status, 500); assert.equal(posts, 1);
    let index = 0; while (index < roots.length) { const batch = roots.slice(index); index = roots.length; await Promise.all(batch); }
    const original = calls.filter(call => call.path === "/reserve").slice(0, 2);
    assert.equal(original.length, 2);
    for (const item of original) {
      const related = calls.filter(call => call.name === item.name && call.body.reservationId === item.body.reservationId);
      assert.deepEqual(related.map(call => call.path), ["/reserve", "/settle"]);
      assert.equal(related[1].body.actualCostMicros, 0);
    }
    assert.equal(events.filter(event => event.compound_request_stage === "fusion_synthesizer").length, 1);
  } catch (error) { hasPrimary = true; primary = error; throw error; }
});

test("reservation reuse reassesses a final pricing gap before admission and unmetered settlement", async (t) => {
  const { reserveBudget, validateBudgetReservation } = await import("../accounting.ts");
  const { createProxyAccounting, estimateCost } = await import("../proxy-accounting.ts");
  const { modelRoute } = await import("../providers.ts");
  const { correlateIngressRequest } = await import("../correlation.ts");
  const route = modelRoute("openai/gpt-6-astra", "llm.chat");
  const endpoint = route.provider.endpoints.find(({ id }) => id === "chat_completions");
  const originalBody = { messages: [{ role: "user", content: "fixture" }], max_tokens: 32 };
  for (const [policyLimit, providerLimit] of [[1_000_000, null], [null, 1_000_000], [null, null]]) {
    const events = [], pending = [], env = { BUDGET_LEDGER: sqlBudgetNamespace(t), USAGE_QUEUE: { send: async (event) => events.push(event) } };
    const auth = { policyId: "fixture", policy: { tenantId: "default", monthlyBudgetMicros: policyLimit }, credentialId: "fixture", authType: "proxy_key" };
    const connection = { providerId: "openai", monthlyBudgetMicros: providerLimit };
    const initial = estimateCost(route.model, originalBody, null, "llm.chat", endpoint);
    const reservation = await reserveBudget(env, auth, "llm.chat", initial, connection);
    const originalReceipt = structuredClone(reservation);
    // Exercise the shared reuse boundary: monetary coverage cannot certify a
    // later request's completeness. Fusion's current builder preserves tools.
    const body = { ...originalBody, web_search_options: {} };
    const final = estimateCost(route.model, body, null, "llm.chat", endpoint);
    assert.equal(final.basis, "unpriced_request");
    assert.equal(final.pricingGap, "hosted_tool_fee");
    assert.ok(final.reserveMicros <= initial.reserveMicros);
    const owner = createProxyAccounting({ env, context: { waitUntil: (promise) => pending.push(promise) }, auth, selection: { ...route, endpoint, body, capability: "llm.chat" }, cost: final, request: correlateIngressRequest(new Request("https://router.example/v1/chat/completions")).request });
    const budgeted = policyLimit != null || providerLimit != null;
    if (budgeted) {
      assert.throws(() => validateBudgetReservation("llm.chat", final, policyLimit, connection), (error) => error.code === "pricing_required");
      owner.fail(400, "client_error", reservation);
    } else {
      assert.equal(validateBudgetReservation("llm.chat", final, policyLimit, connection), false);
      await owner.settle(200, "success", true, { input: 100, output: 10, total: 110, serviceTier: "default" }, reservation, null);
    }
    await Promise.all(pending);
    assert.deepEqual(reservation, originalReceipt);
    assert.equal(events[0].reserved_cost_micros, budgeted ? initial.reserveMicros : 0);
    assert.equal(events[0].actual_cost_micros, 0);
    assert.equal(events[0].cost_basis, budgeted ? "none" : "unpriced_usage");
    for (const { objectName, reservationId } of reservation.reservations) {
      const [row] = env.BUDGET_LEDGER.get(objectName).reservations();
      assert.equal(row.reservation_id, reservationId);
      assert.equal(row.reserved_micros, 0); assert.equal(row.settled, 1);
    }
  }
});
