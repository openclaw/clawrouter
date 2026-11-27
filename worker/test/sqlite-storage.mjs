import { DatabaseSync } from "node:sqlite";

export function sqliteFixture(t, path = ":memory:") {
  const db = new DatabaseSync(path);
  t.after(() => db.close());
  return { db, ...sqliteStorage(db) };
}

export function sqliteStorage(db) {
  return {
    sql: { exec(query, ...bindings) {
      const statement = db.prepare(query);
      if (statement.columns().length) return statement.all(...bindings);
      statement.run(...bindings);
      return [];
    } },
    transactionSync(operation) {
      db.exec("BEGIN");
      try { const result = operation(); db.exec("COMMIT"); return result; }
      catch (error) { db.exec("ROLLBACK"); throw error; }
    },
  };
}
