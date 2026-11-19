import assert from "node:assert/strict";
import test from "node:test";
import { attachGrantCredentialNamespace } from "./grant-credential-mock.mjs";
import { materializeGrantCredentials, putGrantCredentials, inspectGrantCredentials, revokeGrantCredentials, secretlessGrant } from "../grant-credentials.ts";
import { readMiniMaxAnthropicBinding } from "../minimax-anthropic-binding.ts";
import { routingProjection } from "../grant-projection.ts";
import { readMiniMaxTokenBody } from "../minimax-token-body.ts";

const key = "oauth/fixture/minimax";
const binding = (kind = "oauth", region = "global", resource) => ({ version: "clawrouter.minimax-anthropic.v1", kind, region,
  issuer: region === "global" ? "https://account.minimax.io" : "https://account.minimaxi.com",
  tokenEndpoint: region === "global" ? "https://account.minimax.io/oauth2/token" : "https://account.minimaxi.com/oauth2/token",
  resource: resource ?? (region === "global" ? "https://api.minimax.io/anthropic" : "https://api.minimaxi.com/anthropic") });
const grant = extra => ({ provider: "minimax", kind: "oauth", enabled: true, accessToken: "synthetic-access-old", refreshToken: "synthetic-refresh-old",
  expiresAt: new Date(Date.now() + 3600_000).toISOString(), ...extra });
function setup() {
  const values = new Map();
  const env = attachGrantCredentialNamespace({ POLICY_KV: {
    async get(k, type) { const value = values.get(k) ?? null; return value === null ? null : type === "text" ? JSON.stringify(value) : structuredClone(value); },
    async put(k, value) { values.set(k, JSON.parse(value)); },
  } }, { kvValues: values });
  return { env, values, put: (g = grant(), b = binding(), preserve = false) => putGrantCredentials(env, key, g, preserve, undefined, undefined, undefined, b),
    materialize: projection => materializeGrantCredentials(env, key, projection, "minimax", null, false) };
}

test("MiniMax owner binding is closed, canonical, explicitly regional and secret-free", () => {
  assert.deepEqual(readMiniMaxAnthropicBinding(binding()), binding());
  assert.equal(readMiniMaxAnthropicBinding({ ...binding(), resource: "https://api.minimax.io/" }).resource, binding().resource);
  for (const change of [{ version: "future" }, { region: "other" }, { kind: "subscription" }, { issuer: undefined },
    { issuer: "https://account.minimaxi.com" }, { tokenEndpoint: "https://account.minimax.io/other" },
    { resource: "https://api.minimaxi.com/anthropic" }, { resource: "https://api.minimax.io/anthropic?key=synthetic" },
    { resource: "https://synthetic@api.minimax.io/anthropic" }, { resource: "https://api.minimax.io/anthropic/v1/messages" }, { authority: true }])
    assert.equal(readMiniMaxAnthropicBinding({ ...binding(), ...change }), null);
  assert.equal(readMiniMaxAnthropicBinding(binding("api_key", "cn", "https://api.minimax.cn/anthropic")), null);
  assert.equal(readMiniMaxAnthropicBinding(binding("oauth", "cn", "https://api.minimax.cn/anthropic")).resource, "https://api.minimax.cn/anthropic");
});

test("MiniMax legacy and forged grant metadata cannot attest regional credentials", async () => {
  const f = setup(), forged = { ...grant(), minimaxAnthropicBinding: binding() };
  const projection = await putGrantCredentials(f.env, key, forged);
  assert.equal(projection.minimaxAnthropicBinding, null);
  assert.equal((await f.materialize(projection)).minimaxAnthropicBinding, null);
  assert.equal(secretlessGrant(forged).minimaxAnthropicBinding, null);
  assert.equal(routingProjection(forged).minimaxAnthropicBinding, null);
});

test("MiniMax omission preserves only the same owner; removal and replacement invalidate lineage", async () => {
  const f = setup(), original = await f.put();
  const same = await putGrantCredentials(f.env, key, { ...original, label: "renamed" }, true);
  assert.deepEqual(same.minimaxAnthropicBinding, binding()); assert.equal(same.credentialLineage, original.credentialLineage);
  const removed = await putGrantCredentials(f.env, key, same, true, undefined, undefined, undefined, null);
  assert.equal(removed.minimaxAnthropicBinding, null); assert.notEqual(removed.credentialLineage, same.credentialLineage);
  for (const edit of [{ accountId: "other" }, { accessToken: "synthetic-replaced" }, { refreshToken: "synthetic-other-refresh" }]) {
    const qualified = await f.put();
    const replacement = await putGrantCredentials(f.env, key, { ...qualified, ...edit }, true);
    assert.equal(replacement.minimaxAnthropicBinding, null);
    assert.notEqual(replacement.credentialLineage, qualified.credentialLineage);
  }
  await f.put();
  const oauthCompletion = await putGrantCredentials(f.env, key, grant(), true, undefined, "clawrouter_oauth");
  assert.equal(oauthCompletion.minimaxAnthropicBinding, null);
});

for (const edit of [{ kind: "api_key" }, { credential: "synthetic-mixed" }, { credentials: { arbitrary: "synthetic-map" } },
  { subscription: { subject: "plan" } }, { refresh: { tokenUrl: "https://other.example/token" } }, { expiresAt: null }])
  test("MiniMax owner refuses mismatched credential source " + JSON.stringify(edit), async () => {
    const f = setup(); await assert.rejects(() => f.put(grant(edit)), /MiniMax authorization/);
    assert.equal(f.env.GRANT_CREDENTIALS.objects.get(key).values.has("credential"), false);
  });

for (const [region, resource] of [["global", "https://api.minimax.io/anthropic"], ["cn", "https://api.minimaxi.com/anthropic"], ["cn", "https://api.minimax.cn/anthropic"]])
  test("MiniMax fenced materialize refresh preserves " + resource, async t => {
    const f = setup(), b = binding("oauth", region, resource), before = await f.put(grant({ expiresAt: "2020-01-01T00:00:00Z" }), b);
    let sent = 0;
    t.mock.method(globalThis, "fetch", async (url, init) => {
      sent++; assert.equal(url, b.tokenEndpoint); assert.equal(init.redirect, "manual");
      assert.equal(new URLSearchParams(init.body).get("refresh_token"), "synthetic-refresh-old");
      const current = f.env.GRANT_CREDENTIALS.objects.get(key).values.get("credential");
      assert.equal(current.refreshAttempt.generation, before.credentialGeneration);
      return Response.json({ status: "success", access_token: "synthetic-access-new", expired_in: "3600" });
    });
    const results = await Promise.all([f.materialize(before), f.materialize(before)]);
    assert.equal(sent, 1);
    for (const result of results) {
      assert.equal(result.accessToken, "synthetic-access-new"); assert.equal(result.refreshToken, "synthetic-refresh-old");
      assert.equal(result.credentialLineage, before.credentialLineage); assert.equal(result.credentialGeneration, before.credentialGeneration + 1);
      assert.deepEqual(result.minimaxAnthropicBinding, b); assert.ok(Date.parse(result.expiresAt) > Date.now() + 3500_000);
    }
    assert.equal(f.env.GRANT_CREDENTIALS.objects.get(key).values.get("credential").refreshAttempt, null);
    assert.doesNotMatch(JSON.stringify(f.values.get(key)), /synthetic-(?:access|refresh)/);
  });

for (const outcome of ["empty-refresh", "resource", "native-error", "pending", "expiry", "truncated", "redirect", "network", "persist"])
  test("MiniMax ambiguous " + outcome + " retains its durable fence without replay", async t => {
    const f = setup(), before = await f.put(grant({ expiresAt: "2020-01-01T00:00:00Z" }));
    let sent = 0;
    t.mock.method(globalThis, "fetch", async () => {
      sent++;
      if (outcome === "network") throw new Error("synthetic network loss");
      if (outcome === "redirect") return new Response(null, { status: 307, headers: { location: "https://other.example" } });
      if (outcome === "truncated") return new Response('{"status":', { headers: { "content-type": "application/json" } });
      if (outcome === "persist") {
        const owner = f.env.GRANT_CREDENTIALS.objects.get(key), put = owner.state.storage.put;
        owner.state.storage.put = async (name, record) => {
          if (record.accessToken === "synthetic-access-new") throw new Error("synthetic persistence failure");
          return put(name, record);
        };
      }
      return Response.json({ status: "success", access_token: "synthetic-access-new", expired_in: 3600,
        ...(outcome === "empty-refresh" ? { refresh_token: "" } : outcome === "resource" ? { resource_url: "https://api.minimaxi.com/anthropic" }
          : outcome === "native-error" ? { base_resp: { status_code: 1004 } } : outcome === "pending" ? { status: "pending" }
            : outcome === "expiry" ? { expired_in: 0 } : {}) });
    });
    await assert.rejects(() => f.materialize(before));
    const owner = f.env.GRANT_CREDENTIALS.objects.get(key), record = owner.values.get("credential");
    assert.ok(record.refreshAttempt); assert.equal(record.generation, before.credentialGeneration);
    assert.equal(record.accessToken, "synthetic-access-old");
    await assert.rejects(() => f.materialize(before)); assert.equal(sent, 1);
  });

test("MiniMax revoked or unqualified refresh authority performs no network work", async t => {
  const f = setup(); let sent = 0; t.mock.method(globalThis, "fetch", async () => { sent++; throw new Error("unexpected"); });
  const legacy = await putGrantCredentials(f.env, key, grant({ expiresAt: "2020-01-01T00:00:00Z", refresh: { tokenUrl: binding().tokenEndpoint } }));
  await assert.rejects(() => f.materialize(legacy)); assert.equal(sent, 0);
  const active = await f.put(); await revokeGrantCredentials(f.env, key);
  await assert.rejects(() => f.materialize(active)); assert.equal(sent, 0);
  assert.equal((await inspectGrantCredentials(f.env, key)).minimaxAnthropicBinding, null);
});

test("MiniMax owner alarm uses the same native refresh fence without a generic grant transport", async t => {
  const f = setup(), before = await f.put(grant({ expiresAt: "2020-01-01T00:00:00Z" }));
  let sent = 0;
  t.mock.method(globalThis, "fetch", async url => {
    sent++; assert.equal(url, binding().tokenEndpoint);
    assert.ok(f.env.GRANT_CREDENTIALS.objects.get(key).values.get("credential").refreshAttempt);
    return Response.json({ status: "success", access_token: "synthetic-access-new", expired_in: 3600 });
  });
  await f.env.GRANT_CREDENTIALS.objects.get(key).object.alarm();
  const after = await inspectGrantCredentials(f.env, key);
  assert.equal(sent, 1); assert.equal(after.credentialGeneration, before.credentialGeneration + 1);
  assert.equal(after.credentialLineage, before.credentialLineage);
});

for (const mode of ["overflow", "length", "utf8", "empty-chunks", "abort"])
  test("MiniMax token reader bounds and cancels " + mode, async () => {
    const abort = new AbortController(); let cancelled = 0, reads = 0;
    const stream = new ReadableStream({ pull(controller) {
      reads++;
      if (mode === "abort") { abort.abort(); return; }
      if (mode === "overflow") controller.enqueue(new Uint8Array(8193));
      else if (mode === "empty-chunks") controller.enqueue(new Uint8Array());
      else { controller.enqueue(mode === "utf8" ? new Uint8Array([255]) : new TextEncoder().encode("{}")); controller.close(); }
    }, cancel() { cancelled++; } }, { highWaterMark: 0 });
    const response = new Response(stream, { headers: { "content-type": "application/json", ...(mode === "length" ? { "content-length": "3" } : {}) } });
    await assert.rejects(() => readMiniMaxTokenBody(response, abort.signal));
    assert.equal(stream.locked, false);
    if (["overflow", "empty-chunks", "abort"].includes(mode)) assert.equal(cancelled, 1);
    assert.ok(reads <= 8193);
  });
