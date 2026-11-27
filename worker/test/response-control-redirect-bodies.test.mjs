import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { continuationAuthority } from "./continuation-authority.mjs";
import { sqlBudgetNamespace } from "./sql-budget-namespace.mjs";
import { attachGrantCredentialNamespace } from "./grant-credential-mock.mjs";
import { putGrantCredentials } from "../grant-credentials.ts";
import { sha256Hex } from "../utils.ts";
const { default: worker } = await import("../index.ts");

// The actual public handler, SQL authority and credential owner run unchanged.
// Only fetch is replaced, to observe cancellation of a body that never ends.
for (const pooled of [false, true]) for (const action of ["retrieve", "cancel"]) {
  test(`public ${pooled ? "grant-owner" : "environment"} ${action} cancels redirect body and leaves accounting untouched`, { timeout: 3000 }, async t => {
    const values = new Map(), pending = [], events = [], requests = [];
    const env = { OPENAI_API_KEY: "fixture-environment", BUDGET_LEDGER: sqlBudgetNamespace(t),
      USAGE_QUEUE: { async send(event) { events.push(event); } }, POLICY_KV: {
        async get(key, type) { if (Array.isArray(key)) return new Map(key.map(name => [name, structuredClone(values.get(name) ?? null)])); const value = values.get(key); return value === undefined ? null : type === "text" ? JSON.stringify(value) : structuredClone(value); },
        async put(key, value) { values.set(key, JSON.parse(value)); },
      } };
    env.ACCESS_CONTROL = continuationAuthority(t, env);
    attachGrantCredentialNamespace(env, { useExistingAuthority: true });
    const authority = async (path, body) => {
      const result = await env.ACCESS_CONTROL.get("policy-bindings").fetch("https://authority" + path, { method: "POST", body: JSON.stringify(body) });
      assert.equal(result.status, 200, await result.clone().text());
    };
    await authority("/policies/initialize-all", [{ policyId: "fixture", policy: { enabled: true, generation: "g1", providers: ["openai"], requestCostMicros: 100, monthlyBudgetMicros: 10000, retainRequestContent: false } }]);
    await authority("/credentials/initialize-all", [{ credentialId: "fixture", credential: { enabled: true, policyId: "fixture", policyGeneration: "g1", secretSha256: await sha256Hex("fixture-key") } }]);
    await authority("/connections/initialize-all", [{ providerId: "openai", enabled: true, monthlyBudgetMicros: 10000 }]);
    if (pooled) await putGrantCredentials(env, "oauth/fixture/openai", { provider: "openai", kind: "api_key", enabled: true, credential: "fixture-grant" });
    const queued = { id: "response-fixture", object: "response", status: "queued", usage: null };
    let redirect = false, cancelled = 0;
    t.mock.method(globalThis, "fetch", async (input, init) => {
      const request = new Request(input, init); requests.push(request);
      if (!redirect) return Response.json(queued);
      return new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode(JSON.stringify({ ...queued, status: "completed", usage: { input_tokens: 999, output_tokens: 999 } }))); },
        cancel() { cancelled++; },
      }), { status: 307, headers: { location: "https://redirect.example/secret-location", "retry-after": "900" } });
    });
    const call = (path, body, method = body === undefined ? "GET" : "POST") => worker.fetch(new Request("https://router.example" + path, {
      method, headers: { authorization: "Bearer clawrouter-live-fixture-fixture-key", "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), env, { waitUntil(promise) { pending.push(promise); } });
    const created = await call("/v1/responses", { model: "openai/gpt-6-astra", input: "fixture", background: true });
    assert.equal(created.status, 200, await created.clone().text()); assert.deepEqual(await created.json(), queued);
    const [scope, id] = created.headers.get("x-clawrouter-background-recovery").split(".");
    const state = env.ACCESS_CONTROL.objects.get("http-continuations:" + scope);
    const job = () => JSON.parse(state.db.prepare("SELECT job_json FROM responses_background WHERE job_id = ?").get(id).job_json);
    const before = job(), bindings = state.db.prepare("SELECT * FROM http_continuations").all();
    const reservations = () => before.legs.map(leg => env.BUDGET_LEDGER.get(leg.intent.objectName).reservations());
    const holds = reservations(); redirect = true;
    const response = await call("/v1/responses/response-fixture" + (action === "cancel" ? "/cancel" : ""), undefined, action === "cancel" ? "POST" : "GET");
    assert.equal(response.status, 502); assert.equal(response.headers.get("location"), null);
    assert.equal(response.headers.get("retry-after"), null);
    assert.deepEqual(await response.json(), { error: { code: "provider_unavailable", message: "upstream request to provider openai failed", type: "server_error", param: null } });
    assert.equal(cancelled, 1); assert.equal(requests.length, 2);
    assert.equal(requests[1].redirect, "manual"); assert.equal(requests[1].body, null);
    assert.equal(requests[1].headers.get("authorization"), "Bearer " + (pooled ? "fixture-grant" : "fixture-environment"));
    assert.deepEqual(job(), before); assert.deepEqual(reservations(), holds); assert.deepEqual(events, []);
    assert.deepEqual(state.db.prepare("SELECT * FROM http_continuations").all(), bindings);
    while (pending.length) await Promise.all(pending.splice(0));
  });
}
