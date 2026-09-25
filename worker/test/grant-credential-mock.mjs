import { GrantCredentialObject } from "../grant-credentials.ts";
import { createGrantAuthority } from "./grant-authority-fixture.mjs";

export function attachGrantCredentialNamespace(env, { useExistingAuthority = false } = {}) {
  const objects = new Map();
  if (!useExistingAuthority) {
    const fallback = env.ACCESS_CONTROL;
    env.grantAuthority = createGrantAuthority();
    env.ACCESS_CONTROL = { idFromName: (name) => name, get: (id) => ({ fetch: (url, init) => {
      const path = new URL(url).pathname;
      return !fallback || path.startsWith("/grant-pools/readiness") || ["attachment", "admit", "publish", "cancel-pending", "pending"].some((name) => path === `/grant-pools/${name}`)
        ? env.grantAuthority.fetch(url, init) : fallback.get(id).fetch(url, init);
    } }) };
  }
  env.GRANT_CREDENTIALS = {
    objects,
    idFromName(name) { return name; },
    get(id) {
      if (!objects.has(id)) {
        const values = new Map();
        let alarm = null;
        const state = {
          storage: {
            async get(key) { return structuredClone(values.get(key)); },
            async put(key, value) { values.set(key, structuredClone(value)); },
            async delete(key) { return values.delete(key); },
            async setAlarm(value) { alarm = Number(value); },
            async getAlarm() { return alarm; },
            async deleteAlarm() { alarm = null; },
          },
        };
        objects.set(id, { values, state, object: new GrantCredentialObject(state, env), alarm: () => alarm });
      }
      return { fetch: (url, init) => objects.get(id).object.fetch(new Request(url, init)) };
    },
  };
  return env;
}

export function rateLimitKv(env) {
  const put = env.POLICY_KV.put;
  let now = 0, lastWrite = -Infinity, writes = 0;
  env.POLICY_KV.put = async (...args) => {
    if (now - lastWrite < 1_000) throw new Error("KV PUT failed: 429 Too Many Requests");
    await put(...args);
    lastWrite = now; writes += 1;
  };
  return { advance() { now += 1_000; }, writes: () => writes };
}
