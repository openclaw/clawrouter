import assert from "node:assert/strict";
import test from "node:test";
import { healthReport, summarizeInvocations } from "../scripts/cf-health-report.mjs";

const row = (hour, status, requests, version) => ({ sum: { requests }, dimensions: { datetimeHour: `2026-10-24T${hour}:00:00Z`, status, scriptVersion: version } });
const rows = [
  row("03", "success", 980, "aaaaaaaa-old"), row("03", "scriptThrewException", 20, "aaaaaaaa-old"),
  row("04", "success", 990, "bbbbbbbb-new"), row("04", "clientDisconnected", 10, "bbbbbbbb-new"),
  row("05", "success", 540, "bbbbbbbb-new"), row("05", "clientDisconnected", 460, "bbbbbbbb-new"),
];

test("summary orders hours, marks version changes and flags disconnect or failure spikes", () => {
  const summary = summarizeInvocations([...rows].reverse());
  assert.deepEqual(summary.map(entry => entry.hour.slice(11, 13)), ["03", "04", "05"]);
  assert.deepEqual(summary.map(entry => entry.versionChanged), [false, true, false]);
  assert.deepEqual(summary.map(entry => entry.flags), [["failures"], [], ["disconnects"]]);
  assert.equal(summary[2].disconnectShare, 0.46);
  assert.equal(summary[0].failureShare, 0.02);
});

test("report queries the account and script window and never prints the token", async () => {
  const logs = [];
  let request;
  const fetchImpl = async (url, init) => { request = { url, init, body: JSON.parse(init.body) }; return Response.json({ data: { viewer: { accounts: [{ workersInvocationsAdaptive: rows }] } } }); };
  const env = { CLOUDFLARE_ACCOUNT_ID: "91b59577e757131d68d55a471fe32aca", CLOUDFLARE_API_TOKEN: "synthetic-token" };
  const summary = await healthReport(["--hours", "3"], { env, fetchImpl, log: line => logs.push(line), now: Date.parse("2026-10-24T06:00:00Z") });
  assert.equal(summary.length, 3);
  assert.equal(request.init.headers.authorization, "Bearer synthetic-token");
  assert.deepEqual(request.body.variables, { account: env.CLOUDFLARE_ACCOUNT_ID, script: "clawrouter-edge", since: "2026-10-24T03:00:00.000Z", until: "2026-10-24T06:00:00.000Z" });
  assert.ok(logs.some(line => line.includes("<- version change")) && logs.some(line => line.includes("FLAG disconnects")));
  assert.ok(!logs.join("\n").includes("synthetic-token"));
  await assert.rejects(healthReport(["--hours", "0"], { env, fetchImpl }), /--hours/);
  await assert.rejects(healthReport([], { env: { CLOUDFLARE_API_TOKEN: "x" }, fetchImpl }), /CLOUDFLARE_ACCOUNT_ID/);
  await assert.rejects(healthReport([], { env, fetchImpl: async () => Response.json({ errors: [{ message: "not authorized" }] }) }), /not authorized/);
});
