import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
const { default: handler } = await import("../index.ts");
const { authenticateProxyKey } = await import("../proxy-auth.ts");
const { concreteOpenAiSelection } = await import("../proxy-selection.ts");
import { materializeGrantCredentials, putGrantCredentials, revokeGrantCredentials } from "../grant-credentials.ts";
import { sha256Hex } from "../utils.ts";
import { attachGrantCredentialNamespace } from "./grant-credential-mock.mjs";
import { continuationAuthority } from "./continuation-authority.mjs";
import { HttpContinuation } from "../http-continuation.ts";

const grantKeys = ["oauth/fixture/account-a", "oauth/fixture/account-b"];
async function fixture(t, pooled = true) {
  const pending = [], events = [], values = new Map(), sent = [];
  const policy = { enabled: true, generation: "g1", providers: ["openai"], tenantId: "default", monthlyBudgetMicros: null, requestCostMicros: 7, retainRequestContent: false, grantRouting: { strategy: "round_robin", stickiness: "none", failover: true } };
  const credential = { enabled: true, secretSha256: await sha256Hex("fixture-secret"), policyId: "fixture" };
  const env = attachGrantCredentialNamespace({
    ACCESS_CONTROL: continuationAuthority(t),
    POLICY_KV: {
      async get(key) { return Array.isArray(key) ? new Map(key.map(key => [key, structuredClone(values.get(key) ?? null)])) : structuredClone(values.get(key) ?? null); },
      async put(key, value) { values.set(key, JSON.parse(value)); },
    },
    OPENAI_API_KEY: "synthetic-environment-key",
    USAGE_QUEUE: { async send(event) { events.push(event); } },
  });
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
  await authority("/connections/put", { providerId: "openai", enabled: true, monthlyBudgetMicros: null });
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
    const request = { url: String(url), body: JSON.parse(init.body), headers: new Headers(init.headers) };
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

test("WebSocket metadata-only reconnect resolves its owner and all supplied identities must agree", async t => {
  const f = await fixture(t);
  f.response = (_request, index) => Response.json({ id: `resp_${index}` }, { headers: { "x-codex-turn-state": `turn_${index}` } });
  await f.consume(await f.request()); await f.consume(await f.request());
  const headers = { authorization: "Bearer clawrouter-live-fixture-fixture-secret" };
  async function resolve(body, extraHeaders = {}, transport = "websocket") {
    const request = new Request("https://router.example/v1/responses", { method: "POST", headers: { ...headers, ...extraHeaders } });
    const auth = await authenticateProxyKey(request.headers, f.env);
    const selection = concreteOpenAiSelection("/v1/responses", { model: "openai/gpt-6-astra", input: "full input", ...body }, f.env);
    return HttpContinuation.resolve(request, selection, auth, f.env, transport);
  }
  const metadata = { client_metadata: { "x-codex-turn-state": "turn_1" } };
  assert.equal((await resolve(metadata)).pinned?.key, grantKeys[0]);
  assert.equal((await resolve(metadata, {}, "http")).requested, false, "HTTP client_metadata is not a continuation carrier");
  assert.equal((await resolve({ ...metadata, previous_response_id: "resp_1" }, { "x-codex-turn-state": "turn_1" })).pinned?.key, grantKeys[0]);
  const restart = error => error.status === 409 && error.code === "continuation_restart_required";
  await assert.rejects(resolve({ ...metadata, previous_response_id: "resp_2" }), restart);
  await assert.rejects(resolve({ client_metadata: { "x-codex-turn-state": "unknown" } }), restart);
  let lookups = 0;
  f.env.ACCESS_CONTROL.beforeFetch = async name => { if (name.startsWith("http-continuations:")) lookups++; };
  await assert.rejects(resolve(metadata, { "x-codex-turn-state": "turn_2" }), restart);
  for (const value of [123, [], {}, "x".repeat(8193)]) await assert.rejects(resolve({ client_metadata: { "x-codex-turn-state": value } }), restart);
  assert.equal(lookups, 0, "conflicting or unsupported turn carriers fail before the store lookup");
  for (const value of [null, ""]) assert.equal((await resolve({ client_metadata: { "x-codex-turn-state": value } })).requested, false);
  await f.mutateCredential({ operation: "put", credentialId: "fixture", credential: { ...f.credential, principalId: "other@example.com" } });
  await assert.rejects(resolve(metadata), restart);
  assert.equal(f.sent.length, 2, "resolution never dispatches upstream");
});

test("the successful stateless failover grant owns the response it actually produced", async t => {
  const f = await fixture(t);
  f.response = (_request, index) => index === 1 ? Response.json({ error: "fixture unavailable" }, { status: 429 }) : Response.json({ object: "response", id: `resp_${index}` });
  const first = await f.request();
  assert.equal(first.status, 200); assert.equal(first.headers.get("x-clawrouter-grant-failover"), "1");
  await f.consume(first);
  const next = await f.request({ previous_response_id: "resp_2" });
  assert.equal(next.status, 200); await f.consume(next);
  assert.equal(f.sent.length, 3);
  assert.equal(f.sent[2].headers.get("chatgpt-account-id"), "synthetic-account-1");
});

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
