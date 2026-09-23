import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

const { PolicyBindingIndexObject } = await import("../authority.ts");
const { default: worker } = await import("../index.ts");

export const session = { authenticated: true, auth: "cloudflare_access", role: "user", email: "owner@example.com", subject: "owner", tenantId: "default", groups: ["maintainers"], contentRetentionDisabled: false };
export const policy = { enabled: true, generation: "policy_v1", providers: ["openai"], tenantId: "default", monthlyBudgetMicros: 100_000_000, requestCostMicros: 1_000, budgetScope: "principal", retainRequestContent: true, grantRouting: { strategy: "priority", stickiness: "identity", failover: true, staleState: "allow", staleAfterSeconds: 300, eligibleGrants: {} } };
export const digest = "ab".repeat(32);
export const adminActor = { auth: "admin_token", role: "admin", email: "token-admin" };
export const binding = { policyId: "maintainer_access", principalType: "group", principalId: "maintainers", enabled: true, priority: 10 };

export function credential(principalId = session.email) {
  return { enabled: true, secretSha256: digest, policyId: "maintainer_access", policyGeneration: policy.generation, principalId };
}

export async function fixture(t, entries = [], { held = true, legacy = false } = {}) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const sql = { exec(query, ...bindings) {
    const statement = db.prepare(query);
    if (statement.columns().length) return statement.all(...bindings);
    statement.run(...bindings);
    return [];
  } };
  const owner = new PolicyBindingIndexObject({ storage: { sql } });
  const store = new Map();
  const call = async (path, body) => {
    const response = await owner.fetch(new Request(`https://clawrouter.internal${path}`, { method: "POST", body: JSON.stringify(body) }));
    assert.equal(response.status, 200, await response.clone().text());
    return response.headers.get("content-type")?.includes("application/json") ? response.json() : response.text();
  };
  const state = {
    beforeMutation: null, store, call,
    credentials: {
      get(id) { const row = db.prepare("SELECT credential_json FROM proxy_credentials WHERE credential_id = ?").get(id); return row ? JSON.parse(row.credential_json) : undefined; },
      set(id, value) { db.prepare("INSERT OR REPLACE INTO proxy_credentials (credential_id, credential_json) VALUES (?, ?)").run(id, JSON.stringify(value)); },
      has(id) { return !!this.get(id); },
      get size() { return db.prepare("SELECT count(*) AS count FROM proxy_credentials").get().count; },
    },
    ACCESS_CONTROL: { idFromName: name => name, get: () => ({ fetch: async (url, init) => {
      if (new URL(url).pathname === "/credentials/mutate") {
        const action = state.beforeMutation;
        state.beforeMutation = null;
        await action?.(JSON.parse(init.body));
      }
      return owner.fetch(new Request(url, init));
    } }) },
    POLICY_KV: {
      async list({ prefix }) { return { list_complete: true, keys: [...store.keys()].filter(name => name.startsWith(prefix)).map(name => ({ name })) }; },
      async get(key) { return structuredClone(store.get(key) ?? null); },
      async put(key, value) { store.set(key, JSON.parse(value)); },
      async delete(key) { store.delete(key); },
    },
    CLAWROUTER_LOCAL_AUTH: "enabled",
    CLAWROUTER_ADMIN_TOKEN_SHA256: await sha256("fixture-admin-token"),
    async cookie(email = session.email) {
      const token = await sha256(email);
      store.set(`local/sessions/${await sha256(token)}`, { email, role: "admin", createdAt: new Date().toISOString(), expiresAtMs: Date.now() + 60_000 });
      return `clawrouter_session=${token}`;
    },
    async http(path, method = "GET", body, { auth = "admin", email = session.email, headers = {} } = {}) {
      const authHeaders = auth === "admin" ? { authorization: "Bearer fixture-admin-token" } : { cookie: await state.cookie(email) };
      return worker.fetch(new Request(`https://clawrouter.example${path}`, { method, headers: { ...authHeaders, origin: "https://clawrouter.example", "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), state, { waitUntil() {} });
    },
  };
  if (legacy) {
    for (const [id, value] of entries) store.set(`credentials/${id}`, value);
    store.set("policies/maintainer_access", policy);
    store.set(`access/users/${session.email}`, { enabled: true, role: "user", groups: session.groups });
    if (held) store.set("access/bindings/group/maintainers/maintainer_access", binding);
  } else {
    await call("/credentials/initialize-all", entries.map(([credentialId, credential]) => ({ credentialId, credential })));
    await call("/policies/initialize-all", [{ policyId: "maintainer_access", policy }]);
    await call("/users/initialize-all", [{ email: session.email, record: { enabled: true, role: "user", groups: session.groups } }]);
    await call("/initialize-all", held ? [binding] : []);
  }
  return state;
}

export async function sha256(value) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
