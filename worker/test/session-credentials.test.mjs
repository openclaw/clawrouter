import assert from "node:assert/strict";
import { extname } from "node:path";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && context.parentURL && !extname(new URL(specifier, context.parentURL).pathname)) return nextResolve(`${specifier}.ts`, context);
    return nextResolve(specifier, context);
  },
});

const { budgetPrincipal } = await import("../budget-scope.ts");
const { authenticateProxyKey } = await import("../proxy.ts");
const { sessionCredentialsRequest } = await import("../session-credentials.ts");

const session = { authenticated: true, auth: "cloudflare_access", role: "user", email: "owner@example.com", subject: "owner", tenantId: "default", groups: ["maintainers"], contentRetentionDisabled: false };
const policy = { enabled: true, generation: "policy_v1", providers: ["openai"], tenantId: "default", monthlyBudgetMicros: 100_000_000, requestCostMicros: 1_000, budgetScope: "principal", retainRequestContent: true, grantRouting: { strategy: "priority", stickiness: "identity", failover: true, staleState: "allow", staleAfterSeconds: 300, eligibleGrants: {} } };
const digest = "ab".repeat(32);

test("session issuance forces ownership and authenticates with the session principal budget scope", async () => {
  const env = fixture();
  const response = await put(env, "self_key", { policyId: "maintainer_access", secretSha256: digest, principalId: "victim@example.com", enabled: false });
  assert.equal(response.status, 200);
  assert.equal(env.credentials.get("self_key").principalId, session.email);
  assert.equal(env.credentials.get("self_key").enabled, true);
  assert.equal(env.credentials.get("self_key").policyGeneration, policy.generation);

  const keyMaterial = "12345678";
  env.credentials.get("self_key").secretSha256 = await sha256(keyMaterial);
  const auth = await authenticateProxyKey(new Headers({ authorization: `Bearer clawrouter-live-self_key-${keyMaterial}` }), env);
  assert.ok(!(auth instanceof Response));
  assert.equal(auth.principalId, session.email);
  assert.equal(budgetPrincipal(auth), session.email);
});

test("session issuance rejects foreign credential ids", async () => {
  const env = fixture([["self_key", credential("elsewhere@example.com")]]);
  const response = await put(env, "self_key", { policyId: "maintainer_access", secretSha256: digest });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, "credential_owned_elsewhere");
  assert.equal(env.credentials.get("self_key").principalId, "elsewhere@example.com");
});

test("session issuance rejects policies outside the effective session bindings", async () => {
  const env = fixture();
  const response = await put(env, "self_key", { policyId: "other_policy", secretSha256: digest });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, "credential_policy_not_held");
});

test("session issuance caps enabled principal credentials while allowing rotation", async () => {
  const entries = Array.from({ length: 10 }, (_, index) => [`key_${index}`, credential(session.email)]);
  const env = fixture(entries);
  const blocked = await put(env, "key_new", { policyId: "maintainer_access", secretSha256: digest });
  assert.equal(blocked.status, 409);
  assert.equal((await blocked.json()).error.code, "credential_limit_reached");

  const rotated = await put(env, "key_0", { policyId: "maintainer_access", secretSha256: "cd".repeat(32) });
  assert.equal(rotated.status, 200);
  assert.equal(env.credentials.get("key_0").secretSha256, "cd".repeat(32));
});

test("session issuance bounds retained revoked records without reducing the enabled limit", async () => {
  const entries = [
    ["live_key", credential(session.email)],
    ...Array.from({ length: 99 }, (_, index) => [`old_${String(index).padStart(3, "0")}`, { ...credential(session.email), enabled: false }]),
  ];
  const env = fixture(entries);
  const response = await put(env, "key_new", { policyId: "maintainer_access", secretSha256: digest });
  assert.equal(response.status, 200);
  assert.equal(env.credentials.size, 100);
  assert.equal(env.credentials.has("old_000"), false);
  assert.equal(env.credentials.has("key_new"), true);
});

test("session revocation applies only to owned credentials", async () => {
  const env = fixture([
    ["own_key", credential(session.email)],
    ["other_key", credential("elsewhere@example.com")],
  ]);
  const own = await sessionCredentialsRequest(new Request("https://clawrouter.example/v1/session/credentials/own_key/revoke", { method: "POST" }), env, "/v1/session/credentials/own_key/revoke", session);
  assert.equal(own.status, 200);
  assert.equal(env.credentials.get("own_key").enabled, false);

  const foreign = await sessionCredentialsRequest(new Request("https://clawrouter.example/v1/session/credentials/other_key/revoke", { method: "POST" }), env, "/v1/session/credentials/other_key/revoke", session);
  assert.equal(foreign.status, 403);
  assert.equal((await foreign.json()).error.code, "credential_owned_elsewhere");
  assert.equal(env.credentials.get("other_key").enabled, true);
});

test("session credential list returns only the caller's public credential shape", async () => {
  const env = fixture([
    ["own_key", credential(session.email)],
    ["other_key", credential("elsewhere@example.com")],
  ]);
  const response = await sessionCredentialsRequest(new Request("https://clawrouter.example/v1/session/credentials"), env, "/v1/session/credentials", session);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { credentials: [{ credentialId: "own_key", policyId: "maintainer_access", enabled: true, active: true }] });
});

test("session credential activity uses the canonical policy after a binding is removed", async () => {
  const env = fixture([["own_key", credential(session.email)]], { held: false });
  const response = await sessionCredentialsRequest(new Request("https://clawrouter.example/v1/session/credentials"), env, "/v1/session/credentials", session);
  assert.deepEqual(await response.json(), { credentials: [{ credentialId: "own_key", policyId: "maintainer_access", enabled: true, active: true }] });
});

test("the revoke subresource rejects PUT without rotating the credential", async () => {
  const original = credential(session.email), env = fixture([["own_key", original]]);
  const response = await sessionCredentialsRequest(new Request("https://clawrouter.example/v1/session/credentials/own_key/revoke", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ policyId: "maintainer_access", secretSha256: "cd".repeat(32) }) }), env, "/v1/session/credentials/own_key/revoke", session);
  assert.equal(response.status, 405);
  assert.deepEqual(env.credentials.get("own_key"), original);
});

function put(env, id, body) {
  return sessionCredentialsRequest(new Request(`https://clawrouter.example/v1/session/credentials/${id}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), env, `/v1/session/credentials/${id}`, session);
}

function credential(principalId) {
  return { enabled: true, secretSha256: digest, policyId: "maintainer_access", policyGeneration: policy.generation, principalId };
}

function fixture(entries = [], { held = true } = {}) {
  const credentials = new Map(entries);
  const fetch = async (url, init) => {
    const path = new URL(url).pathname;
    if (path === "/resolve") return Response.json({ bindings: held ? [{ policyId: "maintainer_access", principalType: "group", principalId: "maintainers", enabled: true, priority: 10 }] : [], missingPrincipals: [] });
    if (path === "/policies/resolve") {
      const { policyIds } = JSON.parse(init.body);
      return Response.json({ initialized: true, policies: policyIds.includes("maintainer_access") ? [{ policyId: "maintainer_access", policy }] : [], missingPolicyIds: [] });
    }
    if (path === "/policies/list") return Response.json({ initialized: true, policies: [{ policyId: "maintainer_access", policy }] });
    if (path === "/credentials/list") return Response.json({ initialized: true, credentials: [...credentials].map(([credentialId, value]) => ({ credentialId, credential: value })) });
    if (path === "/credentials/resolve") {
      const { credentialIds } = JSON.parse(init.body);
      return Response.json({ initialized: true, credentials: credentialIds.filter((id) => credentials.has(id)).map((credentialId) => ({ credentialId, credential: credentials.get(credentialId) })), missingCredentialIds: credentialIds.filter((id) => !credentials.has(id)) });
    }
    if (path === "/users/resolve") return Response.json({ initialized: true, users: [], missingEmails: [] });
    if (path === "/credentials/put") {
      const entry = JSON.parse(init.body), existing = credentials.get(entry.credentialId);
      if (entry.guard.requireExisting && !existing) return Response.json({ outcome: "missing" });
      if (existing && existing.principalId !== entry.guard.principalId) return Response.json({ outcome: "owned_elsewhere" });
      const enabled = [...credentials].filter(([id, value]) => id !== entry.credentialId && value.enabled && value.principalId === entry.guard.principalId).length;
      if (entry.credential.enabled && enabled >= entry.guard.maxEnabled) return Response.json({ outcome: "limit_reached" });
      const owned = [...credentials].filter(([id, value]) => id !== entry.credentialId && value.principalId === entry.guard.principalId);
      if (!existing && owned.length >= entry.guard.maxTotal) {
        const pruneCount = owned.length - entry.guard.maxTotal + 1;
        const revoked = owned.filter(([, value]) => !value.enabled).sort(([left], [right]) => left.localeCompare(right));
        for (const [id] of revoked.slice(0, pruneCount)) credentials.delete(id);
      }
      credentials.set(entry.credentialId, entry.credential);
      return Response.json({ outcome: "updated" });
    }
    throw new Error(`unexpected authority path ${path}`);
  };
  return { credentials, ACCESS_CONTROL: { idFromName: (name) => name, get: () => ({ fetch }) }, POLICY_KV: { get: async () => null } };
}

async function sha256(value) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
