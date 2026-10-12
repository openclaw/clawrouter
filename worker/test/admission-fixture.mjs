import { createGrantAuthority } from "./grant-authority-fixture.mjs";
import { authorityCall } from "../authority.ts";
import { sha256Hex } from "../utils.ts";
const secret = 'synthetic-admission-secret';
export const admissionHeaders = { authorization: `Bearer clawrouter-live-fixture-${secret}`, 'content-type': 'application/json' };
export const admissionProvider = { id: 'anthropic', tokenRef: 'anthropic' };
export async function admissionFixture() {
  const records = new Map(), calls = [], pending = [];
  let beforeRead;
  const env = {
    ANTHROPIC_API_KEY: 'synthetic-environment',
    POLICY_KV: { async get(key, type) { const action = beforeRead; beforeRead = null; await action?.(key); const value = Array.isArray(key) ? new Map(key.map(k => [k, records.get(k) ?? null])) : records.get(key) ?? null; return type === "text" && value !== null ? JSON.stringify(value) : structuredClone(value); }, async put(key, value) { records.set(key, JSON.parse(value)); } },
    USAGE_QUEUE: { send: async () => {} },
  };
  const authority = createGrantAuthority(undefined, env);
  env.ACCESS_CONTROL = { idFromName: name => name, get: () => ({ fetch(url, init) { calls.push(new URL(url).pathname); return authority.fetch(url, init); } }) };
  const policy = { enabled: true, generation: 'v1', providers: ['anthropic'], models: ['anthropic/claude-sonnet-5'], tenantId: 'fixture', monthlyBudgetMicros: null, retainRequestContent: false };
  const credential = { enabled: true, secretSha256: await sha256Hex(secret), policyId: 'fixture', policyGeneration: 'v1', principalId: 'owner@example.com' };
  const call = (path, body) => authorityCall(env, path, body);
  await call('/policies/initialize-all', [{ policyId: 'fixture', policy }]);
  await call('/credentials/initialize-all', [{ credentialId: 'fixture', credential }]);
  await call('/users/initialize-all', [{ email: credential.principalId, record: { enabled: true } }]);
  await call('/connections/initialize-all', [{ providerId: admissionProvider.id, enabled: true }]);
  calls.length = 0;
  return { env, records, authority, calls, pending, policy, credential, call, beforeRead(action) { beforeRead = action; }, context: { waitUntil(promise) { pending.push(promise); } } };
}

