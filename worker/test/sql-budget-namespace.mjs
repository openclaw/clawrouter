import { DatabaseSync } from "node:sqlite";
import { BudgetLedgerObject } from "../ledgers.ts";

export function sqlBudgetNamespace(t) {
  const objects = new Map();
  return {
    idFromName: (name) => name,
    get(name) {
      if (!objects.has(name)) {
        const db = new DatabaseSync(":memory:");
        t.after(() => db.close());
        const sql = { exec(query, ...bindings) {
          const statement = db.prepare(query);
          if (statement.columns().length) return statement.all(...bindings);
          statement.run(...bindings);
          return [];
        } };
        const ledger = new BudgetLedgerObject({ storage: { sql, getAlarm: async () => 1 } });
        objects.set(name, { fetch: (url, init) => ledger.fetch(new Request(url, init)), reservations: () => db.prepare("SELECT * FROM budget_reservations").all() });
      }
      return objects.get(name);
    },
  };
}
