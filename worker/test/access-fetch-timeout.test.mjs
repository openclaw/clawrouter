import assert from "node:assert/strict";
import { createServer } from "node:http";
import { extname } from "node:path";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && context.parentURL && !extname(new URL(specifier, context.parentURL).pathname)) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

const { verifiedAccessSession } = await import("../access.ts");
const { evaluateUserAssignments, withLegacyAssignmentState } = await import("../assignment-evaluator.ts");

const teamDomain = "team.cloudflareaccess.com";
const audience = "aud-1";
const email = "member@example.com";
const certsUrl = `https://${teamDomain}/cdn-cgi/access/certs`;
const identityUrl = "https://console.example/cdn-cgi/access/get-identity";

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function unsignedJwt(kid = "test-kid") {
  return `${encode({ alg: "RS256", kid })}.${encode({
    aud: audience,
    iss: `https://${teamDomain}`,
    email,
    exp: Math.floor(Date.now() / 1000) + 300,
  })}.c2ln`;
}

async function signedJwt(privateKey, kid) {
  const unsigned = `${encode({ alg: "RS256", kid })}.${encode({
    aud: audience,
    iss: `https://${teamDomain}`,
    email,
    sub: "access-subject",
    exp: Math.floor(Date.now() / 1000) + 300,
  })}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, new TextEncoder().encode(unsigned));
  return `${unsigned}.${Buffer.from(signature).toString("base64url")}`;
}

function accessEnv(kv = new Map(), users = new Map()) {
  return {
    CLAWROUTER_ACCESS_TEAM_DOMAIN: teamDomain,
    CLAWROUTER_ACCESS_AUD: audience,
    POLICY_KV: {
      async list({ prefix }) {
        const keys = [...kv.keys()].filter((key) => key.startsWith(prefix)).map((name) => ({ name }));
        return { keys, list_complete: true };
      },
      async get(key, type) {
        const value = kv.get(key);
        return value === undefined ? null : type === "json" ? structuredClone(value) : value;
      },
    },
    ACCESS_CONTROL: {
      idFromName: (name) => name,
      get: () => ({
        fetch: async (url, init) => {
          const path = new URL(url).pathname;
          const body = init?.body ? JSON.parse(init.body) : {};
          if (path === "/users/resolve") {
            const found = (body.emails ?? []).filter((item) => users.has(item)).map((item) => ({ email: item, record: users.get(item) }));
            return Response.json({ initialized: true, users: found, missingEmails: (body.emails ?? []).filter((item) => !users.has(item)) });
          }
          if (path === "/users/put") {
            users.set(body.email, body.record);
            return new Response("updated");
          }
          if (path === "/users/create") {
            if (!users.has(body.email)) users.set(body.email, body.record);
            return Response.json({ email: body.email, record: users.get(body.email) });
          }
          if (path === "/users/reconcile-assignments") {
            const user = { email: body.email, record: users.get(body.email) };
            const result = evaluateUserAssignments(withLegacyAssignmentState(user, body.legacy), body.rules, body.evidence, body.force);
            if (result.changed) users.set(body.email, result.user.record);
            return Response.json(result);
          }
          return Response.json({ error: { code: "route_not_found" } }, { status: 404 });
        },
      }),
    },
  };
}

function sessionRequest(assertion, extraHeaders = {}) {
  return new Request("https://console.example/v1/session", {
    headers: { "cf-access-jwt-assertion": assertion, ...extraHeaders },
  });
}

test("public Access certs fetch attaches a 30s AbortSignal", async (context) => {
  const timeouts = [];
  const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
  context.mock.method(AbortSignal, "timeout", (ms) => {
    timeouts.push(ms);
    return nativeTimeout(ms);
  });
  let certsInit;
  context.mock.method(globalThis, "fetch", async (input, init) => {
    assert.equal(String(input), certsUrl);
    certsInit = init;
    return Response.json({ keys: [] });
  });

  const session = await verifiedAccessSession(sessionRequest(unsignedJwt()), accessEnv());
  assert.equal(session, null);
  assert.ok(certsInit.signal instanceof AbortSignal);
  assert.equal(certsInit.signal.aborted, false);
  assert.deepEqual(timeouts, [30_000]);
});

test("public Access certs fetch aborts a hung certs endpoint", { timeout: 2_000 }, async (context) => {
  const server = createServer(() => {});
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const nativeFetch = globalThis.fetch.bind(globalThis);
  const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
  const timeouts = [];
  context.mock.method(AbortSignal, "timeout", (ms) => {
    timeouts.push(ms);
    return nativeTimeout(40);
  });
  context.mock.method(globalThis, "fetch", async (input, init) => {
    assert.equal(String(input), certsUrl);
    return nativeFetch(`http://127.0.0.1:${port}/hung`, { signal: init?.signal });
  });

  context.after(() => {
    server.closeAllConnections();
    server.close();
  });
  await assert.rejects(
    verifiedAccessSession(sessionRequest(unsignedJwt()), accessEnv()),
    (error) => error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError"),
  );
  assert.deepEqual(timeouts, [30_000]);
});

test("GitHub identity fetch attaches a 30s AbortSignal and fails open on timeout", async (context) => {
  const keys = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const kid = "github-binding-key";
  const jwk = { ...await crypto.subtle.exportKey("jwk", keys.publicKey), kid, kty: "RSA" };
  const assertion = await signedJwt(keys.privateKey, kid);
  const kv = new Map([
    ["access/assignment-rules/org", {
      version: 1,
      enabled: true,
      kind: "github_org",
      subject: "openclaw",
      groups: ["maintainers"],
      policyIds: ["policy"],
      priority: 10,
      revokeOnLoss: true,
      provenance: "cloudflare_access",
    }],
  ]);
  const users = new Map([
    [email, { role: "user", tenantId: "default", enabled: true, groups: [], contentRetentionDisabled: false }],
  ]);
  const timeouts = [];
  const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
  context.mock.method(AbortSignal, "timeout", (ms) => {
    timeouts.push(ms);
    return nativeTimeout(ms);
  });
  let identityInit;
  context.mock.method(globalThis, "fetch", async (input, init) => {
    if (String(input) === certsUrl) return Response.json({ keys: [jwk] });
    assert.equal(String(input), identityUrl);
    identityInit = init;
    throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
  });

  const session = await verifiedAccessSession(sessionRequest(assertion, { cookie: "CF_Authorization=present" }), accessEnv(kv, users));
  assert.equal(session?.email, email);
  assert.ok(identityInit.signal instanceof AbortSignal);
  assert.deepEqual(timeouts, [30_000, 30_000]);
});

test("first Access login cannot overwrite a user disabled after its initial lookup", async context => {
  const keys = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const kid = "bootstrap-race-key";
  const jwk = { ...await crypto.subtle.exportKey("jwk", keys.publicKey), kid, kty: "RSA" };
  const assertion = await signedJwt(keys.privateKey, kid);
  context.mock.method(globalThis, "fetch", async () => Response.json({ keys: [jwk] }));
  const users = new Map();
  const disabled = { role: "user", tenantId: "managed", enabled: false, groups: ["manual"], contentRetentionDisabled: true };
  const env = accessEnv(new Map(), users);
  const stub = env.ACCESS_CONTROL.get();
  env.ACCESS_CONTROL.get = () => ({ async fetch(url, init) {
    const response = await stub.fetch(url, init);
    if (new URL(url).pathname === "/users/resolve") users.set(email, disabled);
    return response;
  } });
  assert.equal(await verifiedAccessSession(sessionRequest(assertion), env), null);
  assert.equal(users.get(email).enabled, false);
  assert.equal(users.get(email).tenantId, "managed");
  assert.deepEqual(users.get(email).groups, ["manual"]);
  assert.equal(users.get(email).contentRetentionDisabled, true);
});
