import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
const { default: handler } = await import("../index.ts");
import { materializeGrantCredentials, putGrantCredentials, revokeGrantCredentials } from "../grant-credentials.ts";
import { sha256Hex } from "../utils.ts";
import { attachGrantCredentialNamespace } from "./grant-credential-mock.mjs";
import { continuationAuthority } from "./continuation-authority.mjs";
import { sqlBudgetNamespace } from "./sql-budget-namespace.mjs";

const grantKeys = ["oauth/fixture/account-a", "oauth/fixture/account-b"];
async function fixture(t, pooled = true, { limit = null, fixedCost = 7 } = {}) {
  const pending = [], events = [], values = new Map(), sent = [];
  const policy = { enabled: true, generation: "g1", providers: ["openai"], tenantId: "default", monthlyBudgetMicros: limit, requestCostMicros: fixedCost, retainRequestContent: false, grantRouting: { strategy: "round_robin", stickiness: "none", failover: true } };
  const credential = { enabled: true, secretSha256: await sha256Hex("fixture-secret"), policyId: "fixture" };
  const env = attachGrantCredentialNamespace({
    ACCESS_CONTROL: continuationAuthority(t),
    BUDGET_LEDGER: sqlBudgetNamespace(t),
    POLICY_KV: {
      async get(key) { return Array.isArray(key) ? new Map(key.map(key => [key, structuredClone(values.get(key) ?? null)])) : structuredClone(values.get(key) ?? null); },
      async put(key, value) { values.set(key, JSON.parse(value)); },
    },
    OPENAI_API_KEY: "synthetic-environment-key",
    USAGE_QUEUE: { async send(event) { events.push(event); } },
  }, { useExistingAuthority: true });
  async function authority(path, value) {
    const response = await env.ACCESS_CONTROL.get("policy-bindings").fetch(`https://clawrouter.internal${path}`, { method: "POST", body: JSON.stringify(value) });
    assert.equal(response.status, 200, await response.clone().text());
    return response;
  }
  async function mutateCredential(value) {
    const response = await authority("/credentials/mutate", { scope: "admin", actor: { auth: "admin_token", email: "fixture@example.com", role: "admin" }, ...value });
    assert.equal((await response.json()).outcome, "updated");
  }
  await authority("/policies/put", { policyId: "fixture", policy });
  await mutateCredential({ operation: "create", credentialId: "fixture", credential });
  await authority("/connections/put", { providerId: "openai", enabled: true, monthlyBudgetMicros: limit });
  if (pooled) for (const [index, key] of grantKeys.entries()) {
    await putGrantCredentials(env, key, { provider: "openai", kind: "subscription", enabled: true, accessToken: `synthetic-access-${index}`, refreshToken: `synthetic-refresh-${index}`, accountId: `synthetic-account-${index}`, expiresAt: "2099-01-01T00:00:00.000Z" });
  }
  const f = {
    env, values, sent, events, policy, credential, authority, mutateCredential,
    response: (request, index) => Response.json({ object: "response", id: `resp_${index}`, status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1 } }),
    async request(body = {}, headers = {}, path = "/v1/responses", signal) {
      return handler.fetch(new Request(`https://router.example${path}`, { method: "POST", signal, headers: { authorization: "Bearer clawrouter-live-fixture-fixture-secret", "content-type": "application/json", ...headers }, body: JSON.stringify({ model: "openai/gpt-6-astra", input: "fixture", ...body }) }), env, { waitUntil: promise => pending.push(promise) });
    },
    async consume(response) { const text = await response.text(); await f.drain(); return text; },
    async drain() { while (pending.length) await Promise.all(pending.splice(0)); },
    bindings() { return [...env.ACCESS_CONTROL.objects].filter(([name]) => name.startsWith("http-continuations:")); },
  };
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const request = { url: String(url), body: JSON.parse(init.body), headers: new Headers(init.headers), signal: init.signal };
    sent.push(request); return f.response(request, sent.length);
  });
  return f;
}

test("two-account HTTP requests pin response and turn identities while stateless calls keep rotating", async t => {
  const f = await fixture(t);
  f.response = (_request, index) => Response.json({ object: "response", id: `resp_${index}`, status: "completed" }, { headers: { "x-codex-turn-state": index === 1 ? "turn_original" : `turn_next_${index}` } });
  const first = await f.request();
  assert.equal(first.status, 200); assert.equal(first.headers.get("x-codex-turn-state"), "turn_original");
  await f.consume(first);
  const continued = await f.request({ previous_response_id: "resp_1" }, { "x-codex-turn-state": "turn_original" });
  assert.equal(continued.status, 200); await f.consume(continued);
  assert.equal(f.sent[1].headers.get("chatgpt-account-id"), "synthetic-account-0");
  assert.equal(f.sent[1].body.previous_response_id, "resp_1");
  assert.equal(f.sent[1].headers.get("x-codex-turn-state"), "turn_original");
  const independent = await f.request();
  assert.equal(independent.status, 200); await f.consume(independent);
  assert.equal(f.sent[2].headers.get("chatgpt-account-id"), "synthetic-account-1");
});

test("same-turn HTTP retries never fail over when the pinned upstream returns unavailable", async t => {
  const f = await fixture(t);
  f.response = () => Response.json({ object: "response", id: "resp_initial" }, { headers: { "x-codex-turn-state": "turn_initial" } });
  await f.consume(await f.request());
  f.response = () => Response.json({ error: { code: "busy" } }, { status: 503 });
  for (const body of [{ previous_response_id: "resp_initial" }, {}]) {
    const response = await f.request(body, { "x-codex-turn-state": "turn_initial" });
    assert.equal(response.status, 503); await f.consume(response);
    assert.equal(response.headers.has("x-clawrouter-grant-failover"), false);
  }
  assert.equal(f.sent.length, 3);
  assert.ok(f.sent.every(request => request.headers.get("chatgpt-account-id") === "synthetic-account-0"));
});

test("the successful stateless failover grant owns the response it actually produced", async t => {
  const f = await fixture(t);
  f.response = (_request, index) => index === 1 ? Response.json({ error: "fixture unavailable" }, { status: 429 }) : Response.json({ object: "response", id: `resp_${index}` }, { headers: { "x-codex-turn-state": `turn_${index}` } });
  const first = await f.request();
  assert.equal(first.status, 200); assert.equal(first.headers.get("x-clawrouter-grant-failover"), "1");
  await f.consume(first);
  const next = await f.request({ previous_response_id: "resp_2" }, { "x-codex-turn-state": first.headers.get("x-codex-turn-state") });
  assert.equal(next.status, 200); await f.consume(next);
  assert.equal(f.sent.length, 3);
  assert.deepEqual(f.sent.map(request => request.headers.get("chatgpt-account-id")), ["synthetic-account-0", "synthetic-account-1", "synthetic-account-1"]);
  assert.equal(f.sent[2].headers.get("x-codex-turn-state"), "turn_2");
});

for (const fixedCost of [null, 7]) {
  test(`failed alternate dispatch retains one ${fixedCost === null ? "measured bound" : "fixed tariff"} in both SQL ledgers`, async t => {
    const f = await fixture(t, true, { limit: 1_000_000, fixedCost });
    const cancellation = Promise.withResolvers();
    let canceled = false, response;
    f.response = (_request, index) => {
      if (index === 1) return new Response(new ReadableStream({ cancel() { canceled = true; return cancellation.promise; } }, { highWaterMark: 0 }), { status: 429 });
      assert.equal(canceled, true, "discard the first body before dispatch without waiting for its cleanup");
      throw new Error("fixture connection lost after alternate dispatch");
    };
    try {
      response = await f.request({ max_output_tokens: 32 });
      assert.equal(response.status, 502);
      assert.equal(JSON.parse(await f.consume(response)).error.code, "provider_unavailable");
      assert.equal(f.sent.length, 2);
      assert.deepEqual(f.sent.map(request => request.headers.get("chatgpt-account-id")), ["synthetic-account-0", "synthetic-account-1"]);
      assert.equal(f.events.length, 1);
      const [event] = f.events;
      assert.equal(event.status, "provider_error"); assert.equal(event.status_code, 502);
      assert.ok(event.reserved_cost_micros > 0);
      assert.equal(event.actual_cost_micros, event.reserved_cost_micros);
      assert.equal(event.cost_basis, fixedCost === null ? "manifest_reservation" : "policy_fixed");
      assert.equal(event.total_tokens, null);
      await assertBudgets(f, [event.actual_cost_micros]);
    } finally {
      cancellation.resolve();
      await response?.body?.cancel().catch(() => {});
      await f.drain();
    }
  });
}

test("failed alternate selection preserves the original rejection body and zero charge", async t => {
  for (const scenario of ["unavailable", "selection_error"]) {
    const f = await fixture(t, true, { limit: 1_000_000, fixedCost: null });
    let selections = 0, canceled = false;
    if (scenario === "unavailable") await revokeGrantCredentials(f.env, grantKeys[1]);
    f.env.ACCESS_CONTROL.beforeFetch = (_name, request) => {
      if (new URL(request.url).pathname === "/grant-pools/select" && ++selections === 2 && scenario === "selection_error") throw new Error("fixture selection outage");
    };
    const body = '{"error":{"code":"fixture_rejection"}}';
    f.response = () => new Response(new ReadableStream({
      pull(controller) { controller.enqueue(new TextEncoder().encode(body)); controller.close(); },
      cancel() { canceled = true; },
    }, { highWaterMark: 0 }), { status: 429, headers: { "content-type": "application/json", "retry-after": "17" } });
    const response = await f.request({ max_output_tokens: 32 });
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("retry-after"), "17");
    assert.equal(response.headers.has("x-clawrouter-grant-failover"), false);
    assert.equal(await f.consume(response), body);
    assert.equal(canceled, false); assert.equal(f.sent.length, 1);
    assert.equal(f.events.length, 1); assert.equal(f.events[0].actual_cost_micros, 0);
    await assertBudgets(f, [0]);
  }
});

test("an alternate rejection remains nonbillable after discarding the first response", async t => {
  const f = await fixture(t, true, { limit: 1_000_000, fixedCost: null });
  f.response = (_request, index) => Response.json({ error: `fixture rejection ${index}` }, { status: index === 1 ? 429 : 403 });
  const response = await f.request({ max_output_tokens: 32 });
  assert.equal(response.status, 403);
  assert.equal(JSON.parse(await f.consume(response)).error, "fixture rejection 2");
  assert.equal(f.sent.length, 2); assert.equal(f.events.length, 1);
  assert.equal(f.events[0].actual_cost_micros, 0);
  await assertBudgets(f, [0]);
});

for (const phase of ["selection", "body_cancel"]) {
  test(`caller cancellation during alternate ${phase} never dispatches another attempt`, async t => {
    const f = await fixture(t, true, { limit: 1_000_000, fixedCost: null });
    const caller = new AbortController();
    let selections = 0, canceled = false;
    f.env.ACCESS_CONTROL.beforeFetch = (_name, request) => {
      if (new URL(request.url).pathname === "/grant-pools/select" && ++selections === 2 && phase === "selection") caller.abort();
    };
    f.response = () => new Response(new ReadableStream({ cancel() { canceled = true; if (phase === "body_cancel") caller.abort(); } }, { highWaterMark: 0 }), { status: 429 });
    const response = await f.request({ max_output_tokens: 32 }, {}, "/v1/responses", caller.signal);
    assert.equal(response.status, 502);
    await f.consume(response);
    assert.equal(canceled, true); assert.equal(f.sent.length, 1);
    assert.equal(f.events.length, 1); assert.equal(f.events[0].status, "client_error");
    await assertBudgets(f, [0]);
  });
}

test("the request deadline during alternate selection prevents another dispatch", async t => {
  const f = await fixture(t, true, { limit: 1_000_000, fixedCost: null });
  const { modelRoute } = await import("../providers.ts");
  const timeout = modelRoute("openai/gpt-6-astra").provider.endpoints.find(endpoint => endpoint.id === "responses").timeout_ms;
  const setTimer = globalThis.setTimeout;
  let deadline, selections = 0, canceled = false;
  t.mock.method(globalThis, "setTimeout", (callback, delay, ...args) => {
    if (delay === timeout) deadline = callback;
    return setTimer(callback, delay, ...args);
  });
  f.env.ACCESS_CONTROL.beforeFetch = (_name, request) => {
    if (new URL(request.url).pathname === "/grant-pools/select" && ++selections === 2) {
      assert.equal(typeof deadline, "function"); deadline();
    }
  };
  f.response = () => new Response(new ReadableStream({ cancel() { canceled = true; } }, { highWaterMark: 0 }), { status: 429 });
  const response = await f.request({ max_output_tokens: 32 });
  assert.equal(response.status, 502); await f.consume(response);
  assert.equal(canceled, true); assert.equal(f.sent.length, 1);
  assert.equal(f.events.length, 1); assert.equal(f.events[0].status, "timeout");
  await assertBudgets(f, [0]);
});

async function assertBudgets(f, charges) {
  for (const owner of ["default:fixture", "provider:openai"]) {
    const ledger = f.env.BUDGET_LEDGER.get(owner), rows = ledger.reservations();
    assert.deepEqual(rows.map(row => row.reserved_micros), charges);
    assert.ok(rows.every(row => row.settled === 1 && row.dispatch_started === 1));
    const policyId = owner.replace(":", "/"), month = new Date().toISOString().slice(0, 7);
    const status = await (await ledger.fetch(`https://budget/status?policy_id=${policyId}&window_key=${policyId}/${month}&limit_micros=1000000`)).json();
    assert.equal(status.spentMicros, charges.reduce((sum, cost) => sum + cost, 0));
  }
}

test("owner refresh preserves lineage while explicit primary or refresh replacement requires restart", async t => {
  for (const mutation of ["refresh", "accessToken", "refreshToken", "accountId"]) {
    const f = await fixture(t);
    await f.consume(await f.request());
    const original = f.values.get(grantKeys[0]);
    if (mutation === "refresh") {
      // The provider refresh request is form encoded, so isolate that transport
      // while still exercising the real serialized credential owner.
      t.mock.method(globalThis, "fetch", async (url, init) => {
        if (String(url).includes("/oauth/token")) return Response.json({ access_token: "synthetic-rotated-access", expires_in: 3600 });
        f.sent.push({ url: String(url), body: JSON.parse(init.body), headers: new Headers(init.headers) });
        return Response.json({ object: "response", id: "resp_after_refresh" });
      });
      await materializeGrantCredentials(f.env, grantKeys[0], original, "openai", { tokenUrl: "https://refresh.example/oauth/token", clientId: null, clientIdConfig: null, clientSecretConfig: null, extraParams: {} }, true);
      assert.equal(f.values.get(grantKeys[0]).credentialLineage, original.credentialLineage);
    } else {
      await putGrantCredentials(f.env, grantKeys[0], { ...original, [mutation]: `synthetic-replacement-${mutation}`, credentialLineage: original.credentialLineage }, true);
      assert.notEqual(f.values.get(grantKeys[0]).credentialLineage, original.credentialLineage);
    }
    const response = await f.request({ previous_response_id: "resp_1" });
    assert.equal(response.status, mutation === "refresh" ? 200 : 409, await response.clone().text());
    if (mutation !== "refresh") assert.equal((await response.clone().json()).error.code, "continuation_restart_required");
    await f.consume(response);
    assert.equal(f.sent.length, mutation === "refresh" ? 2 : 1);
  }
});

test("revocation, current eligibility and caller authorization are rechecked without another account", async t => {
  for (const mutation of ["revoke", "eligible", "credential", "policy", "cooldown"]) {
    const f = await fixture(t);
    await f.consume(await f.request());
    if (mutation === "revoke") await revokeGrantCredentials(f.env, grantKeys[0]);
    if (mutation === "eligible") await f.authority("/policies/put", { policyId: "fixture", policy: { ...f.policy, grantRouting: { ...f.policy.grantRouting, eligibleGrants: { openai: ["account-b"] } } } });
    if (mutation === "credential") await f.mutateCredential({ operation: "revoke", credentialId: "fixture" });
    if (mutation === "policy") await f.authority("/policies/put", { policyId: "fixture", policy: { ...f.policy, providers: ["anthropic"] } });
    if (mutation === "cooldown") await f.authority("/grant-pools/feedback", { key: grantKeys[0], state: { status: "limited", observedAt: new Date().toISOString(), source: "provider_response", cooldownUntil: new Date(Date.now() + 60_000).toISOString(), lastSignal: "rate_limited", grantRevision: f.values.get(grantKeys[0]).updatedAt, windows: [] } });
    const response = await f.request({ previous_response_id: "resp_1" });
    assert.equal(response.status, ["credential", "policy"].includes(mutation) ? 403 : 409, await response.clone().text());
    await f.consume(response); assert.equal(f.sent.length, 1);
  }
});

test("unknown state restarts on pooled and environment routes; known environment state keeps its route", async t => {
  const pooled = await fixture(t);
  const denied = await pooled.request({ previous_response_id: "resp_unobserved" });
  assert.equal(denied.status, 409); assert.equal(pooled.sent.length, 0); await pooled.consume(denied);
  const f = await fixture(t, false);
  const legacy = await f.request({ previous_response_id: "resp_legacy" });
  assert.equal(legacy.status, 409); await f.consume(legacy);
  const unknownTurn = await f.request({}, { "x-codex-turn-state": "turn_legacy" });
  assert.equal(unknownTurn.status, 409); await f.consume(unknownTurn);
  assert.equal(f.sent.length, 0);
  await f.consume(await f.request());
  const continued = await f.request({ previous_response_id: "resp_1" });
  assert.equal(continued.status, 200); await f.consume(continued);
  assert.equal(f.sent[1].body.previous_response_id, "resp_1");
  const changedProject = await f.request({ previous_response_id: "resp_1" }, { "openai-project": "new-project" });
  assert.equal(changedProject.status, 409); await f.consume(changedProject);
  f.env.OPENAI_API_KEY = "synthetic-new-environment-key";
  const rotated = await f.request({ previous_response_id: "resp_1" });
  assert.equal(rotated.status, 409); await f.consume(rotated);
  assert.equal(f.sent.length, 2);
});

test("detaching former pooled owners never turns missing or expired state into environment egress", async t => {
  for (const expired of [false, true]) {
    const f = await fixture(t);
    await f.consume(await f.request());
    for (const key of grantKeys) await revokeGrantCredentials(f.env, key);
    if (expired) for (const [, state] of f.bindings()) {
      state.db.prepare("UPDATE http_continuations SET expires_at_ms = 0").run();
      await state.object.alarm();
    }
    for (const previous_response_id of ["resp_1", "resp_unobserved"]) {
      const response = await f.request({ previous_response_id });
      assert.equal(response.status, 409);
      assert.equal((await response.clone().json()).error.code, "continuation_restart_required");
      await f.consume(response);
    }
    assert.equal(f.sent.length, 1);
    const stateless = await f.request();
    assert.equal(stateless.status, 200); await f.consume(stateless);
    assert.equal(f.sent[1].headers.get("authorization"), "Bearer synthetic-environment-key");
  }
});

test("continuations do not take the stateless failover path for eligible retry statuses", async t => {
  for (const status of [401, 403, 429]) {
    const f = await fixture(t);
    await f.consume(await f.request());
    f.response = () => Response.json({ error: "fixture unavailable" }, { status });
    const response = await f.request({ previous_response_id: "resp_1" });
    assert.equal(response.status, status); await f.consume(response);
    assert.equal(f.sent.length, 2);
    assert.equal(f.sent[1].headers.get("chatgpt-account-id"), "synthetic-account-0");
  }
});

test("mixed ownership, missing evidence, expiry and another caller cannot adopt pooled state", async t => {
  for (const mutation of ["conflict", "missing", "expired", "caller"]) {
    const f = await fixture(t);
    f.response = (_request, index) => Response.json({ id: `resp_${index}` }, { headers: { "x-codex-turn-state": `turn_${index}` } });
    await f.consume(await f.request());
    await f.consume(await f.request());
    let headers = { "x-codex-turn-state": mutation === "conflict" ? "turn_2" : mutation === "missing" ? "turn_unknown" : "turn_1" };
    if (mutation === "expired") for (const [, state] of f.bindings()) state.db.prepare("UPDATE http_continuations SET expires_at_ms = 0").run();
    if (mutation === "caller") {
      await f.mutateCredential({ operation: "create", credentialId: "another", credential: f.credential });
      headers.authorization = "Bearer clawrouter-live-another-fixture-secret";
    }
    const response = await f.request({ previous_response_id: "resp_1" }, headers);
    assert.equal(response.status, 409, await response.clone().text());
    await f.consume(response); assert.equal(f.sent.length, 2);
  }
});

function stream(chunks, headers = { "content-type": "text/event-stream" }, close = true) {
  const state = { reads: 0, canceled: false };
  const body = new ReadableStream({
    pull(controller) { state.reads++; if (chunks.length) controller.enqueue(new TextEncoder().encode(chunks.shift())); else if (close) controller.close(); },
    cancel() { state.canceled = true; },
  }, { highWaterMark: 0 });
  return { state, response: new Response(body, { headers }) };
}

test("oversized SSE bytes, late turn metadata and native endpoint continuations retain their owner", async t => {
  const f = await fixture(t);
  const text = `data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_large", output: "x".repeat(2 * 1024 * 1024 + 1) } })}\n\ndata: ${JSON.stringify({ type: "response.metadata", headers: { "X-Codex-Turn-State": [["turn_late"]] } })}\n\n`;
  const chunks = [];
  for (let start = 0; start < text.length; start += 8192) chunks.push(text.slice(start, start + 8192));
  f.response = () => stream([...chunks]).response;
  let writes = 0;
  f.env.ACCESS_CONTROL.beforeFetch = async (name, request) => {
    if (name.startsWith("http-continuations:") && (await request.clone().json()).action === "register") writes++;
  };
  const response = await f.request({ stream: true });
  assert.equal(await f.consume(response), text);
  assert.ok(writes <= 2, "chunks without new identity evidence do not write or extend retention");
  f.response = () => Response.json({ id: "resp_native" });
  const continued = await f.request({ previous_response_id: "resp_large" }, { "x-codex-turn-state": "turn_late" }, "/v1/native/openai/v1/responses");
  assert.equal(continued.status, 200, await continued.clone().text()); await f.consume(continued);
  assert.equal(f.sent[1].headers.get("chatgpt-account-id"), "synthetic-account-0");
});

test("headers and identity-completing JSON bytes wait for durable publication without draining upstream", async t => {
  for (const placement of ["header", "json"]) {
    const f = await fixture(t);
    const gate = Promise.withResolvers(), entered = Promise.withResolvers();
    f.env.ACCESS_CONTROL.beforeFetch = async (name, request) => {
      if (name.startsWith("http-continuations:") && (await request.clone().json()).action === "register") { entered.resolve(); await gate.promise; }
    };
    const upstream = stream(placement === "header" ? ['{"id":"resp_header"}'] : ['{"id":"resp_', 'json","output":[]}', " "], { "content-type": "application/json", ...(placement === "header" ? { "x-codex-turn-state": "turn_header" } : {}) });
    f.response = () => upstream.response;
    let published = false;
    if (placement === "header") {
      const pending = f.request().then(response => { published = true; return response; });
      await entered.promise; assert.equal(published, false); assert.equal(upstream.state.reads, 0);
      gate.resolve(); const response = await pending;
      assert.equal(response.headers.get("x-codex-turn-state"), "turn_header"); await f.consume(response);
    } else {
      const response = await f.request(), reader = response.body.getReader();
      assert.equal(new TextDecoder().decode((await reader.read()).value), '{"id":"resp_');
      const pending = reader.read().then(value => { published = true; return value; });
      await entered.promise; assert.equal(published, false); assert.equal(upstream.state.reads, 2);
      gate.resolve(); assert.equal(new TextDecoder().decode((await pending).value), 'json","output":[]}');
      while (!(await reader.read()).done) {} await f.drain();
    }
    const rows = f.bindings()[0][1].db.prepare("SELECT binding_key, owner_json FROM http_continuations").all();
    assert.equal(rows.length, placement === "header" ? 2 : 1);
    assert.ok(rows.every(row => /^[0-9a-f]{64}$/.test(row.binding_key) && !/turn_header|resp_|synthetic-access/.test(row.owner_json)));
  }
});

test("post-dispatch publication failure cancels upstream and settles conservative or observed usage once", async t => {
  for (const placement of ["header", "sse"]) {
    const f = await fixture(t);
    f.env.ACCESS_CONTROL.beforeFetch = async (name, request) => {
      if (name.startsWith("http-continuations:") && (await request.clone().json()).action === "register") throw new Error("fixture unavailable");
    };
    const upstream = stream(placement === "header" ? ["unused"] : ['data: {"type":"response.completed","response":{"id":"resp_failed","status":"completed","usage":{"input_tokens":13,"output_tokens":5}}}\n\n'], placement === "header" ? { "x-codex-turn-state": "turn_failed" } : { "content-type": "text/event-stream" }, false);
    f.response = () => upstream.response;
    const response = await f.request({ stream: placement === "sse" });
    if (placement === "header") { assert.equal(response.status, 503); await f.consume(response); }
    else { assert.equal(response.status, 200); await assert.rejects(response.text(), /continuation authority/); await f.drain(); }
    assert.equal(upstream.state.canceled, true);
    assert.equal(f.events.length, 1); assert.equal(f.events[0].status, "provider_error");
    assert.equal(f.events[0].actual_cost_micros, 7);
    assert.equal(f.events[0].input_tokens, placement === "sse" ? 13 : null);
    assert.equal(f.events[0].output_tokens, placement === "sse" ? 5 : null);
  }
});

test("caller abort during registration cancels the single owned reader and does not publish queued bytes", async t => {
  const f = await fixture(t), controller = new AbortController();
  const gate = Promise.withResolvers(), entered = Promise.withResolvers();
  f.env.ACCESS_CONTROL.beforeFetch = async (name, request) => {
    if (name.startsWith("http-continuations:") && (await request.clone().json()).action === "register") { entered.resolve(); await gate.promise; }
  };
  const upstream = stream(['{"id":"resp_aborted"}'], { "content-type": "application/json" }, false);
  f.response = () => upstream.response;
  const response = await f.request({}, {}, "/v1/responses", controller.signal);
  const consumed = assert.rejects(response.text(), /fixture caller abort/);
  await entered.promise; controller.abort(new Error("fixture caller abort"));
  await consumed; await f.drain();
  assert.equal(upstream.state.canceled, true); assert.equal(f.events.length, 1);
  assert.equal(f.events[0].actual_cost_micros, 7); assert.equal(f.events[0].status, "client_error");
  gate.resolve(); await setImmediate();
  assert.equal(f.events.length, 1);
});

async function endpointDeadline(t) {
  const { modelRoute } = await import("../providers.ts");
  const timeout = modelRoute("openai/gpt-6-astra").provider.endpoints.find(endpoint => endpoint.id === "responses").timeout_ms;
  const setTimer = globalThis.setTimeout, clearTimer = globalThis.clearTimeout;
  let timer;
  t.mock.method(globalThis, "setTimeout", (callback, delay, ...args) => {
    const handle = setTimer(callback, delay, ...args);
    if (delay === timeout) timer = { handle, callback, active: true };
    return handle;
  });
  t.mock.method(globalThis, "clearTimeout", handle => {
    if (timer?.handle === handle) timer.active = false;
    return clearTimer(handle);
  });
  return () => {
    assert.ok(timer);
    const active = timer.active;
    if (active) timer.callback();
    return active;
  };
}

test("pre-header first cause survives later aborts and late fetch rejection for zero, fixed and measured tariffs", async t => {
  const deadline = await endpointDeadline(t);
  for (const fixedCost of [0, 7, null]) for (const first of ["caller", "deadline", "upstream"]) {
    const f = await fixture(t, false, { limit: 1_000_000, fixedCost }), caller = new AbortController();
    const entered = Promise.withResolvers(), gate = Promise.withResolvers();
    f.response = () => { entered.resolve(); return gate.promise; };
    const pending = f.request({ max_output_tokens: 32 }, {}, "/v1/responses", caller.signal);
    await entered.promise;
    if (first === "caller") { caller.abort(new Error("fixture caller")); deadline(); gate.reject(new Error("late upstream rejection")); }
    else if (first === "deadline") { deadline(); caller.abort(); gate.reject(new Error("late upstream rejection")); }
    else { gate.reject(new DOMException("unrelated upstream abort", "AbortError")); await setImmediate(); caller.abort(); deadline(); }
    const response = await pending;
    assert.equal(response.status, 502); assert.equal(JSON.parse(await f.consume(response)).error.code, "provider_unavailable");
    gate.reject(new Error("late upstream rejection")); await setImmediate();
    assert.equal(f.events.length, 1);
    assert.equal(f.events[0].status, first === "caller" ? "client_error" : first === "deadline" ? "timeout" : "provider_error");
    assert.equal(f.events[0].status_code, 502);
    assert.equal(f.events[0].actual_cost_micros, f.events[0].reserved_cost_micros);
    await assertBudgets(f, [f.events[0].actual_cost_micros]);
  }
});

test("a response arriving after the deadline is retired without publication or a second receipt", async t => {
  const deadline = await endpointDeadline(t), f = await fixture(t, false, { limit: 1_000_000, fixedCost: 7 });
  const entered = Promise.withResolvers(), gate = Promise.withResolvers();
  f.response = () => { entered.resolve(); return gate.promise; };
  const pending = f.request();
  await entered.promise; deadline();
  const response = await pending;
  assert.equal(response.status, 502); await f.consume(response);
  let cancels = 0;
  gate.resolve(new Response(new ReadableStream({ cancel() { cancels++; return Promise.reject(new Error("fixture cleanup")); } }, { highWaterMark: 0 }), { headers: { "x-codex-turn-state": "never_published" } }));
  await setImmediate();
  assert.equal(cancels, 1); assert.equal(f.events.length, 1);
  assert.equal(f.events[0].status, "timeout");
  assert.equal(f.bindings().length, 0);
  await assertBudgets(f, [7]);
});

test("header registration keeps the first cause and never publishes a late ACK or settles twice", async t => {
  const deadline = await endpointDeadline(t);
  for (const first of ["caller", "publication"]) for (const late of ["resolve", "reject"]) {
    const f = await fixture(t, false, { limit: 1_000_000, fixedCost: null }), caller = new AbortController();
    const entered = Promise.withResolvers(), gate = Promise.withResolvers();
    f.env.ACCESS_CONTROL.beforeFetch = async (name, request) => {
      if (name.startsWith("http-continuations:") && (await request.clone().json()).action === "register") { entered.resolve(); await gate.promise; }
    };
    let cancels = 0;
    f.response = () => new Response(new ReadableStream({ cancel() { cancels++; caller.abort(); return new Promise(() => {}); } }, { highWaterMark: 0 }), { headers: { "x-codex-turn-state": "held_turn" } });
    const pending = f.request({ max_output_tokens: 32 }, {}, "/v1/responses", caller.signal);
    await entered.promise;
    assert.equal(deadline(), false, "endpoint timer retires before header registration");
    if (first === "caller") caller.abort(new Error("fixture caller"));
    else gate.reject(new Error("fixture publication failure"));
    const response = await pending;
    assert.equal(response.status, 503); assert.equal(response.headers.has("x-codex-turn-state"), false);
    await f.consume(response);
    if (late === "resolve") gate.resolve(); else gate.reject(new Error("late publication failure"));
    await setImmediate(); await f.drain();
    assert.equal(cancels, 1); assert.equal(f.events.length, 1);
    assert.equal(f.events[0].status, first === "caller" ? "client_error" : "provider_error");
    assert.equal(f.events[0].status_code, 503);
    assert.equal(f.events[0].actual_cost_micros, f.events[0].reserved_cost_micros);
    await assertBudgets(f, [f.events[0].actual_cost_micros]);
  }
});

test("first-event sniffing keeps its deadline while delivered JSON, SSE and body registration keep caller cancellation", async t => {
  const deadline = await endpointDeadline(t);
  for (const phase of ["sniff", "json", "sse", "registration"]) {
    const f = await fixture(t, false, { limit: 1_000_000, fixedCost: null }), caller = new AbortController();
    const entered = Promise.withResolvers(), gate = Promise.withResolvers();
    let pulls = 0, cancels = 0;
    if (phase === "registration") f.env.ACCESS_CONTROL.beforeFetch = async (name, request) => {
      if (name.startsWith("http-continuations:") && (await request.clone().json()).action === "register") { entered.resolve(); await gate.promise; }
    };
    f.response = () => new Response(new ReadableStream({
      pull(controller) {
        if (pulls++ === 0 && phase === "sse") controller.enqueue(new TextEncoder().encode('data: {"type":"response.created"}\n\n'));
        else if (pulls === 1 && phase === "registration") controller.enqueue(new TextEncoder().encode('{"id":"response_held"}'));
        else entered.resolve();
      },
      cancel() { cancels++; return new Promise(() => {}); },
    }, { highWaterMark: 0 }), { headers: { "content-type": phase === "sniff" || phase === "sse" ? "text/event-stream" : "application/json" } });
    const pending = f.request({ stream: true, max_output_tokens: 32 }, {}, "/v1/responses", caller.signal);
    let response, consumed;
    if (phase !== "sniff") {
      response = await pending; assert.equal(response.status, 200);
      consumed = assert.rejects(response.text(), /fixture caller/);
    }
    await entered.promise;
    assert.equal(deadline(), phase === "sniff", "only first-event normalization retains the endpoint timer");
    if (phase !== "sniff") caller.abort(new Error("fixture caller after endpoint deadline retirement"));
    if (phase === "sniff") { response = await pending; assert.equal(response.status, 502); await response.text(); }
    else await consumed;
    await f.drain(); gate.resolve(); await setImmediate();
    assert.equal(cancels, 1); assert.equal(f.events.length, 1);
    assert.equal(f.events[0].status, phase === "sniff" ? "timeout" : "client_error"); assert.equal(f.events[0].status_code, phase === "sniff" ? 502 : 200);
    assert.equal(f.events[0].actual_cost_micros, f.events[0].reserved_cost_micros);
    await assertBudgets(f, [f.events[0].actual_cost_micros]);
  }
});

test("actual Fusion adviser deadlines and oversized consumption stay distinct from the outer caller", async t => {
  const setTimer = globalThis.setTimeout;
  let adviserDeadline;
  t.mock.method(globalThis, "setTimeout", (callback, delay, ...args) => {
    if (delay === 1_000 && !adviserDeadline) adviserDeadline = callback;
    return setTimer(callback, delay, ...args);
  });
  for (const origin of ["deadline", "oversized", "caller"]) {
    adviserDeadline = undefined;
    const f = await fixture(t, false, { limit: 1_000_000, fixedCost: 7 }), caller = new AbortController();
    f.values.set("config/fusion", { enabled: true, adviserModels: ["openai/gpt-4.1-mini"], aggregatorModel: "openai/gpt-4.1-mini", adviserTimeoutMs: 1_000, maxProposalChars: 256 });
    const entered = Promise.withResolvers();
    let cancels = 0;
    f.response = (_request, index) => index > 1 ? Response.json({ choices: [{ message: { content: "fixture complete" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) : new Response(new ReadableStream({
      pull(controller) {
        if (origin === "oversized") { controller.enqueue(new TextEncoder().encode(JSON.stringify({ choices: [{ message: { content: "x".repeat(32_000) } }] }))); controller.close(); }
        entered.resolve();
      },
      cancel() { cancels++; },
    }, { highWaterMark: 0 }), { headers: { "content-type": "application/json" } });
    const pending = f.request({ model: "clawrouter/fusion", messages: [{ role: "user", content: "fixture" }] }, {}, "/v1/chat/completions", caller.signal);
    await entered.promise;
    if (origin === "caller") caller.abort(new Error("fixture caller"));
    else if (origin === "deadline") { assert.equal(typeof adviserDeadline, "function"); adviserDeadline(); }
    const response = await pending;
    assert.equal(response.status, origin === "caller" ? 502 : 200);
    await f.consume(response);
    assert.equal(f.events.length, 2);
    const adviser = f.events.find(event => event.compound_request_stage === "fusion_adviser");
    const synthesizer = f.events.find(event => event.compound_request_stage === "fusion_synthesizer");
    assert.equal(adviser.status, origin === "caller" ? "client_error" : origin === "deadline" ? "timeout" : "provider_error");
    assert.equal(adviser.status_code, 200); assert.equal(adviser.actual_cost_micros, 7);
    assert.equal(synthesizer.status, origin === "caller" ? "client_error" : "success");
    assert.equal(f.sent.length, origin === "caller" ? 1 : 2);
    assert.equal(cancels, origin === "oversized" ? 0 : 1);
    await assertBudgets(f, [origin === "caller" ? 0 : 7, 7]);
  }
});

test("actual Fusion rejection cleanup preserves adviser and synthesizer status with both ledgers at zero", async t => {
  for (const status of [400, 429, 503]) {
    const f = await fixture(t, false, { limit: 1_000_000, fixedCost: 7 });
    f.values.set("config/fusion", { enabled: true, adviserModels: ["openai/gpt-4.1-mini"], aggregatorModel: "openai/gpt-4.1-mini" });
    let cancels = 0;
    f.response = (_request, index) => index === 1
      ? new Response(new ReadableStream({ cancel() { cancels++; } }, { highWaterMark: 0 }), { status })
      : Response.json({ error: "fixture final rejection" }, { status });
    const response = await f.request({ model: "clawrouter/fusion", messages: [{ role: "user", content: "fixture" }] }, {}, "/v1/chat/completions");
    assert.equal(response.status, status);
    assert.equal(JSON.parse(await f.consume(response)).error, "fixture final rejection");
    assert.equal(cancels, 1); assert.equal(f.sent.length, 2); assert.equal(f.events.length, 2);
    for (const event of f.events) {
      assert.equal(event.status, status < 500 ? "client_error" : "provider_error");
      assert.equal(event.status_code, status); assert.equal(event.actual_cost_micros, 0);
    }
    await assertBudgets(f, [0, 0]);
  }
});

for (const format of ["json", "sse"]) for (const origin of ["caller", "deadline"]) test(`${format} known HTTP rejections preserve status through ${origin} while error details are stalled`, async t => {
  const deadline = await endpointDeadline(t);
  for (const status of [400, 429, 503]) for (const cleanup of ["pending", "rejecting"]) {
    const f = await fixture(t, false, { limit: 1_000_000, fixedCost: 7 }), caller = new AbortController();
    const entered = Promise.withResolvers(), disposal = Promise.withResolvers();
    let cancels = 0, upstream;
    f.response = () => upstream = new Response(new ReadableStream({
      pull() { entered.resolve(); },
      cancel() { cancels++; return cleanup === "pending" ? disposal.promise : Promise.reject(new Error("fixture cleanup rejection")); },
    }, { highWaterMark: 0 }), { status, headers: { "content-type": format === "sse" ? "text/event-stream" : "application/json", "retry-after": "17" } });
    try {
      const pending = f.request({ stream: true }, {}, "/v1/responses", caller.signal);
      await entered.promise;
      if (origin === "caller") caller.abort(new Error("fixture caller during error normalization"));
      else assert.equal(deadline(), true, "error normalization still owns the endpoint timer");
      const response = await pending;
      assert.equal(response.status, status, "missing error details must not replace a known rejection with 502");
      assert.equal(response.headers.get("retry-after"), "17");
      await assert.rejects(response.text(), origin === "caller" ? /fixture caller/ : /deadline/);
      await f.drain();
      assert.equal(upstream.body.locked, false); assert.equal(cancels, 1);
      assert.equal(f.sent.length, 1); assert.equal(f.events.length, 1);
      assert.equal(f.events[0].status, status < 500 ? "client_error" : "provider_error");
      assert.equal(f.events[0].status_code, status); assert.equal(f.events[0].actual_cost_micros, 0);
      assert.equal(f.events[0].cost_basis, "none");
      await assertBudgets(f, [0]);
    } finally { disposal.resolve(); }
    await setImmediate();
    assert.equal(f.events.length, 1, "late cleanup does not publish a second receipt");
  }
});

for (const format of ["sse", "json"]) test(`${format} rejections own reciprocal cleanup without replacing their selected status`, async t => {
  const deadline = await endpointDeadline(t);
  for (const status of [400, 429, 503]) for (const cleanup of ["none", "caller", "deadline"]) {
    const f = await fixture(t, false, { limit: 1_000_000, fixedCost: 7 }), caller = new AbortController();
    let cancels = 0;
    const text = format === "sse" ? `data: ${JSON.stringify({ error: { message: "fixture rejection", code: status } })}\n\n` : JSON.stringify({ error: { message: "x".repeat(70_000) } });
    f.response = () => new Response(new ReadableStream({
      pull(controller) { controller.enqueue(new TextEncoder().encode(text)); },
      cancel() { cancels++; if (cleanup === "caller") caller.abort(new Error("fixture reciprocal cancellation")); else if (cleanup === "deadline") deadline(); },
    }, { highWaterMark: 0 }), { status: format === "sse" ? 200 : status, headers: { "content-type": format === "sse" ? "text/event-stream" : "application/json" } });
    const response = await f.request({ stream: true }, {}, "/v1/responses", caller.signal);
    assert.equal(response.status, status, "cleanup must not replace the accepted rejection with a generic502");
    if (cleanup === "none") assert.equal(JSON.parse(await f.consume(response)).error.code, status);
    else { await assert.rejects(response.text(), cleanup === "caller" ? /reciprocal cancellation/ : /deadline/); await f.drain(); }
    assert.equal(cancels, 1); assert.equal(f.events.length, 1);
    assert.equal(f.events[0].status, status < 500 ? "client_error" : "provider_error");
    assert.equal(f.events[0].status_code, status); assert.equal(f.events[0].actual_cost_micros, 0);
    await assertBudgets(f, [0]);
  }
});

test("rejection delivery retires the endpoint deadline while an earlier selection deadline remains first", async t => {
  const deadline = await endpointDeadline(t);
  for (const phase of ["selection", "delivery"]) {
    const f = await fixture(t, phase === "selection", { limit: 1_000_000, fixedCost: 7 }), caller = new AbortController();
    let selects = 0, cancels = 0;
    if (phase === "selection") f.env.ACCESS_CONTROL.beforeFetch = (_name, request) => {
      if (new URL(request.url).pathname === "/grant-pools/select" && ++selects === 2) { deadline(); throw new Error("fixture selection rejected"); }
    };
    f.response = () => new Response(new ReadableStream({ cancel() { cancels++; } }, { highWaterMark: 0 }), { status: 429 });
    const response = await f.request({}, {}, "/v1/responses", caller.signal);
    assert.equal(response.status, 429);
    const consumed = assert.rejects(response.text(), phase === "selection" ? /deadline/ : /fixture caller/);
    if (phase === "delivery") {
      assert.equal(deadline(), false);
      caller.abort(new Error("fixture caller after endpoint deadline retirement"));
    }
    await consumed; await f.drain();
    assert.equal(cancels, 1); assert.equal(f.sent.length, 1); assert.equal(f.events.length, 1);
    assert.equal(f.events[0].status, phase === "selection" ? "timeout" : "client_error");
    assert.equal(f.events[0].status_code, 429); assert.equal(f.events[0].actual_cost_micros, 0);
    await assertBudgets(f, [0]);
  }
});
