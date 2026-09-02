import { GrantCredentialObject } from "../grant-credentials.ts";

export function attachGrantCredentialNamespace(env) {
  const objects = new Map();
  env.GRANT_CREDENTIALS = {
    objects,
    idFromName(name) { return name; },
    get(id) {
      if (!objects.has(id)) {
        const values = new Map();
        const state = {
          storage: {
            async get(key) { return structuredClone(values.get(key)); },
            async put(key, value) { values.set(key, structuredClone(value)); },
            async delete(key) { return values.delete(key); },
          },
        };
        objects.set(id, { values, object: new GrantCredentialObject(state, env) });
      }
      return { fetch: (url, init) => objects.get(id).object.fetch(new Request(url, init)) };
    },
  };
  return env;
}
