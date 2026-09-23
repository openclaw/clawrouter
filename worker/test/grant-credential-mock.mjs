import { GrantCredentialObject } from "../grant-credentials.ts";
import { createGrantAuthority } from "./grant-authority-fixture.mjs";

export function attachGrantCredentialNamespace(env) {
  const objects = new Map();
  const fallback = env.ACCESS_CONTROL;
  env.grantAuthority = createGrantAuthority();
  env.ACCESS_CONTROL = { idFromName: (name) => name, get: (id) => ({ fetch: (url, init) => {
    const path = new URL(url).pathname;
    return !fallback || ["attachment", "admit", "publish", "cancel-pending", "pending"].some((name) => path === `/grant-pools/${name}`)
      ? env.grantAuthority.fetch(url, init) : fallback.get(id).fetch(url, init);
  } }) };
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
