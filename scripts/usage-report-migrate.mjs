#!/usr/bin/env node
// Offline/internal metadata projection. No network clients, credentials, public mutation route or repricing.
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { migrateUsageReport } from "../worker/usage-report-store.ts";
export function migrateReportingDatabase(path, { apply = false, batchSize = 500, afterRowid, now } = {}) {
  const db = new DatabaseSync(path, { readOnly: !apply });
  const sql = { exec(query, ...bindings) { const s = db.prepare(query); if (s.columns().length) return s.all(...bindings); s.run(...bindings); return []; } };
  const transaction = fn => { db.exec("BEGIN IMMEDIATE"); try { fn(); db.exec("COMMIT"); } catch (error) { db.exec("ROLLBACK"); throw error; } };
  try { return migrateUsageReport(sql, transaction, { apply, batchSize, afterRowid, now }); } finally { db.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2), allowed = new Set(["--database", "--batch-size", "--after-rowid", "--apply"]);
  const options = {};
  for (let i = 0; i < args.length; i++) { const key = args[i]; if (!allowed.has(key)) throw new Error("unsupported argument: " + key); if (key === "--apply") options.apply = true; else { const value = args[++i]; if (!value || value.startsWith("--")) throw new Error("missing value for " + key); options[key.slice(2)] = value; } }
  if (!options.database) throw new Error("usage: node scripts/usage-report-migrate.mjs --database <offline-ledger.sqlite> [--batch-size 500] [--after-rowid N] [--apply]");
  if (options.apply && options["after-rowid"] !== undefined) throw new Error("--apply resumes its persisted watermark; do not supply --after-rowid");
  console.log(JSON.stringify(migrateReportingDatabase(options.database, { apply: options.apply === true, batchSize: Number(options["batch-size"] ?? 500), ...(options["after-rowid"] === undefined ? {} : { afterRowid: Number(options["after-rowid"]) }) })));
}
