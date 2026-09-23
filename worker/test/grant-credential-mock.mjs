import { GrantCredentialObject } from "../grant-credentials.ts";

export function attachGrantCredentialNamespace(env) {
  const objects = new Map();
  env.ACCESS_CONTROL ??= { idFromName: (name) => name, get: () => ({ fetch: async (url) => {
    if (new URL(url).pathname === "/grant-pools/sync") return new Response("updated");
    throw new Error("unexpected authority call");
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
