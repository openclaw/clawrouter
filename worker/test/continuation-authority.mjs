import { DatabaseSync } from "node:sqlite";
import { PolicyBindingIndexObject } from "../authority.ts";

export function continuationAuthority(t) {
  const objects = new Map();
  const namespace = {
    objects, beforeFetch: null,
    idFromName: name => name,
    get(name) {
      if (!objects.has(name)) {
        const db = new DatabaseSync(":memory:");
        t.after(() => db.close());
        const fixture = { db, scheduled: null, beforeSchedule: null };
        const storage = {
          sql: { exec(query, ...bindings) {
            const statement = db.prepare(query);
            if (statement.columns().length) return statement.all(...bindings);
            statement.run(...bindings); return [];
          } },
          transactionSync(operation) {
            db.exec("BEGIN");
            try { const result = operation(); db.exec("COMMIT"); return result; }
            catch (error) { db.exec("ROLLBACK"); throw error; }
          },
          async setAlarm(value) { await fixture.beforeSchedule?.(); fixture.scheduled = value; },
          async getAlarm() { return fixture.scheduled; },
          async deleteAlarm() { fixture.scheduled = null; },
        };
        fixture.object = new PolicyBindingIndexObject({ storage });
        fixture.restart = () => { fixture.object = new PolicyBindingIndexObject({ storage }); };
        objects.set(name, fixture);
      }
      return { async fetch(url, init) {
        const request = new Request(url, init);
        await namespace.beforeFetch?.(name, request);
        return objects.get(name).object.fetch(request);
      } };
    },
  };
  return namespace;
}
