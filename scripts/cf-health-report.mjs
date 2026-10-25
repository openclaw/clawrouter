#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const help = `Usage: pnpm cf:health-report -- [--hours 24] [--script clawrouter-edge] [--json]

Hourly Worker invocation outcomes per deployed version from Cloudflare's
workersInvocationsAdaptive dataset: client disconnects, script exceptions,
CPU/memory limits and load shedding. Marks version changes and flags hours whose
disconnect or failure share crosses the thresholds, so a client-side abort storm
can be told apart from a deploy regression.

Requires CLOUDFLARE_ACCOUNT_ID and an API token with Account Analytics Read
(CLOUDFLARE_API_TOKEN, or the local \`wrangler auth token\` when unset).`;

export const DISCONNECT_FLAG = 0.1;
export const FAILURE_FLAG = 0.01;
const FAILURE_STATUSES = new Set(["scriptThrewException", "exceededCpu", "exceededMemory", "exceededResources", "internalError", "loadShed"]);

export function summarizeInvocations(rows) {
  const hours = new Map();
  for (const row of rows) {
    const hour = row.dimensions.datetimeHour;
    const entry = hours.get(hour) ?? { hour, total: 0, statuses: {}, versions: new Set() };
    entry.total += row.sum.requests;
    entry.statuses[row.dimensions.status] = (entry.statuses[row.dimensions.status] ?? 0) + row.sum.requests;
    if (row.dimensions.scriptVersion) entry.versions.add(row.dimensions.scriptVersion);
    hours.set(hour, entry);
  }
  let previous = "";
  return [...hours.values()].sort((a, b) => a.hour.localeCompare(b.hour)).map(entry => {
    const disconnected = entry.statuses.clientDisconnected ?? 0;
    const failed = Object.entries(entry.statuses).filter(([status]) => FAILURE_STATUSES.has(status)).reduce((sum, [, count]) => sum + count, 0);
    const versions = [...entry.versions].sort();
    const key = versions.join(",");
    const versionChanged = previous !== "" && key !== previous;
    previous = key;
    const disconnectShare = entry.total ? disconnected / entry.total : 0, failureShare = entry.total ? failed / entry.total : 0;
    const flags = [...(disconnectShare > DISCONNECT_FLAG ? ["disconnects"] : []), ...(failureShare > FAILURE_FLAG ? ["failures"] : [])];
    return { hour: entry.hour, total: entry.total, statuses: entry.statuses, versions, versionChanged, disconnectShare, failureShare, flags };
  });
}

function apiToken(env) {
  if (env.CLOUDFLARE_API_TOKEN?.trim()) return env.CLOUDFLARE_API_TOKEN.trim();
  const result = spawnSync("npx", ["wrangler", "auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const token = result.status === 0 ? result.stdout.trim().split("\n").filter(Boolean).at(-1) : undefined;
  if (!token || /\s/.test(token)) throw new Error("set CLOUDFLARE_API_TOKEN or log in with wrangler");
  return token;
}

export async function healthReport(argv, { env = process.env, fetchImpl = fetch, log = console.log, now = Date.now() } = {}) {
  const { values } = parseArgs({ args: argv.filter(value => value !== "--"), options: { hours: { type: "string", default: "24" }, script: { type: "string", default: "clawrouter-edge" }, json: { type: "boolean" }, help: { type: "boolean" } }, strict: true });
  if (values.help) { log(help); return []; }
  const hours = Number(values.hours);
  if (!Number.isInteger(hours) || hours < 1 || hours > 168) throw new Error("--hours must be an integer from 1 to 168");
  if (!/^[a-z0-9-]{1,63}$/.test(values.script)) throw new Error("invalid --script");
  const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim();
  if (!accountId || !/^[0-9a-f]{32}$/.test(accountId)) throw new Error("CLOUDFLARE_ACCOUNT_ID is required");
  const query = `query($account: String!, $script: String!, $since: Time!, $until: Time!) { viewer { accounts(filter: { accountTag: $account }) {
    workersInvocationsAdaptive(limit: 10000, filter: { scriptName: $script, datetime_geq: $since, datetime_leq: $until }) { sum { requests } dimensions { datetimeHour status scriptVersion } } } } }`;
  const response = await fetchImpl("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST", headers: { authorization: `Bearer ${apiToken(env)}`, "content-type": "application/json" },
    body: JSON.stringify({ query, variables: { account: accountId, script: values.script, since: new Date(now - hours * 3_600_000).toISOString(), until: new Date(now).toISOString() } }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body || body.errors?.length) throw new Error(`analytics query failed (${response.status}): ${body?.errors?.map(error => error.message).join("; ") ?? "invalid response"}`);
  const summary = summarizeInvocations(body.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive ?? []);
  if (values.json) { log(JSON.stringify(summary, null, 2)); return summary; }
  for (const row of summary) {
    const pct = share => `${(share * 100).toFixed(1)}%`;
    log(`${row.hour.slice(0, 13)}Z ${String(row.total).padStart(7)} req  disconnect ${pct(row.disconnectShare).padStart(6)}  failure ${pct(row.failureShare).padStart(6)}  ${row.versions.map(id => id.slice(0, 8)).join(",")}${row.versionChanged ? "  <- version change" : ""}${row.flags.length ? `  FLAG ${row.flags.join(",")}` : ""}`);
  }
  return summary;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  healthReport(process.argv.slice(2)).catch(error => { console.error(`Health report failed: ${error.message}`); process.exitCode = 1; });
}
