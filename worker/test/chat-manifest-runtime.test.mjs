import { perRequestAuthority } from "./typescript-setup.mjs";
perRequestAuthority();
import assert from "node:assert/strict";
import test from "node:test";
import { createGrantAuthority } from "./grant-authority-fixture.mjs";
import { sqlBudgetNamespace } from "./sql-budget-namespace.mjs";
const { default: worker } = await import("../index.ts");
const { authorityCall } = await import("../authority.ts");
const { sha256Hex } = await import("../utils.ts");
const { snapshot } = await import("../providers.ts");

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

async function fixture(t, provider) {
  const pending = [], events = [], records = new Map();
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
  const request = (key, path, body, secret = `fixture-${key}`) => worker.fetch(new Request(`https://router.example${path}`, {
    method: body ? "POST" : "GET",
    headers: { authorization: `Bearer clawrouter-live-${key}-${secret}`, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }), env, { waitUntil: promise => pending.push(promise) });
  const drain = async () => { while (pending.length) await Promise.all(pending.splice(0)); };
  t.after(drain);
  return { env, events, request, drain };
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
      const f = await fixture(t, provider);
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
      // Exercise unknown tariffs without erasing real snapshot pricing. Some
      // endpoints explicitly price all opaque models (for example local compute).
      if (!endpoint.modelPassthrough?.pricing) {
        const opaque = dispatch === "manifest" ? `${provider.routing.modelPrefixes[0]}fixture-unpriced` : "fixture-unpriced";
        const unpriced = await call("unpriced", opaque, {});
        assert.equal(unpriced.status, 400);
        assert.equal((await unpriced.json()).error.code, "pricing_required");
      }
      assert.equal(upstream.mock.callCount(), 0, "catalog and denied requests make zero upstream calls");
      const terminal = { id: "chat_fixture", object: "chat.completion.chunk", choices: [], usage: tokens };
      const unary = { id: "chat_fixture", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "synthetic-output", tool_calls: messages[0].tool_calls, reasoning_content: "synthetic-reasoning" }, finish_reason: "stop" }], usage: tokens };
      const errorWire = sse({ error: { message: "synthetic-rejection", code: "server_error" }, ...(outcome === "failed-usage" ? { usage: tokens } : {}) });
      const wire = outcome === "embedded-error" ? errorWire
        : sse(delta) + (outcome === "cancel" ? "" : (outcome === "usage-absent" ? "" : sse(terminal)) + (["late-error", "failed-usage"].includes(outcome) ? errorWire : "data: [DONE]\n\n"));
      let canceled = false, upstreamError;
      upstream.mock.mockImplementation(async (target, init) => {
        try {
          const url = new URL(target), headers = new Headers(init.headers), body = JSON.parse(init.body);
          const base = provider.base_urls.default.startsWith("https:") ? provider.base_urls.default : "https://fixture-upstream.example";
          const expected = new URL(base.replace(/\/$/, "") + bind(endpoint.path, upstreamModel));
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
          assert.equal(f.env.BUDGET_LEDGER.get("fixture:paid").reservations()[0].reserved_micros, 7, "reserve the fixed tariff before upstream egress");
          return outcome === "unary" ? Response.json(unary) : fragmented(wire, () => { canceled = true; }, outcome === "cancel");
        } catch (error) { upstreamError = error; throw error; }
      });
      const response = await call("paid", selectedModel, { stream: outcome !== "unary", ...(outcome === "unary" ? {} : { stream_options: { include_usage: true } }) });
      assert.ifError(upstreamError);
      if (outcome === "cancel") {
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
      await f.drain();
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
      assert.deepEqual([event.input_tokens, event.output_tokens, event.total_tokens], ["unary", "stream", "failed-usage"].includes(outcome) ? [100, 20, 120] : [null, null, null]);
      assert.equal(event.cost_basis, outcome === "embedded-error" ? "none" : "policy_fixed");
      assert.equal(event.actual_cost_micros, outcome === "embedded-error" ? 0 : 7);
      const reservations = f.env.BUDGET_LEDGER.get("fixture:paid").reservations();
      assert.equal(reservations.length, 1);
      assert.equal(reservations[0].settled, 1);
      assert.equal(reservations[0].reserved_micros, outcome === "embedded-error" ? 0 : 7);
      assert.doesNotMatch(JSON.stringify(event), /synthetic-reasoning|synthetic-tool-result|synthetic-output|synthetic-upstream-key/);
    });
  });
}
