import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { extname } from "node:path";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && context.parentURL && !extname(new URL(specifier, context.parentURL).pathname)) return nextResolve(`${specifier}.ts`, context);
    return nextResolve(specifier, context);
  },
});

const { authorizeAdmin, verifiedAccessSession } = await import("../access.ts");
const { localAuthEnabled, localLogin, localLogout, localSession } = await import("../local-auth.ts");

const adminKeyMaterial = "self-host-console-key";
const adminKeyMaterialSha256 = createHash("sha256").update(adminKeyMaterial).digest("hex");
const origin = "http://localhost:8787";

function fixture(overrides = {}) {
  const kv = new Map();
  const users = new Map();
  return {
    kv,
    users,
    POLICY_KV: {
      get: async (key, type) => {
        const value = kv.get(key);
        return value === undefined ? null : type === "json" ? JSON.parse(value) : value;
      },
      put: async (key, value) => { kv.set(key, value); },
      delete: async (key) => { kv.delete(key); },
      list: async () => ({ keys: [], list_complete: true }),
    },
    ACCESS_CONTROL: {
      idFromName: (name) => name,
      get: () => ({
        fetch: async (url, init) => {
          const path = new URL(url).pathname;
          const body = init?.body ? JSON.parse(init.body) : {};
          if (path === "/users/resolve") {
            const found = body.emails.filter((email) => users.has(email)).map((email) => ({ email, record: users.get(email) }));
            return Response.json({ initialized: true, users: found, missingEmails: body.emails.filter((email) => !users.has(email)) });
          }
          if (path === "/users/put") { users.set(body.email, body.record); return new Response("updated"); }
          if (path === "/users/create") {
            if (!users.has(body.email)) users.set(body.email, body.record);
            return Response.json({ email: body.email, record: users.get(body.email) });
          }
          return Response.json({ error: { code: "route_not_found" } }, { status: 404 });
        },
      }),
    },
    CLAWROUTER_LOCAL_AUTH: "enabled",
    CLAWROUTER_ADMIN_TOKEN_SHA256: adminKeyMaterialSha256,
    ...overrides,
  };
}

function loginRequest(token, { ip, base = origin, from } = {}) {
  return new Request(`${base}/v1/session/login`, {
    method: "POST",
    body: JSON.stringify({ token }),
    headers: { origin: from ?? new URL(base).origin, "content-type": "application/json", ...(ip ? { "cf-connecting-ip": ip } : {}) },
  });
}

function cookieFrom(response) {
  const header = response.headers.get("set-cookie");
  assert.ok(header, "expected a set-cookie header");
  return header.split(";")[0];
}

test("local login is refused when local auth is disabled or Access is configured", async () => {
  const disabled = fixture({ CLAWROUTER_LOCAL_AUTH: undefined });
  assert.equal(localAuthEnabled(disabled), false);
  assert.equal((await localLogin(loginRequest(adminKeyMaterial, { ip: "198.51.100.1" }), disabled)).status, 404);

  const managed = fixture({ CLAWROUTER_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com", CLAWROUTER_ACCESS_AUD: "aud" });
  assert.equal(localAuthEnabled(managed), false);
  assert.equal((await localLogin(loginRequest(adminKeyMaterial, { ip: "198.51.100.2" }), managed)).status, 404);
});

test("local login rejects cross-origin requests and wrong tokens", async () => {
  const env = fixture();
  const csrf = await localLogin(loginRequest(adminKeyMaterial, { ip: "198.51.100.3", from: "https://evil.example" }), env);
  assert.equal(csrf.status, 403);
  assert.equal((await csrf.json()).error.code, "access_csrf_required");

  const wrong = await localLogin(loginRequest("not-the-token", { ip: "198.51.100.4" }), env);
  assert.equal(wrong.status, 401);
  assert.equal((await wrong.json()).error.code, "login_invalid");
  assert.equal(env.kv.size, 0);
});

test("local login rejects a malicious origin even when a trusted public origin is configured", async () => {
  const env = fixture({ CLAWROUTER_PUBLIC_ORIGIN: "https://console.example.com" });
  const request = loginRequest(adminKeyMaterial, { ip: "198.51.100.13", from: "https://evil.example" });
  request.headers.set("x-forwarded-proto", "https");
  request.headers.set("x-forwarded-host", "console.example.com");
  const response = await localLogin(request, env);
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, "access_csrf_required");
});

test("local login mints a session cookie that authenticates as an admin", async () => {
  const env = fixture();
  const response = await localLogin(loginRequest(adminKeyMaterial, { ip: "198.51.100.5" }), env);
  assert.equal(response.status, 200);
  const setCookie = response.headers.get("set-cookie");
  assert.match(setCookie, /^clawrouter_session=[a-f0-9]{64}; Max-Age=43200; Path=\/; HttpOnly; SameSite=Lax$/);
  assert.doesNotMatch(setCookie, /Secure/);
  const body = await response.json();
  assert.equal(body.session.auth, "local");
  assert.equal(body.session.role, "admin");
  assert.equal(body.session.email, "admin@local");
  assert.equal(env.users.get("admin@local").role, "admin");

  const authed = new Request(`${origin}/v1/session`, { headers: { cookie: cookieFrom(response) } });
  const session = await verifiedAccessSession(authed, env);
  assert.equal(session?.auth, "local");
  assert.equal(session?.role, "admin");
  assert.equal(session?.email, "admin@local");

  const admin = await authorizeAdmin(new Request(`${origin}/v1/admin/overview`, { headers: { cookie: cookieFrom(response) } }), env);
  assert.ok(!(admin instanceof Response));
  assert.equal(admin.role, "admin");
});

test("local login marks the cookie Secure on https origins and honors the configured admin email", async () => {
  const env = fixture({ CLAWROUTER_LOCAL_ADMIN_EMAIL: "ops@example.com" });
  const response = await localLogin(loginRequest(adminKeyMaterial, { ip: "198.51.100.6", base: "https://router.example" }), env);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("set-cookie"), /; Secure$/);
  assert.equal((await response.json()).session.email, "ops@example.com");
});

test("client-supplied forwarded headers do not mark a bare workerd cookie Secure", async () => {
  const env = fixture();
  const request = loginRequest(adminKeyMaterial, { ip: "198.51.100.14" });
  request.headers.set("x-forwarded-proto", "https");
  request.headers.set("x-forwarded-host", "console.example.com");
  const response = await localLogin(request, env);
  assert.equal(response.status, 200);
  assert.doesNotMatch(response.headers.get("set-cookie"), /; Secure/);
});

test("local login and logout work behind a declared TLS-terminating proxy", async () => {
  const publicOrigin = "https://console.example.com";
  const env = fixture({ CLAWROUTER_PUBLIC_ORIGIN: publicOrigin });
  const request = loginRequest(adminKeyMaterial, { ip: "198.51.100.12", from: publicOrigin });
  request.headers.set("x-forwarded-proto", "https");
  request.headers.set("x-forwarded-host", "console.example.com");
  const response = await localLogin(request, env);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("set-cookie"), /; Secure$/);

  const cookie = cookieFrom(response);
  assert.ok(await localSession(new Request(`${origin}/v1/session`, { headers: { cookie } }), env));
  const logoutRequest = new Request(`${origin}/v1/session/logout`, {
    method: "POST",
    headers: { cookie, origin: publicOrigin, "x-forwarded-host": "console.example.com", "x-forwarded-proto": "https" },
  });
  const logout = await localLogout(logoutRequest, env);
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get("set-cookie"), /; Secure$/);
  assert.equal(await localSession(new Request(`${origin}/v1/session`, { headers: { cookie } }), env), null);
});

test("local sessions respect disabled, deleted, or demoted user records and expiry", async () => {
  const env = fixture();
  const response = await localLogin(loginRequest(adminKeyMaterial, { ip: "198.51.100.7" }), env);
  const request = new Request(`${origin}/v1/session`, { headers: { cookie: cookieFrom(response) } });
  assert.ok(await localSession(request, env));

  const provisioned = env.users.get("admin@local");
  env.users.set("admin@local", { ...provisioned, enabled: false });
  assert.equal(await localSession(request, env), null);

  env.users.delete("admin@local");
  assert.equal(await localSession(request, env), null);

  env.users.set("admin@local", { ...provisioned, role: "user" });
  assert.equal((await localSession(request, env))?.role, "user");
  env.users.set("admin@local", provisioned);

  const [key, value] = [...env.kv.entries()][0];
  env.kv.set(key, JSON.stringify({ ...JSON.parse(value), expiresAtMs: Date.now() - 1 }));
  assert.equal(await localSession(request, env), null);
});

test("local logout revokes the stored session and clears the cookie", async () => {
  const env = fixture();
  const login = await localLogin(loginRequest(adminKeyMaterial, { ip: "198.51.100.8" }), env);
  const cookie = cookieFrom(login);
  const logout = await localLogout(new Request(`${origin}/v1/session/logout`, { method: "POST", headers: { origin, cookie } }), env);
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get("set-cookie"), /^clawrouter_session=; Max-Age=0/);
  assert.equal(env.kv.size, 0);
  assert.equal(await verifiedAccessSession(new Request(`${origin}/v1/session`, { headers: { cookie } }), env), null);
});

test("repeated sign-in failures from one client are rate limited", async () => {
  const env = fixture();
  const ip = "203.0.113.9";
  for (let attempt = 0; attempt < 10; attempt += 1) {
    assert.equal((await localLogin(loginRequest("wrong", { ip }), env)).status, 401);
  }
  const throttled = await localLogin(loginRequest(adminKeyMaterial, { ip }), env);
  assert.equal(throttled.status, 429);
  assert.equal((await throttled.json()).error.code, "login_rate_limited");

  const other = await localLogin(loginRequest(adminKeyMaterial, { ip: "203.0.113.10" }), env);
  assert.equal(other.status, 200);
});

test("session cookies are ignored outside local-auth mode", async () => {
  const env = fixture();
  const login = await localLogin(loginRequest(adminKeyMaterial, { ip: "198.51.100.11" }), env);
  const cookie = cookieFrom(login);
  const managed = { ...env, CLAWROUTER_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com", CLAWROUTER_ACCESS_AUD: "aud" };
  assert.equal(await localSession(new Request(`${origin}/v1/session`, { headers: { cookie } }), managed), null);
  const unset = { ...env, CLAWROUTER_LOCAL_AUTH: undefined };
  assert.equal(await verifiedAccessSession(new Request(`${origin}/v1/session`, { headers: { cookie } }), unset), null);
});

test("first local login cannot overwrite a user disabled after its initial lookup", async () => {
  const env = fixture({ CLAWROUTER_LOCAL_ADMIN_EMAIL: "bootstrap@example.com" });
  const disabled = { role: "user", tenantId: "managed", enabled: false, groups: ["manual"], contentRetentionDisabled: true };
  const stub = env.ACCESS_CONTROL.get();
  env.ACCESS_CONTROL.get = () => ({ async fetch(url, init) {
    const response = await stub.fetch(url, init);
    if (new URL(url).pathname === "/users/resolve") env.users.set("bootstrap@example.com", disabled);
    return response;
  } });
  const response = await localLogin(loginRequest(adminKeyMaterial, { ip: "198.51.100.240" }), env);
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("set-cookie"), null);
  assert.deepEqual(env.users.get("bootstrap@example.com"), disabled);
  assert.equal(env.kv.size, 0);
});

test("concurrent spoofed-client attempts cannot exceed the global sign-in cap", async () => {
  const realNow = Date.now;
  Date.now = () => realNow() + 120_000;
  try {
    const env = fixture();
    const responses = await Promise.all(Array.from({ length: 100 }, (_, attempt) =>
      localLogin(loginRequest("wrong", { ip: `192.0.2.${attempt + 1}` }), env)));
    const statuses = responses.map((response) => response.status);
    assert.equal(statuses.filter((status) => status === 401).length, 50);
    assert.equal(statuses.filter((status) => status === 429).length, 50);
    const fresh = await localLogin(loginRequest(adminKeyMaterial, { ip: "192.0.2.200" }), env);
    assert.equal(fresh.status, 429);
  } finally {
    Date.now = realNow;
  }
});
