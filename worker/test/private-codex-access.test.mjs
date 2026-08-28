import assert from "node:assert/strict";
import { extname } from "node:path";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({ resolve(specifier, context, next) {
  return next(specifier.startsWith(".") && context.parentURL && !extname(new URL(specifier, context.parentURL).pathname) ? `${specifier}.ts` : specifier, context);
} });
const { default: worker } = await import("../index.ts");
const { privatePolicy } = await import("../private-codex-config.ts");
const issuer = "https://synthetic-owner.cloudflareaccess.com";
const audience = "synthetic-private-audience";
const account = 123456;
const idp = "synthetic-approved-github-idp";
const email = "synthetic-owner@example.invalid";
const alias = "codex-latest";
const paths = ["/private/v1/models", "/private/v1/catalog", "/private/v1/responses"];
const enc = new TextEncoder();
let keys, jwk;
test.before(async () => {
  keys = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  jwk = { ...await crypto.subtle.exportKey("jwk", keys.publicKey), kid: "synthetic-github-binding-key" };
});
async function jwt(patch = {}, header = {}, forged = false) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const payload = { iss: issuer, aud: audience, sub: "synthetic-access-subject", email, exp: Math.floor(Date.now() / 1000) + 300, ...patch };
  const unsigned = `${encode({ alg: "RS256", kid: jwk.kid, ...header })}.${encode(payload)}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, enc.encode(unsigned));
  return `${unsigned}.${forged ? "c3ludGhldGlj" : Buffer.from(signature).toString("base64url")}`;
}
const policy = () => ({ version: 1, enabled: true, alias: { id: alias, name: "Codex (Latest)" }, auth: { mode: "access", issuer, audience, githubAccountId: account, identityProviderId: idp } });
const identity = (patch = {}) => ({ email, id: account, idp: { type: "github", id: idp }, ...patch });
function harness(context) {
  const state = { policy: policy(), upstream: { version: 1, target: "SYNTHETIC_ACCESS_TARGET_7Q", accountId: "SYNTHETIC_ACCESS_ACCOUNT_9R", accessToken: "SYNTHETIC_ACCESS_TOKEN_4P", expiresAt: Date.now() + 3600_000 }, secretReads: 0, policyReads: 0, identities: 0, certs: 0, inference: 0, unexpectedFetches: 0, genericReads: [], logs: [], lookup: () => Response.json(identity()) };
  context.after(() => {
    assert.equal(state.unexpectedFetches, 0);
    assert.deepEqual(state.genericReads, []);
    assert.deepEqual(state.logs, []);
  });
  const env = new Proxy({
    PRIVATE_CODEX_POLICY: { get: async () => { state.policyReads++; return JSON.stringify(state.policy); } },
    PRIVATE_CODEX_UPSTREAM: { get: async () => { state.secretReads++; return JSON.stringify(state.upstream); } },
  }, { get(object, key) {
    if (!Object.hasOwn(object, key)) { state.genericReads.push(key); throw new Error("unexpected generic binding"); }
    return object[key];
  } });
  for (const name of ["log", "info", "warn", "error", "debug"]) context.mock.method(console, name, (...args) => state.logs.push(args));
  context.mock.method(globalThis, "fetch", async (url, init) => {
    if (url === `${issuer}/cdn-cgi/access/certs`) { state.certs++; return Response.json({ keys: [jwk] }); }
    if (url === `${issuer}/cdn-cgi/access/get-identity`) {
      state.identities++;
      assert.equal(init.redirect, "manual");
      assert.equal(init.cache, "no-store");
      assert.ok(init.signal instanceof AbortSignal);
      assert.deepEqual([...new Headers(init.headers).keys()], ["accept-encoding", "cookie"]);
      assert.equal(new Headers(init.headers).get("accept-encoding"), "identity");
      return state.lookup(init);
    }
    if (url !== "https://chatgpt.com/backend-api/codex/responses") { state.unexpectedFetches++; throw new Error("unexpected fetch destination"); }
    state.inference++;
    assert.ok(!new Headers(init.headers).has("cf-access-jwt-assertion"));
    assert.ok(!new Headers(init.headers).has("cookie"));
    return Response.json({ object: "response", model: state.upstream.target, status: "completed", output: [] });
  });
  const run = (assertion, path = paths[0], options = {}) => {
    const method = path.endsWith("/responses") ? "POST" : "GET";
    return worker.fetch(new Request(`https://private.example.invalid${path}`, { method, headers: { "cf-access-jwt-assertion": assertion, ...(method === "POST" ? { "content-type": "application/json" } : {}), ...options.headers }, ...(method === "POST" ? { body: JSON.stringify({ model: alias, store: false }) } : {}), ...options }), env, { waitUntil() { assert.fail("no private persistence"); } });
  };
  return { state, env, run };
}
async function denied(response) {
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: { code: "route_not_found", message: "route not found" } });
  assert.deepEqual([...response.headers.keys()].sort(), ["cache-control", "content-type", "x-clawrouter-accounting", "x-clawrouter-content-retention", "x-content-type-options"]);
}
function noPrivateUse(state) { assert.equal(state.secretReads, 0); assert.equal(state.inference, 0); assert.deepEqual(state.logs, []); }
async function enteredOrFailed(entered, pending) {
  await Promise.race([entered.promise, pending.then(() => assert.fail("expected awaited identity lookup"))]);
}

test("Access policy requires GitHub account and exact IdP; retired subject-only policy cannot authorize", async (context) => {
  const { state, env, run } = harness(context);
  assert.ok(await privatePolicy(env));
  const invalid = [
    { mode: "access", issuer, audience, subject: "synthetic-access-subject" },
    ...[undefined, null, 0, -1, 1.5, "123456", Number.MAX_SAFE_INTEGER + 1].map((githubAccountId) => ({ ...policy().auth, githubAccountId })),
    ...[undefined, null, "", "synthetic idp", "x".repeat(257), "synthetic\nidp"].map((identityProviderId) => ({ ...policy().auth, identityProviderId })),
    { ...policy().auth, subject: "synthetic-access-subject" },
    ...[`${issuer}/`, `${issuer}/path`, `${issuer}?query`, "https://synthetic-owner.cloudflareaccess.com.evil.invalid", "http://synthetic-owner.cloudflareaccess.com"].map((issuer) => ({ ...policy().auth, issuer })),
  ];
  const assertion = await jwt();
  for (const auth of invalid) {
    state.policy.auth = auth;
    assert.equal(await privatePolicy(env), null);
    await denied(await run(assertion));
  }
  assert.equal(state.identities, 0); noPrivateUse(state);
});

test("signature, pinned issuer/audience, numeric time and email validate before any identity lookup", async (context) => {
  const { state, run } = harness(context);
  for (const patch of [
    { iss: "https://synthetic-other.cloudflareaccess.com" }, { iss: `${issuer}/` }, { aud: "synthetic-wrong-audience" },
    { exp: 1 }, { exp: undefined }, { exp: "99999999999" }, { exp: null },
    { nbf: 99999999999 }, { nbf: "1" }, { iat: 99999999999 }, { iat: "1" },
    { email: undefined }, { email: "" }, { email: " " }, { email: 123 }, { email: "x".repeat(1025) },
  ]) for (const path of paths) await denied(await run(await jwt(patch), path));
  for (const assertion of [await jwt({}, {}, true), await jwt({}, { alg: "HS256" }), await jwt({}, { kid: "synthetic-unknown" }), "synthetic.forged.jwt", `${await jwt()};synthetic=cookie`]) await denied(await run(assertion));
  assert.equal(state.identities, 0); noPrivateUse(state);
});

test("exact assertion lookup binds numeric GitHub account and approved IdP, independent of changing email/sub", async (context) => {
  const { state, run } = harness(context);
  for (const [emailValue, sub] of [[email, "synthetic-original-sub"], ["synthetic-new@example.invalid", "synthetic-new-sub"], [email, undefined]]) {
    const assertion = await jwt({ email: emailValue, sub });
    state.lookup = (init) => {
      assert.ok(new Headers(init.headers).get("cookie") === `CF_Authorization=${assertion}`, "exact verified assertion cookie");
      return Response.json(identity({ email: ` ${emailValue.toUpperCase()} `, name: "SYNTHETIC_PRIVATE_IDENTITY_NAME", groups: ["synthetic-admin"] }));
    };
    for (const path of paths) {
      const response = await run(assertion, path);
      assert.equal(response.status, 200);
      const body = await response.text();
      assert.ok(body.includes(alias));
      for (const sensitive of [assertion, emailValue, idp, String(account), "synthetic-admin", "SYNTHETIC_PRIVATE_IDENTITY_NAME", ...Object.values(state.upstream).filter((value) => typeof value === "string")]) assert.ok(!body.includes(sensitive), "no private identity in response");
    }
  }
  assert.equal(state.identities, 12); assert.equal(state.inference, 3); assert.deepEqual(state.logs, []);
});

test("same email and Access subject never authorize a different GitHub account or IdP", async (context) => {
  const { state, run } = harness(context);
  const assertion = await jwt();
  const patches = [
    ...[account + 1, undefined, null, 0, -1, 1.5, String(account), Number.MAX_SAFE_INTEGER + 1].map((id) => ({ id })),
    ...[undefined, null, {}, { type: "github" }, { id: idp }, { type: "GitHub", id: idp }, { type: "oidc", id: idp }, { type: "github", id: `${idp}-other` }, { type: "github", id: null }].map((idp) => ({ idp })),
    ...[undefined, null, "", "synthetic-other@example.invalid", 123].map((email) => ({ email })),
  ];
  for (const patch of patches) {
    state.lookup = () => Response.json(identity({ ...patch, login: "synthetic-owner", user_uuid: "synthetic-access-subject", account_id: account, groups: ["admin"], admin: true }));
    for (const path of paths) await denied(await run(assertion, path));
  }
  noPrivateUse(state);
});

test("identity failures, invalid UTF-8, encoding, oversize and redirects are generic and cancel bodies", async (context) => {
  const { state, run } = harness(context);
  const assertion = await jwt();
  for (const make of [
    () => Response.json(null), () => Response.json([]), () => new Response("{"),
    () => new Response(new Uint8Array([0xff])),
    () => Response.json(identity(), { headers: { "content-encoding": "gzip" } }),
    () => Response.json(identity({ padding: "x".repeat(65536) })),
    ...[301, 302, 307, 308, 401, 403, 429, 500, 503].map((status) => () => new Response("SYNTHETIC_IDENTITY_ERROR", { status, headers: { location: "https://synthetic-other.invalid/identity" } })),
    () => { throw new Error(`SYNTHETIC_COOKIE_ERROR CF_Authorization=${assertion}`); },
  ]) {
    state.lookup = make;
    await denied(await run(assertion));
  }
  for (const status of [200, 302]) {
    let canceled = false;
    state.lookup = () => new Response(new ReadableStream({ start(c) { c.enqueue(enc.encode("x".repeat(65537))); }, cancel() { canceled = true; } }), { status });
    await denied(await run(assertion));
    assert.equal(canceled, true);
  }
  assert.equal(state.inference, 0); noPrivateUse(state);
});

test("conflicting auth including empty headers denies before certificate or identity fetch", async (context) => {
  const { state, run } = harness(context);
  const assertion = await jwt();
  for (const name of ["authorization", "x-api-key", "api-key", "x-goog-api-key", "proxy-authorization", "cf-access-client-id", "cf-access-client-secret"]) {
    for (const value of ["", "SYNTHETIC_CONFLICT"]) {
      await denied(await run(assertion, paths[0], { headers: { "cf-access-jwt-assertion": assertion, [name]: value } }));
    }
  }
  assert.equal(state.identities, 0); assert.equal(state.certs, 0); noPrivateUse(state);
});

for (const phase of ["fetch", "body"]) for (const cause of ["timeout", "abort"]) {
  test(`identity ${phase} ${cause} fails closed and cancels without echoing assertion`, async (context) => {
    const { state, run } = harness(context);
    const entered = Promise.withResolvers(), abort = new AbortController(), deadline = new AbortController();
    if (cause === "timeout") context.mock.method(AbortSignal, "timeout", (ms) => { assert.equal(ms, 10000); return deadline.signal; });
    let canceled = false;
    state.lookup = (init) => {
      entered.resolve();
      if (phase === "fetch") return new Promise((_, reject) => init.signal.addEventListener("abort", () => { canceled = true; reject(new Error(`SYNTHETIC_FETCH_FAILURE ${new Headers(init.headers).get("cookie")}`)); }, { once: true }));
      return new Response(new ReadableStream({ cancel() { canceled = true; } }));
    };
    const pending = run(await jwt(), paths[0], { signal: abort.signal });
    await enteredOrFailed(entered, pending);
    if (phase === "body") await new Promise((resolve) => setImmediate(resolve));
    if (cause === "abort") abort.abort(); else deadline.abort(new DOMException("synthetic deadline", "TimeoutError"));
    await denied(await pending); assert.equal(canceled, true); noPrivateUse(state);
  });
}

test("policy rotation while identity lookup is pending denies before private secret reads", async (context) => {
  const { state, run } = harness(context);
  for (const change of [
    () => { state.policy.enabled = false; },
    () => { state.policy.auth.githubAccountId++; },
    () => { state.policy.auth.identityProviderId += "-rotated"; },
    () => { state.policy.auth = { mode: "workload", credentialSha256: "a".repeat(64) }; },
  ]) {
    state.policy = policy();
    const entered = Promise.withResolvers(), release = Promise.withResolvers();
    state.lookup = () => { entered.resolve(); return release.promise; };
    const pending = run(await jwt());
    await enteredOrFailed(entered, pending); change(); release.resolve(Response.json(identity()));
    await denied(await pending);
  }
  noPrivateUse(state);
});

test("JWT expiration during awaited identity or subsequent policy/secret reads denies", async (context) => {
  const { state, env, run } = harness(context);
  const originalNow = Date.now;
  const now = originalNow(); let clock = now;
  context.mock.method(Date, "now", () => clock);
  for (const phase of ["identity", "policy", "secret"]) {
    clock = now;
    const expire = () => { clock = now + 400000; };
    state.lookup = () => { if (phase === "identity") expire(); return Response.json(identity()); };
    const policyGet = env.PRIVATE_CODEX_POLICY.get, upstreamGet = env.PRIVATE_CODEX_UPSTREAM.get;
    if (phase === "policy") env.PRIVATE_CODEX_POLICY.get = async () => { if (state.identities > 0) expire(); return policyGet(); };
    if (phase === "secret") env.PRIVATE_CODEX_UPSTREAM.get = async () => { expire(); return upstreamGet(); };
    state.identities = 0; state.secretReads = 0;
    await denied(await run(await jwt()));
    assert.equal(state.secretReads, phase === "secret" ? 1 : 0);
    env.PRIVATE_CODEX_POLICY.get = policyGet; env.PRIVATE_CODEX_UPSTREAM.get = upstreamGet;
  }
  assert.equal(state.inference, 0); assert.deepEqual(state.logs, []);
});

test("upload revalidates current GitHub identity and rejects policy or upstream rotation", async (context) => {
  const { state, env } = harness(context);
  for (const change of ["identity", "policy", "upstream", "expired"]) {
    state.policy = policy(); state.lookup = () => Response.json(identity());
    state.upstream.expiresAt = Date.now() + 3600000;
    let controller; const waiting = Promise.withResolvers();
    const body = new ReadableStream({ start(c) { controller = c; }, pull() { waiting.resolve(); } }, { highWaterMark: 0 });
    const request = new Request(`https://private.example.invalid${paths[2]}`, { method: "POST", body, duplex: "half", headers: { "content-type": "application/json", "cf-access-jwt-assertion": await jwt() } });
    const pending = worker.fetch(request, env, { waitUntil() { assert.fail("no persistence"); } });
    await Promise.race([waiting.promise, pending.then(() => assert.fail("expected paused upload"))]);
    const reads = state.secretReads;
    if (change === "identity") state.lookup = () => Response.json(identity({ id: account + 1 }));
    if (change === "policy") state.policy.auth.identityProviderId += "-rotated";
    if (change === "upstream") state.upstream.accessToken += "_ROTATED";
    if (change === "expired") state.upstream.expiresAt = 1;
    controller.enqueue(enc.encode(JSON.stringify({ model: alias, store: false }))); controller.close();
    await denied(await pending);
    assert.equal(state.secretReads - reads, ["identity", "policy"].includes(change) ? 0 : 1);
  }
  assert.equal(state.inference, 0); assert.deepEqual(state.logs, []);
});

test("final awaited identity lookup cannot bypass policy or upstream revalidation", async (context) => {
  const { state, run } = harness(context);
  for (const change of ["policy", "upstream"]) {
    state.policy = policy(); state.identities = 0;
    state.lookup = () => {
      if (state.identities === 2) {
        if (change === "policy") state.policy.auth.githubAccountId++;
        else state.upstream.accessToken += "_ROTATED";
      }
      return Response.json(identity());
    };
    const reads = state.secretReads;
    await denied(await run(await jwt(), paths[2]));
    assert.equal(state.identities, 2);
    assert.equal(state.secretReads - reads, change === "policy" ? 1 : 2);
  }
  assert.equal(state.inference, 0); assert.deepEqual(state.logs, []);
});

test("successful identity is never cached or used as fallback on a later request", async (context) => {
  const { state, run } = harness(context);
  const assertion = await jwt();
  assert.equal((await run(assertion)).status, 200);
  const reads = state.secretReads;
  for (const lookup of [
    () => Response.json(identity({ id: account + 1 })),
    () => new Response(null, { status: 503 }),
    () => { throw new Error("SYNTHETIC_REVOKED_IDENTITY"); },
  ]) {
    state.lookup = lookup;
    await denied(await run(assertion));
  }
  assert.equal(state.identities, 4); assert.equal(state.secretReads, reads);
  assert.equal(state.inference, 0); assert.deepEqual(state.logs, []);
});

test("identity byte bound accepts exactly 64 KiB including split UTF-8 and rejects one byte more", async (context) => {
  const { state, run } = harness(context);
  state.policy.auth.githubAccountId = Number.MAX_SAFE_INTEGER;
  state.policy.auth.identityProviderId = "x".repeat(256);
  const assertion = await jwt();
  const payload = identity({ id: Number.MAX_SAFE_INTEGER, idp: { type: "github", id: state.policy.auth.identityProviderId }, padding: "é" });
  payload.padding += "x".repeat(65536 - Buffer.byteLength(JSON.stringify(payload)));
  const bytes = enc.encode(JSON.stringify(payload));
  assert.equal(bytes.length, 65536);
  for (const chunkSize of [1, 17, 65536]) {
    let offset = 0;
    state.lookup = () => new Response(new ReadableStream({ pull(controller) {
      if (offset === bytes.length) { controller.close(); return; }
      const end = Math.min(offset + chunkSize, bytes.length); controller.enqueue(bytes.slice(offset, end)); offset = end;
    } }));
    assert.equal((await run(assertion)).status, 200);
  }
  const reads = state.secretReads;
  state.lookup = () => Response.json({ ...payload, padding: `${payload.padding}x` });
  await denied(await run(assertion));
  assert.equal(state.secretReads, reads); assert.equal(state.inference, 0); assert.deepEqual(state.logs, []);
});

test("expired verification or pre-aborted requests cannot start identity lookup", async (context) => {
  const { state, run } = harness(context);
  const now = Date.now(); let clock = now;
  context.mock.method(Date, "now", () => clock);
  const assertion = await jwt();
  const abort = new AbortController(); abort.abort();
  await denied(await run(assertion, paths[0], { signal: abort.signal }));
  assert.equal(state.certs, 0);
  context.mock.method(globalThis, "fetch", async (url) => {
    assert.equal(url, `${issuer}/cdn-cgi/access/certs`);
    clock = now + 400000;
    return Response.json({ keys: [jwk] });
  });
  await denied(await run(assertion));
  assert.equal(state.identities, 0); noPrivateUse(state);
});

test("policy changes during secret reads and subscription expiry during final policy await deny", async (context) => {
  const { state, env, run } = harness(context);
  const originalGet = env.PRIVATE_CODEX_UPSTREAM.get;
  for (const phase of ["first", "final"]) {
    state.policy = policy(); state.secretReads = 0;
    env.PRIVATE_CODEX_UPSTREAM.get = async () => {
      const result = await originalGet();
      if (state.secretReads === (phase === "first" ? 1 : 2)) state.policy.auth.identityProviderId += "-rotated";
      return result;
    };
    await denied(await run(await jwt(), paths[2]));
    assert.equal(state.secretReads, phase === "first" ? 1 : 2);
  }
  env.PRIVATE_CODEX_UPSTREAM.get = originalGet;
  state.policy = policy(); state.secretReads = 0;
  const now = Date.now(); let clock = now;
  context.mock.method(Date, "now", () => clock);
  state.upstream.expiresAt = now + 60000;
  const policyGet = env.PRIVATE_CODEX_POLICY.get;
  env.PRIVATE_CODEX_POLICY.get = async () => { if (state.secretReads === 2) clock = now + 31000; return policyGet(); };
  await denied(await run(await jwt(), paths[2]));
  assert.equal(state.secretReads, 2); assert.equal(state.inference, 0); assert.deepEqual(state.logs, []);
});
