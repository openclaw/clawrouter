import { perRequestAuthority } from "./typescript-setup.mjs";
perRequestAuthority();
import assert from "node:assert/strict";
import test from "node:test";
import { createGrantAuthority } from "./grant-authority-fixture.mjs";
import { sqlBudgetNamespace } from "./sql-budget-namespace.mjs";
import { accessBytesResponse } from "./access-byte-fixture.mjs";
const { default: worker } = await import("../index.ts");
const { authorityCall } = await import("../authority.ts");
const { sha256Hex } = await import("../utils.ts");
const { snapshot } = await import("../providers.ts");
const { bodyBudgetCharged } = await import("../body-budget.ts");

// Real Worker/SQL boundaries and synthetic upstream wire evidence. Selection is
// format-driven; this does not certify other formats, clients or live tariffs.
const cases = snapshot.providers.flatMap(provider => provider.endpoints
  .filter(endpoint => endpoint.request_format === "openai.chat_completions" && endpoint.response_format === "openai.chat_completions")
  .map(endpoint => ({ provider, endpoint })));
const messages = [
  { role: "assistant", content: null, reasoning_content: "synthetic-reasoning", tool_calls: [{ id: "call_fixture", type: "function", function: { name: "lookup", arguments: "{}" } }] },
  { role: "tool", tool_call_id: "call_fixture", content: "synthetic-tool-result" },
];
const tools = [{ type: "function", function: { name: "lookup", parameters: { type: "object", properties: {} } } }];
const tokens = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 };
const configuredModel = "fixture/served-model";
const configuredDeployment = "deployment";
const delta = { id: "chat_fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "synthetic-output", reasoning_content: "synthetic-reasoning", tool_calls: messages[0].tool_calls }, finish_reason: null }] };
const sse = value => `data: ${JSON.stringify(value)}\n\n`;

async function fixture(t, provider, dispatch = "manifest-session", outcome = "embedded-error") {
  const pending = [], events = [], diagnostics = [], records = new Map();
  const state = { provider: provider.id, dispatch, outcome, phase: "setup", status: null, bodyDone: false, started: 0, settled: 0, failed: 0 };
  let joined = 0, hasPrimary = false, primary;
  const diagnostic = () => { try { console.error("chat-manifest-fixture", JSON.stringify(state)); } catch (error) { diagnostics.push(error); } };
  const track = work => { state.started++; pending.push(work.then(() => { state.settled++; return { failed: false }; }, error => { state.settled++; state.failed++; return { failed: true, error }; })); return work; };
  const drain = async () => {
    if (hasPrimary || state.failed || provider.id === "venice" && outcome === "embedded-error") diagnostic();
    const failures = diagnostics.splice(0);
    while (joined < pending.length) {
      const batch = pending.slice(joined); joined = pending.length;
      for (const result of await Promise.all(batch)) if (result.failed) failures.push(result.error);
    }
    if (failures.length) throw new AggregateError(hasPrimary ? [primary, ...failures] : failures, "independent Chat fixture roots");
  };
  t.after(drain);
  const env = Object.fromEntries(provider.config_keys.map(key => [key,
    /(?:URL|ENDPOINT)$/.test(key) ? "https://fixture-upstream.example"
      : /_MODEL$/.test(key) ? configuredModel
      : /_DEPLOYMENT$/.test(key) ? configuredDeployment : "synthetic-upstream-key"]));
  Object.assign(env, {
    AZURE_OPENAI_API_VERSION: "2024-10-21", AZURE_OPENAI_DEPLOYMENT: configuredDeployment,
    POLICY_KV: {
      async get(key) { return Array.isArray(key) ? new Map(key.map(k => [k, records.get(k) ?? null])) : records.get(key) ?? null; },
      async put(key, value) { records.set(key, JSON.parse(value)); },
      async list() { return { keys: [], list_complete: true }; },
    },
    BUDGET_LEDGER: sqlBudgetNamespace(t),
    USAGE_QUEUE: { async send(event) { events.push(event); } },
  });
  const authority = createGrantAuthority(undefined, env);
  env.ACCESS_CONTROL = { idFromName: name => name, get: () => authority };
  const policy = { enabled: true, generation: "fixture", providers: [provider.id], models: null, tenantId: "fixture", monthlyBudgetMicros: 100, requestCostMicros: 7, budgetMode: "reserve", retainRequestContent: false };
  await authorityCall(env, "/policies/initialize-all", [
    { policyId: "paid", policy },
    { policyId: "unpriced", policy: { ...policy, requestCostMicros: null } },
    { policyId: "foreign", policy: { ...policy, providers: ["fixture-foreign"] } },
  ]);
  await authorityCall(env, "/credentials/initialize-all", await Promise.all(["paid", "unpriced", "foreign"].map(async credentialId => ({ credentialId, credential: { enabled: true, secretSha256: await sha256Hex(`fixture-${credentialId}`), policyId: credentialId, policyGeneration: "fixture" } }))));
  await authorityCall(env, "/connections/initialize-all", [{ providerId: provider.id, enabled: true }]);
  const request = (key, path, body, secret = `fixture-${key}`, headers = {}) => worker.fetch(new Request(`https://router.example${path}`, {
    method: body ? "POST" : "GET",
    headers: { authorization: `Bearer clawrouter-live-${key}-${secret}`, "content-type": "application/json", ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }), env, { waitUntil: track });
  const session = async () => {
    const email = "chat@example.invalid", token = "a".repeat(64);
    env.CLAWROUTER_LOCAL_AUTH = "enabled";
    records.set("local/sessions/" + await sha256Hex(token), { email, role: "user", expiresAtMs: Date.now() + 60_000 });
    await authorityCall(env, "/users/initialize-all", [{ email, record: { enabled: true, role: "user", tenantId: "fixture", groups: [] } }]);
    await authorityCall(env, "/initialize-all", [{ principalType: "user", principalId: email, policyId: "paid", enabled: true, priority: 1 }]);
    // Node's synthetic selected user RPC needs byte fixtures on BOTH boundaries.
    env.ACCESS_CONTROL.get = () => ({ fetch: async (url, init) => {
      if (!new Headers(init?.headers).has("x-clawrouter-user-materialization")) return authority.fetch(url, init);
      const response = await authority.object.fetch(new Request(url, { ...init, body: accessBytesResponse(init.body, "").body, duplex: "half" }));
      return accessBytesResponse(await response.text(), "", { status: response.status, headers: response.headers });
    } });
    return { email, call: (body, headers = {}) => worker.fetch(new Request(`https://router.example/v1/playground/proxy/${provider.id}/chat_completions`, {
      method: "POST", headers: { cookie: "clawrouter_session=" + token, origin: "https://router.example", "content-type": "application/json", "x-request-id": "venice-session-error", ...headers }, body: JSON.stringify({ body }),
    }), env, { waitUntil: track }) };
  };
  return { env, events, request, drain, session, state, fail(error) { hasPrimary = true; primary = error; diagnostic(); } };
}

function fragmented(wire, onCancel, leaveOpen = false) {
  let offset = 0;
  const bytes = new TextEncoder().encode(wire);
  return new Response(new ReadableStream({
    pull(controller) {
      if (offset === bytes.length) { if (!leaveOpen) controller.close(); return; }
      const end = Math.min(offset + 7, bytes.length);
      controller.enqueue(bytes.slice(offset, end)); offset = end;
    },
    cancel: onCancel,
  }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } });
}

for (const { provider, endpoint } of cases) for (const dispatch of ["native", "manifest"]) {
  test(`${provider.id}/${endpoint.id}: catalog-selected ${dispatch} Chat contract`, async t => {
    for (const outcome of ["unary", "stream", "embedded-error", "late-error", "failed-usage", "usage-absent", "cancel"]) await t.test(outcome, async t => {
      const f = await fixture(t, provider, dispatch, outcome);
      try {
      f.state.phase = "catalog";
      const upstream = t.mock.method(globalThis, "fetch", () => { throw new Error("unexpected provider I/O"); });
      const catalogResponse = await f.request("paid", "/v1/catalog");
      assert.equal(catalogResponse.status, 200);
      const catalog = await catalogResponse.json();
      assert.equal(catalog.scope.credentialId, "paid");
      const offered = catalog.providers.find(row => row.id === provider.id);
      assert.ok(offered, "configured provider must be visible to this credential");
      const offer = offered.offers.find(row => row.endpoint === endpoint.id && row.routeKind === "native" && row.modelId && row.eligible);
      assert.ok(offer, "known Chat format must offer a credential-eligible native model");
      const model = offered.models.find(row => row.id === offer.modelId);
      const upstreamModel = model.upstream.replace("${deployment}", configuredDeployment).replace("${model}", configuredModel);
      const selectedModel = dispatch === "manifest" ? model.id : upstreamModel;
      // A dynamic deployment is an operator-supplied native identity, not a
      // certified model behind the catalog's generic deployment placeholder.
      const usageModel = dispatch === "native" && model.upstream.includes("${") ? upstreamModel : model.id;
      const route = offered.routes.find(row => row.endpoint === endpoint.id);
      assert.equal(route.requestFormat, "openai.chat_completions");
      const bind = (path, upstreamModel) => path.replace(/\$\{(?:model|deployment)\}/g, encodeURIComponent(upstreamModel));
      const call = (key, selectedModel, body, secret) => {
        const payload = { model: selectedModel, messages, tools, ...body };
        return f.request(key, dispatch === "manifest" ? `/v1/proxy/${provider.id}/${endpoint.id}` : bind(offer.route, selectedModel), dispatch === "manifest"
          ? { body: payload, pathParams: Object.fromEntries(endpoint.path_params.map(name => [name, selectedModel])) }
          : payload, secret);
      };
      const foreignCatalog = await (await f.request("foreign", "/v1/catalog")).json();
      assert.ok(!foreignCatalog.providers.some(row => row.id === provider.id));
      assert.equal((await call("paid", selectedModel, {}, "fixture-foreign")).status, 401);
      const denied = await call("foreign", selectedModel, {});
      assert.equal(denied.status, 403);
      assert.equal((await denied.json()).error.code, "provider_not_allowed");
      // Use an eligible unpriced card when opaque IDs are forbidden. A closed,
      // fully priced catalog cannot supply an unknown-price request.
      const unpricedOffer = offered.offers.find(row => row.endpoint === endpoint.id && row.routeKind === "native" && row.eligible
        && provider.models.some(card => card.id === row.modelId && card.pricing === null));
      if (!endpoint.modelPassthrough?.pricing && (endpoint.modelPassthrough || unpricedOffer)) {
        const unknownModel = endpoint.modelPassthrough
          ? (dispatch === "manifest" ? `${provider.routing.modelPrefixes[0]}fixture-unpriced` : "fixture-unpriced")
          : (dispatch === "manifest" ? unpricedOffer.modelId : offered.models.find(row => row.id === unpricedOffer.modelId).upstream);
        const unpriced = await call("unpriced", unknownModel, {});
        assert.equal(unpriced.status, 400);
        assert.equal((await unpriced.json()).error.code, "pricing_required");
      }
      assert.equal(upstream.mock.callCount(), 0, "catalog and denied requests make zero upstream calls");
      // Venice confirms the selected identity before releasing JSON or each
      // SSE frame. The generic fixture must supply its actual native model.
      const modelBinding = provider.id === "venice" ? { model: upstreamModel } : {};
      const terminal = { id: "chat_fixture", object: "chat.completion.chunk", choices: [], usage: tokens, ...modelBinding };
      const unary = { id: "chat_fixture", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "synthetic-output", tool_calls: messages[0].tool_calls, reasoning_content: "synthetic-reasoning" }, finish_reason: "stop" }], usage: tokens, ...modelBinding };
      const errorWire = sse({ ...modelBinding, error: { message: "synthetic-rejection", code: "server_error" }, ...(outcome === "failed-usage" ? { usage: tokens } : {}) });
      const contentWire = sse({ ...delta, ...modelBinding });
      const wire = outcome === "embedded-error" ? errorWire
        : contentWire + (outcome === "cancel" ? "" : (outcome === "usage-absent" ? "" : sse(terminal)) + (["late-error", "failed-usage"].includes(outcome) ? errorWire : "data: [DONE]\n\n"));
      let canceled = false, hasUpstreamError = false, upstreamError, originalReservationId;
      upstream.mock.mockImplementation(async (target, init) => {
        try {
          const url = new URL(target), headers = new Headers(init.headers), body = JSON.parse(init.body);
          const base = provider.base_urls.default.startsWith("https:") ? provider.base_urls.default : "https://fixture-upstream.example";
          const expected = new URL(base.replace(/\/$/, "") + bind(endpoint.upstreamPath ?? endpoint.path, upstreamModel));
          assert.equal(url.origin, expected.origin);
          assert.equal(url.pathname, expected.pathname);
          assert.ok(!headers.get("authorization")?.includes("clawrouter-live-"));
          for (const auth of provider.auth.schemes) {
            if (auth.type === "bearer") assert.equal(headers.get(auth.header), "Bearer synthetic-upstream-key");
            else if (auth.type === "api_key") assert.equal(headers.get(auth.header), "synthetic-upstream-key");
            else assert.fail(`Chat fixture needs explicit ${auth.type} authentication coverage`);
          }
          assert.deepEqual(body.messages, messages);
          assert.deepEqual(body.tools, tools);
          assert.equal(body.stream, outcome !== "unary");
          if (!endpoint.path_params.some(name => ["model", "deployment"].includes(name))) assert.equal(body.model, upstreamModel);
          else assert.ok(url.pathname.includes(encodeURIComponent(upstreamModel)));
          const original = f.env.BUDGET_LEDGER.get("fixture:paid").reservations()[0];
          assert.equal(original.reserved_micros, 7, "reserve the fixed tariff before upstream egress");
          originalReservationId = original.reservation_id;
          return outcome === "unary" ? Response.json(unary) : fragmented(wire, () => { canceled = true; }, outcome === "cancel");
        } catch (error) { hasUpstreamError = true; upstreamError = error; throw error; }
      });
      f.state.phase = "dispatch";
      const response = await call("paid", selectedModel, { stream: outcome !== "unary", ...(outcome === "unary" ? {} : { stream_options: { include_usage: true } }) });
      f.state.status = response.status; f.state.phase = "body";
      if (hasUpstreamError) throw upstreamError;
      const gatedFailure = provider.id === "venice" && ["embedded-error", "late-error", "failed-usage"].includes(outcome);
      if (gatedFailure && outcome === "embedded-error") {
        assert.equal(response.status, 502);
        const rejected = await response.text(); assert.doesNotMatch(rejected, /synthetic-rejection|synthetic-output/);
      } else if (gatedFailure) {
        assert.equal(response.status, 200);
        const reader = response.body.getReader(); let delivered = "", failed = false;
        try { for (;;) { const next = await reader.read(); if (next.done) break; delivered += new TextDecoder().decode(next.value); } }
        catch { failed = true; } finally { reader.releaseLock(); }
        assert.equal(failed, true); assert.equal(delivered, contentWire + sse(terminal));
        assert.doesNotMatch(delivered, /synthetic-rejection/);
      } else if (outcome === "cancel") {
        assert.equal(response.status, 200);
        const reader = response.body.getReader();
        assert.equal((await reader.read()).done, false);
        await reader.cancel("synthetic caller disconnect");
        assert.equal(canceled, true);
      } else if (outcome === "unary") {
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), unary);
      } else {
        assert.equal(response.status, 200);
        assert.equal(await response.text(), wire, "native wire content must survive fragmented delivery");
      }
      f.state.bodyDone = true; f.state.phase = "background-join";
      await f.drain();
      f.state.phase = "accounting-assertions";
      assert.equal(upstream.mock.callCount(), 1);
      const usage = f.events.filter(event => event.type === "clawrouter.usage.v1" && event.credential_id === "paid");
      assert.equal(usage.length, 1, "one dispatch settles and reports exactly once");
      const [event] = usage;
      assert.equal(event.policy_id, "paid");
      assert.equal(event.provider, provider.id);
      assert.equal(event.model, usageModel);
      assert.equal(event.request_id, response.headers.get("x-clawrouter-request-id"));
      assert.equal(event.status, ["embedded-error", "late-error", "failed-usage"].includes(outcome) ? "provider_error" : outcome === "cancel" ? "client_error" : "success");
      // Only complete terminal evidence certifies token usage. Missing final
      // counters retain the fixed reservation and must not fabricate zero usage.
      assert.deepEqual([event.input_tokens, event.output_tokens, event.total_tokens], !gatedFailure && ["unary", "stream", "failed-usage"].includes(outcome) ? [100, 20, 120] : [null, null, null]);
      // Withheld Venice error frames cannot certify free dispatched work.
      const freeRejection = outcome === "embedded-error" && !gatedFailure;
      assert.equal(event.cost_basis, freeRejection ? "none" : "policy_fixed");
      assert.equal(event.actual_cost_micros, freeRejection ? 0 : 7);
      const reservations = f.env.BUDGET_LEDGER.get("fixture:paid").reservations();
      assert.equal(reservations.length, 1);
      assert.equal(reservations[0].reservation_id, originalReservationId);
      assert.equal(reservations[0].settled, 1);
      assert.equal(reservations[0].reserved_micros, freeRejection ? 0 : 7);
      assert.doesNotMatch(JSON.stringify(event), /synthetic-reasoning|synthetic-tool-result|synthetic-output|synthetic-upstream-key/);
      } catch (error) { f.fail(error); throw error; }
    });
  });
}

// A real verified local session selects the Access-mode manifest branch, which
// does not call proxy-key preauthenticate. Native validation must still precede
// ordinary-completion classification. This is synthetic upstream/real SQL proof.
test("Venice Access-session manifest embedded error retains native ownership and original accounting", async t => {
  const provider = snapshot.providers.find(row => row.id === "venice"), f = await fixture(t, provider);
  try {
    const session = await f.session();
    const model = provider.models.find(row => row.capabilities.includes("llm.chat") && row.requestParameters?.chat_completions?.toolCalling === "supported");
    assert.ok(model);
    let originalId;
    const upstream = t.mock.method(globalThis, "fetch", async (_url, init) => {
      const body = JSON.parse(init.body);
      assert.equal(body.model, model.upstream); assert.equal(body.stream, true);
      assert.deepEqual(body.messages, messages);
      const rows = f.env.BUDGET_LEDGER.get("fixture:paid").reservations();
      assert.equal(rows.length, 1); assert.equal(rows[0].reserved_micros, 7);
      originalId = rows[0].reservation_id;
      return fragmented(sse({ model: model.upstream, error: { message: "synthetic-rejection", code: "server_error" } }));
    });
    f.state.phase = "auth-precedence";
    const denied = await session.call({ model: model.id, messages: "invalid selected input" }, { cookie: "" });
    const denial = await denied.json();
    assert.equal(denied.status, 401); assert.equal(denial.error.code, "access_session_required");
    assert.equal(upstream.mock.callCount(), 0); assert.equal(f.events.length, 0);
    f.state.phase = "dispatch";
    const response = await session.call({ model: model.id, messages, stream: true });
    f.state.status = response.status; f.state.phase = "body";
    const text = await response.text(); f.state.bodyDone = true;
    assert.equal(response.status, 502); assert.doesNotMatch(text, /synthetic-rejection|synthetic-output/);
    f.state.phase = "background-join"; await f.drain(); f.state.phase = "accounting-assertions";
    assert.equal(upstream.mock.callCount(), 1);
    assert.equal(f.events.length, 1);
    const [event] = f.events;
    assert.equal(event.type, "clawrouter.usage.v1"); assert.equal(event.auth_type, "access");
    assert.equal(event.principal_id, session.email); assert.equal(event.credential_id, null); assert.equal(event.policy_id, "paid");
    assert.equal(event.request_id, "venice-session-error"); assert.equal(event.request_id, response.headers.get("x-clawrouter-request-id"));
    assert.equal(event.status, "provider_error"); assert.equal(event.status_code, 502);
    assert.equal(event.cost_basis, "policy_fixed"); assert.equal(event.actual_cost_micros, 7);
    assert.deepEqual([event.input_tokens, event.output_tokens, event.total_tokens], [null, null, null]);
    const rows = f.env.BUDGET_LEDGER.get("fixture:paid").reservations();
    assert.equal(rows.length, 1); assert.equal(rows[0].reservation_id, originalId); assert.equal(rows[0].settled, 1); assert.equal(rows[0].reserved_micros, 7);
    assert.doesNotMatch(JSON.stringify(event), /synthetic-rejection|synthetic-output|synthetic-upstream-key/);
  } catch (error) { f.fail(error); throw error; }
});

test("ordinary identity denial keeps auth precedence and held zero-cost accounting before input validation", async t => {
  let release; const held = new Promise(resolve => { release = resolve; });
  t.after(() => release()); // Registered before any fixture drain can wait on this sink.
  const provider = snapshot.providers.find(row => row.id === "anthropic"), f = await fixture(t, provider, "manifest", "identity-denial");
  const send = f.env.USAGE_QUEUE.send; let entered = false;
  f.env.USAGE_QUEUE.send = async event => { await send(event); entered = true; await held; };
  try {
    const model = provider.models.find(row => row.capabilities.includes("llm.chat"));
    const endpoint = provider.endpoints.find(row => row.request_format === "anthropic.messages");
    const path = `/v1/proxy/${provider.id}/${endpoint.id}`;
    const headers = { "anthropic-workspace-id": "synthetic-workspace", "x-request-id": "identity-denial-before-validation" };
    const payload = { body: { model: model.id, max_tokens: "invalid", messages: [{ role: "user", content: "x".repeat(1024 * 1024 + 16) }] } };
    const upstream = t.mock.method(globalThis, "fetch", () => { throw Error("unexpected denied provider I/O"); });
    f.state.phase = "auth-precedence";
    const unauthorized = await f.request("paid", path, payload, "invalid", headers);
    await unauthorized.text(); assert.equal(unauthorized.status, 401); assert.equal(f.events.length, 0);
    f.state.phase = "identity-denial";
    const response = await f.request("paid", path, payload, undefined, headers);
    f.state.status = response.status; f.state.phase = "body";
    const denial = await response.json(); f.state.bodyDone = true;
    assert.equal(response.status, 403); assert.equal(denial.error.type, "permission_error");
    assert.equal(entered, true); assert.equal(f.events.length, 1); assert.equal(upstream.mock.callCount(), 0);
    assert.deepEqual(f.env.BUDGET_LEDGER.get("fixture:paid").reservations(), []);
    const [event] = f.events;
    assert.equal(event.request_id, headers["x-request-id"]); assert.equal(denial.request_id, event.request_id);
    assert.equal(event.status, "denied"); assert.equal(event.status_code, 403);
    assert.equal(event.actual_cost_micros, 0); assert.equal(event.reserved_cost_micros, 0);
    assert.ok(bodyBudgetCharged() > 0, "early denial still owns the caller until actual accounting settles");
    release(); f.state.phase = "background-join"; await f.drain();
    assert.equal(bodyBudgetCharged(), 0);
  } catch (error) { f.fail(error); throw error; }
  finally { release(); }
});
