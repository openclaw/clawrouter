import { sqliteFixture } from "./sqlite-storage.mjs";
import { after } from "node:test";
import { PolicyBindingIndexObject } from "../authority.ts";

export function createGrantAuthority(initialize, env) {
  const { sql, transactionSync } = sqliteFixture({ after });
  const storage = { sql, transactionSync };
  initialize?.(sql);
  const object = new PolicyBindingIndexObject({ storage }, env);
  return {
    sql, storage, object,
    fetch: (url, init) => object.fetch(new Request(url, init)),
    async call(path, body) {
      const response = await object.fetch(new Request(`https://clawrouter.internal/grant-pools/${path}`, { method: "POST", body: JSON.stringify(body) }));
      const result = await response.json();
      if (!response.ok) throw Object.assign(new Error(result.error.message), { status: response.status, code: result.error.code });
      return result;
    },
    seedLegacy(key, provider) {
      const parts = key.split("/"), tenant = parts.length === 4;
      sql.exec("INSERT INTO upstream_grant_pool_members (scope, scope_id, provider_id, token_ref) VALUES (?, ?, ?, ?)", tenant ? "tenants" : "policies", parts[tenant ? 2 : 1], provider, parts[tenant ? 3 : 2]);
    },
  };
}
