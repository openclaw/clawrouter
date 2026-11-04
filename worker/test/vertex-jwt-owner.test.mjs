import assert from "node:assert/strict";
import test from "node:test";
import { attachGrantCredentialNamespace } from "./grant-credential-mock.mjs";
import { syntheticVertexKey, signingBinding, tokenBody, bounded } from "./vertex-jwt-fixture.mjs";
const { GrantCredentialObject, materializeGrantCredentials, putGrantCredentials, inspectGrantCredentials, revokeGrantCredentials, secretlessGrant } = await import("../grant-credentials.ts");
const { routingProjection } = await import("../grant-projection.ts");
const key = "oauth/fixture/vertex", signing = await syntheticVertexKey();
const grant = () => ({ provider: "anthropic-vertex", kind: "oauth", enabled: true, tokenType: "Bearer" });
function setup() {
  const values = new Map();
  const env = attachGrantCredentialNamespace({ POLICY_KV: {
    async get(k, type) { const v = values.get(k) ?? null; return v === null ? null : type === "text" ? JSON.stringify(v) : structuredClone(v); },
    async put(k, value) { values.set(k, JSON.parse(value)); },
  } }, { kvValues: values });
  return { env, values,
    put: (g = grant(), binding = signingBinding(), pem = signing.pem, preserve = false) =>
      putGrantCredentials(env, key, g, preserve, undefined, undefined, undefined, undefined, binding, pem),
    materialize: (projection, signal, force = false) => materializeGrantCredentials(env, key, projection, "anthropic-vertex", null, force, signal),
    inspect: () => inspectGrantCredentials(env, key),
    record: () => env.GRANT_CREDENTIALS.objects.get(key).values.get("credential"),
    owner: () => env.GRANT_CREDENTIALS.objects.get(key),
  };
}
function hold(t) {
  const entered = Promise.withResolvers(), release = Promise.withResolvers(); let calls = 0, signal;
  t.mock.method(globalThis, "fetch", async (_input, init) => { calls++; signal = init.signal; entered.resolve(); return release.promise; });
  return { entered: entered.promise, calls: () => calls, signal: () => signal, release: () => release.resolve(Response.json(tokenBody())) };
}
test("Vertex key-only owner bootstrap signs fixed JWT and projects no private material", async t => {
  const f = setup(), projection = await f.put(); let calls = 0;
  assert.equal(projection.hasAccessToken, false); assert.equal(projection.hasRefreshToken, false);
  // Signing authority reserves its active pool slot at the explicit admin
  // commit; refresh must not try to activate an unadmitted attachment later.
  assert.deepEqual(f.env.grantAuthority.sql.exec("SELECT status FROM upstream_grant_pool_members WHERE provider_id = ? AND token_ref = ?", "anthropic-vertex", "vertex").map(row => row.status), ["active"]);
  assert.deepEqual(routingProjection(projection).vertexAnthropicBinding, signingBinding());
  assert.doesNotMatch(JSON.stringify(projection), /PRIVATE KEY|vertexPrivateKey|vertexServiceAccountPrivateKey/);
  assert.equal(secretlessGrant({ ...projection, vertexPrivateKey: signing.pem }).vertexPrivateKey, undefined);
  t.mock.method(globalThis, "fetch", async (input, init) => {
    calls++; const request = new Request(input, init); assert.equal(request.url, "https://oauth2.googleapis.com/token");
    assert.equal(request.redirect, "manual"); assert.equal(request.method, "POST"); assert.equal(request.headers.has("authorization"), false);
    const form = new URLSearchParams(await request.text()); assert.equal(form.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
    assert.deepEqual([...form.keys()].sort(), ["assertion", "grant_type"]);
    const [header, claims, signature] = form.get("assertion").split(".");
    assert.deepEqual(JSON.parse(Buffer.from(header, "base64url")), { alg: "RS256", typ: "JWT", kid: "synthetic-key" });
    const jwt = JSON.parse(Buffer.from(claims, "base64url"));
    assert.equal(jwt.iss, signingBinding().clientEmail); assert.equal(jwt.aud, request.url);
    assert.equal(jwt.scope, "https://www.googleapis.com/auth/cloud-platform"); assert.equal(jwt.exp - jwt.iat, 3600); assert.equal(jwt.sub, undefined);
    assert.equal(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", signing.publicKey, Buffer.from(signature, "base64url"), new TextEncoder().encode(`${header}.${claims}`)), true);
    return Response.json(tokenBody());
  });
  const before = Date.now(), materialized = await f.materialize(projection);
  assert.equal(calls, 1); assert.equal(materialized.accessToken, "synthetic-jwt-access"); assert.equal(materialized.refreshToken, undefined);
  assert.equal(materialized.vertexPrivateKey, undefined); assert.equal(materialized.credentialLineage, projection.credentialLineage);
  assert.equal(materialized.credentialGeneration, projection.credentialGeneration + 1);
  assert.ok(Date.parse(materialized.expiresAt) <= before + 3600000);
  const current = await f.inspect(); assert.equal((await f.materialize(current)).accessToken, "synthetic-jwt-access"); assert.equal(calls, 1);
  assert.equal(f.record().refreshAttempt, null); assert.ok(f.owner().alarm() > Date.now());
});
for (const action of ["revoke", "disable", "resource", "generation", "cancel", "replace"])
  test(`Vertex held exchange permits concurrent ${action} and never installs late success`, async t => {
    const f = setup(), projection = await f.put(), io = hold(t), controller = new AbortController();
    const pending = f.materialize(projection, controller.signal); const rejected = assert.rejects(pending);
    await bounded(io.entered, "exchange start"); assert.ok(f.record().refreshAttempt);
    const duplicate = await bounded(f.materialize(projection).then(() => "unexpected", () => "denied"), "duplicate materialization"); assert.equal(duplicate, "denied");
    assert.equal((await bounded(f.inspect(), "live inspection")).credentialRefreshBlockedUntil, null);
    if (action === "cancel") controller.abort();
    else if (action === "revoke") await bounded(revokeGrantCredentials(f.env, key), "revocation");
    else if (action === "disable") await bounded(putGrantCredentials(f.env, key, { ...projection, enabled: false }, true), "disable");
    else if (action === "generation") await bounded(putGrantCredentials(f.env, key, { ...projection, label: "updated" }, true), "generation mutation");
    else if (action === "resource") await bounded(f.put(projection, signingBinding({ location: "eu" }), signing.pem, true), "binding replacement");
    else await bounded(f.put(grant(), signingBinding(), (await syntheticVertexKey()).pem), "key replacement");
    await bounded(rejected, "original cancellation"); assert.equal(io.signal().aborted, true);
    io.release(); await Promise.resolve();
    assert.equal(f.record().accessToken, undefined); assert.equal(io.calls(), 1);
    if (action !== "replace") await assert.rejects(f.materialize(projection));
    assert.equal(io.calls(), 1);
  });
for (const fault of ["before", "after"])
  test(`Vertex atomic credential commit ${fault}-write failure never repeats exchange`, async t => {
    const f = setup(), projection = await f.put(); let calls = 0;
    t.mock.method(globalThis, "fetch", async () => { calls++; return Response.json(tokenBody()); });
    const storage = f.owner().state.storage, put = storage.put.bind(storage); let failed = false;
    storage.put = async (name, value) => {
      if (!failed && value.accessToken === "synthetic-jwt-access") { failed = true; if (fault === "after") await put(name, value); throw new Error("synthetic storage failure"); }
      return put(name, value);
    };
    if (fault === "before") {
      await assert.rejects(f.materialize(projection)); assert.equal(f.record().accessToken, undefined);
      assert.equal(f.record().refreshDiagnosis.failure.failureClass, "provider_ok_persist_failed");
      await assert.rejects(f.materialize(await f.inspect(), undefined, true));
    } else {
      assert.equal((await f.materialize(projection)).accessToken, "synthetic-jwt-access");
      assert.equal((await f.materialize(await f.inspect())).accessToken, "synthetic-jwt-access");
    }
    assert.equal(calls, 1);
  });
test("Vertex restart diagnoses durable in-flight fence and rejects the old late completion", async t => {
  const f = setup(), projection = await f.put(), io = hold(t);
  const pending = assert.rejects(f.materialize(projection)); await bounded(io.entered, "exchange start");
  f.owner().object = new GrantCredentialObject(f.owner().state, f.env);
  const inspected = await f.inspect(); assert.equal(inspected.refreshDiagnosis.failure.failureClass, "ambiguous");
  await assert.rejects(f.materialize(inspected)); io.release(); await bounded(pending, "late completion");
  assert.equal(f.record().accessToken, undefined); assert.equal(io.calls(), 1);
});
for (const [name, response] of [
  ["redirect", () => new Response(null, { status: 302, headers: { location: "https://foreign.invalid" } })],
  ["scope", () => Response.json(tokenBody({ scope: "foreign" }))], ["type", () => Response.json(tokenBody({ token_type: "Basic" }))],
  ["short expiry", () => Response.json(tokenBody({ expires_in: 60 }))], ["fractional expiry", () => Response.json(tokenBody({ expires_in: 1.5 }))],
  ["refresh token", () => Response.json({ ...tokenBody(), refresh_token: "forbidden" })],
  ["utf8", () => new Response(new Uint8Array([255]), { headers: { "content-type": "application/json" } })],
  ["length", () => new Response(JSON.stringify(tokenBody()), { headers: { "content-type": "application/json", "content-length": "1" } })],
  ["compression", () => new Response(JSON.stringify(tokenBody()), { headers: { "content-type": "application/json", "content-encoding": "gzip" } })],
  ["overflow", () => new Response(" ".repeat(32769), { headers: { "content-type": "application/json" } })],
  ["empty chunks", () => new Response(new ReadableStream({ start(c) { for (let i = 0; i < 8193; i++) c.enqueue(new Uint8Array()); c.close(); } }), { headers: { "content-type": "application/json" } })],
  ["interrupted", () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"access_token":')); c.error(new Error("synthetic interruption")); } }), { headers: { "content-type": "application/json" } })],
]) test(`Vertex ${name} response retains uncertainty with zero replay`, async t => {
  const f = setup(), projection = await f.put(); let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return response(); });
  await assert.rejects(f.materialize(projection)); assert.equal(f.record().accessToken, undefined); assert.ok(f.record().refreshAttempt);
  await assert.rejects(f.materialize(await f.inspect(), undefined, true)); assert.equal(calls, 1);
});
test("Vertex request-start expiry does not gain remote latency", async t => {
  let now = Date.now(); t.mock.method(Date, "now", () => now);
  const f = setup(), projection = await f.put();
  t.mock.method(globalThis, "fetch", async () => { now += 90000; return Response.json(tokenBody({ expires_in: 120 })); });
  await assert.rejects(f.materialize(projection)); assert.equal(f.record().accessToken, undefined); assert.ok(f.record().refreshAttempt);
});
test("Vertex same signing key cannot clear uncertainty; different explicitly supplied key can", async t => {
  const f = setup(), projection = await f.put(); let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; throw new Error("synthetic network uncertainty"); });
  await assert.rejects(f.materialize(projection));
  const unchanged = await f.put(grant()); await assert.rejects(f.materialize(unchanged)); assert.equal(calls, 1);
  const renewed = await f.put(grant(), signingBinding(), (await syntheticVertexKey()).pem);
  assert.equal(renewed.credentialRefreshBlockedUntil, false); assert.notEqual(renewed.credentialLineage, projection.credentialLineage);
});
for (const patch of [{ source: "access_token" }, { clientEmail: "foreign@example.invalid" }, { location: "../foreign" }, { tokenUrl: "https://foreign.invalid" }, { scope: "foreign" }])
  test(`Vertex rejects unqualified signing intent ${Object.keys(patch)[0]}`, async () => { await assert.rejects(setup().put(grant(), signingBinding(patch))); });
test("Vertex private key is never inherited by legacy import or OAuth completion", async () => {
  const f = setup(), projection = await f.put();
  const forged = await putGrantCredentials(f.env, key, { ...projection, vertexPrivateKey: signing.pem });
  assert.equal(forged.vertexAnthropicBinding, null); assert.equal(f.record().vertexPrivateKey, undefined);
  const imported = await putGrantCredentials(f.env, key, { ...projection, accessToken: "synthetic-import", expiresAt: new Date(Date.now() + 3600000).toISOString() }, true, undefined, "clawrouter_oauth");
  assert.equal(imported.vertexAnthropicBinding, null); assert.equal(f.record().vertexPrivateKey, undefined);
});
test("Vertex alarm uses the same fenced exchange and preserves signing lineage", async t => {
  let now = Date.now(); t.mock.method(Date, "now", () => now);
  const f = setup(), projection = await f.put(); let calls = 0;
  t.mock.method(globalThis, "fetch", async () => Response.json(tokenBody({ access_token: `synthetic-alarm-${++calls}` })));
  await f.materialize(projection); const before = await f.inspect();
  now += 3300001; await f.owner().object.alarm();
  const after = await f.inspect(); assert.equal(calls, 2); assert.equal(after.credentialGeneration, before.credentialGeneration + 1);
  assert.equal(after.credentialLineage, before.credentialLineage); assert.equal(after.hasRefreshToken, false);
  assert.equal((await f.materialize(after)).accessToken, "synthetic-alarm-2"); assert.equal(calls, 2);
});
test("Vertex new signing resource or key retires the old access token before reuse", async t => {
  const f = setup(), projection = await f.put();
  t.mock.method(globalThis, "fetch", async () => Response.json(tokenBody())); await f.materialize(projection);
  const old = await f.inspect();
  const updated = await f.put(old, signingBinding({ location: "eu" }), signing.pem, true);
  assert.equal(updated.hasAccessToken, false); assert.equal(updated.expiresAt, null); assert.notEqual(updated.credentialLineage, old.credentialLineage);
  assert.equal(f.record().accessToken, undefined);
});
