import assert from "node:assert/strict";
import test from "node:test";
import { fixture, grantKey } from "./managed-runtime-fixture.mjs";
import { snapshot } from "../providers.ts";
import { sha256Hex } from "../utils.ts";
import { putGrantCredentials, inspectGrantCredentials, revokeGrantCredentials } from "../grant-credentials.ts";
import { overrideHotCacheConfig, HOT_CACHE_DISABLED } from "../hot-cache.ts";

const path = "/v1/native/minimax/anthropic/v1/messages", manifest = "/v1/proxy/minimax/messages";
function authorization(kind = "api_key", region = "global", resource) {
  const issuer = region === "global" ? "https://account.minimax.io" : "https://account.minimaxi.com";
  return { version: "clawrouter.minimax-anthropic.v1", kind, region, issuer, tokenEndpoint: `${issuer}/oauth2/token`,
    resource: resource ?? (region === "global" ? "https://api.minimax.io/anthropic" : "https://api.minimaxi.com/anthropic") };
}
async function setup(t, { kind = "api_key", region = "global", resource, qualify = true, expires = 3600_000, fixed = 700 } = {}) {
  const provider = structuredClone(snapshot.providers.find(row => row.id === "minimax"));
  const endpoint = { ...provider.endpoints[0], id: "messages", method: "POST", path: "/anthropic/v1/messages", path_params: [],
    request_format: "anthropic.messages", response_format: "anthropic.messages", query: {}, modelPassthrough: undefined, streaming: "sse" };
  provider.endpoints = [endpoint]; provider.capabilities = [{ id: "llm.chat", endpoint: "messages", methods: ["POST"] }];
  provider.models = [{ ...provider.models[0], capabilities: ["llm.chat"], pricing: null }];
  const f = await fixture(t, { providerId: "minimax", fixed, configure(target) { Object.assign(target, provider); } });
  f.env.MINIMAX_API_KEY = "synthetic-forbidden-environment-key";
  f.env.CLAWROUTER_ADMIN_TOKEN_SHA256 = await sha256Hex("synthetic-admin");
  const binding = authorization(kind, region, resource);
  f.admin = (body, headers = {}) => f.call("/v1/admin/upstream-grants/policies/fixture/replicate", body,
    { method: "PUT", headers: { authorization: "Bearer synthetic-admin", ...headers } });
  f.put = async body => { const response = await f.admin(body), text = await response.text(); assert.equal(response.status, 200, text); return JSON.parse(text); };
  await f.put({ provider: "minimax", kind, enabled: true, accountId: "synthetic-account", maintenance: { keepWarm: false },
    ...(kind === "api_key" ? { credential: "synthetic-original-key" }
      : { accessToken: "synthetic-original-access", refreshToken: "synthetic-original-refresh", expiresAt: new Date(Date.now() + expires).toISOString() }),
    ...(qualify ? { minimaxAnthropicAuthorization: binding } : {}) });
  f.policy.grantRouting = { eligibleGrants: { minimax: ["replicate"] }, environmentFallback: false };
  f.policy.models = [provider.models[0].id];
  await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
  f.request = (useManifest = false, body = {}, extra = {}) => {
    const payload = { model: useManifest ? provider.models[0].id : provider.models[0].upstream, max_tokens: 16, messages: [{ role: "user", content: "synthetic" }], ...body };
    return f.call(useManifest ? manifest : path, useManifest ? { body: payload } : payload, extra);
  };
  f.upstream = async request => Response.json({ id: "synthetic-message", type: "message", role: "assistant", model: provider.models[0].upstream,
    content: [{ type: "text", text: "synthetic reply" }], stop_reason: "end_turn", usage: { input_tokens: 4, output_tokens: 2 } });
  f.afterDispatchAck = change => {
    const get = f.env.BUDGET_LEDGER.get; let changed = false;
    f.env.BUDGET_LEDGER.get = id => { const stub = get(id); return { async fetch(url, init) {
      const response = await stub.fetch(url, init);
      if (new URL(url).pathname === "/dispatch" && !changed) { changed = true; await change(); }
      return response;
    } }; };
  };
  f.binding = binding; t.after(f.drain); return f;
}
async function denied(f, response) {
  const body = await response.text(); assert.notEqual(response.status, 200, body);
  assert.doesNotMatch(body, /synthetic-(?:original|forbidden|replacement)/);
  await f.drain(); assert.equal(f.sent.length, 0);
  for (const event of await f.events()) assert.equal(event.actual_cost_micros, 0);
}

for (const kind of ["api_key", "oauth"]) for (const region of ["global", "cn"]) for (const useManifest of [false, true])
  test(`MiniMax ${kind} ${region} ${useManifest ? "manifest" : "native"} pins regional owner through actual fetch`, async t => {
    const f = await setup(t, { kind, region });
    const response = await f.request(useManifest); assert.equal(response.status, 200, await response.clone().text()); await response.text(); await f.drain();
    assert.equal(f.sent.length, 1); const sent = f.sent[0];
    assert.equal(sent.url, `${f.binding.resource}/v1/messages`); assert.equal(sent.redirect, "manual");
    assert.equal(sent.headers.get("authorization"), kind === "oauth" ? "Bearer synthetic-original-access" : "Bearer synthetic-original-key");
    assert.equal(sent.headers.get("anthropic-version"), "2023-06-01"); assert.equal(sent.headers.has("x-api-key"), false);
    assert.equal((await sent.json()).model, f.provider.models[0].upstream);
    const events = await f.events(); assert.equal(events.length, 1); assert.equal(events[0].cost_basis, "policy_fixed"); assert.equal(events[0].actual_cost_micros, 700);
  });

test("MiniMax OAuth materialization refreshes inside the fenced owner then uses the new original generation", async t => {
  const f = await setup(t, { kind: "oauth", region: "cn", resource: "https://api.minimax.cn/anthropic", expires: 10_000 });
  const before = await inspectGrantCredentials(f.env, grantKey), reply = f.upstream;
  f.upstream = async request => request.url === f.binding.tokenEndpoint
    ? Response.json({ status: "success", access_token: "synthetic-rotated-access", refresh_token: "synthetic-rotated-refresh", expired_in: 3600 }) : reply(request);
  const response = await f.request(); assert.equal(response.status, 200, await response.clone().text()); await response.text();
  assert.equal(f.sent.length, 2); assert.equal(f.sent[0].url, f.binding.tokenEndpoint);
  assert.equal(f.sent[1].url, `${f.binding.resource}/v1/messages`); assert.equal(f.sent[1].headers.get("authorization"), "Bearer synthetic-rotated-access");
  const after = await inspectGrantCredentials(f.env, grantKey); assert.equal(after.credentialLineage, before.credentialLineage);
  assert.equal(after.credentialGeneration, before.credentialGeneration + 1);
});

test("MiniMax requires privileged explicit preprovisioned intent; metadata and environment never qualify", async t => {
  const f = await setup(t, { qualify: false });
  await denied(f, await f.request());
  for (const field of ["minimaxAnthropicBinding", "minimaxAnthropicIntent"]) {
    const response = await f.admin({ [field]: f.binding }); assert.equal(response.status, 400); await response.text();
  }
  const nonadmin = await f.admin({ minimaxAnthropicAuthorization: f.binding }, { authorization: "Bearer clawrouter-live-fixture-fixture-secret" });
  assert.equal(nonadmin.status, 401); await nonadmin.text();
  await putGrantCredentials(f.env, grantKey, { provider: "minimax", kind: "api_key", credential: "synthetic-original-key", minimaxAnthropicBinding: f.binding });
  await denied(f, await f.request(true));
});

for (const mutation of ["disable", "revoke", "replace", "remove", "region", "policy", "caller", "unavailable", "failed-publication"])
  test("MiniMax final original-owner check denies " + mutation + " after awaited accounting", async t => {
    const f = await setup(t);
    f.afterDispatchAck(async () => {
      if (mutation === "disable") await f.put({ enabled: false });
      else if (mutation === "revoke") await revokeGrantCredentials(f.env, grantKey);
      else if (mutation === "replace") await f.put({ credential: "synthetic-replacement-key", minimaxAnthropicAuthorization: f.binding });
      else if (mutation === "remove") await f.put({ minimaxAnthropicAuthorization: null });
      else if (mutation === "region") await f.put({ minimaxAnthropicAuthorization: authorization("api_key", "cn") });
      else if (mutation === "policy") await f.authority("/policies/put", { policyId: "fixture", policy: { ...f.policy, models: [] } });
      else if (mutation === "caller") await f.authority("/credentials/put", { credentialId: "fixture", credential: { ...f.credential, enabled: false } });
      else if (mutation === "unavailable") f.env.GRANT_CREDENTIALS.get = () => ({ async fetch() { return new Response(null, { status: 503 }); } });
      else {
        const get = f.env.ACCESS_CONTROL.get;
        f.env.ACCESS_CONTROL.get = id => { const stub = get(id); return { fetch(url, init) {
          return new URL(url).pathname === "/grant-pools/publish" && JSON.parse(init.body).status === "paused"
            ? Promise.resolve(new Response(null, { status: 503 })) : stub.fetch(url, init);
        } }; };
        await assert.rejects(() => putGrantCredentials(f.env, grantKey, { enabled: false }, true));
        const record = f.env.GRANT_CREDENTIALS.objects.get(grantKey).values.get("credential");
        assert.equal(record.enabled, false); assert.equal(record.poolSyncPending, true);
      }
    });
    await denied(f, await f.request());
  });

for (const useManifest of [false, true]) test("MiniMax warm cached credentials cannot bypass changed owner " + useManifest, async t => {
  const f = await setup(t); overrideHotCacheConfig({ maxAgeMs: 60_000, freshMs: 60_000 });
  t.after(() => overrideHotCacheConfig(HOT_CACHE_DISABLED));
  const warm = await f.request(useManifest); assert.equal(warm.status, 200, await warm.clone().text()); await warm.text(); await f.drain();
  await f.put({ credential: "synthetic-replacement-key" });
  const deniedResponse = await f.request(useManifest); assert.notEqual(deniedResponse.status, 200); await deniedResponse.text();
  assert.equal(f.sent.length, 1);
});

test("MiniMax hard unknown-dollar denial occurs before owner refresh or inference", async t => {
  const f = await setup(t, { kind: "oauth", expires: 10_000, fixed: null });
  delete f.policy.requestCostMicros; await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
  await denied(f, await f.request());
});

test("MiniMax rejects query and unregistered model authority, and does not replay a paid POST", async t => {
  const f = await setup(t);
  await denied(f, await f.call(path + "?region=cn", { model: f.provider.models[0].upstream, messages: [] }));
  await denied(f, await f.request(false, { model: "foreign-model" }));
  f.upstream = () => new Response(null, { status: 429 });
  const response = await f.request(); assert.notEqual(response.status, 200); await response.text(); assert.equal(f.sent.length, 1);
});
