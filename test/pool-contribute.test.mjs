import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("pool contribution reads an op reference without putting its value in argv or stdout", async () => {
  const directory = mkdtempSync(join(tmpdir(), "clawrouter-pool-contribute-"));
  const ticketFile = join(directory, "ticket.json"), opBin = join(directory, "op"), argvFile = join(directory, "op-argv.json");
  let authorization, submitted;
  const server = createServer(async (request, response) => {
    authorization = request.headers.authorization;
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    submitted = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    response.writeHead(201, { "content-type": "application/json" });
    response.end(JSON.stringify({ outcome: "accepted", receipt: { grantKey: "oauth/policy/openai-test", submittedAt: "2026-09-02T18:00:00.000Z" } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/v1/pool-submissions/pst_test_ticket_123/consume`;
    writeFileSync(ticketFile, JSON.stringify({ version: 1, ticketToken: "ticket-fixture", submissionUrl: url }), { mode: 0o600 });
    writeFileSync(opBin, `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(process.env.ARGV_FILE, JSON.stringify(process.argv.slice(2))); process.stdout.write("credential-fixture");\n`, { mode: 0o700 });
    chmodSync(opBin, 0o700);
    const { stdout } = await execFileAsync(process.execPath, ["scripts/pool-contribute.mjs", "--ticket-file", ticketFile, "--access-token-ref", "op://Private/ClawRouter/access_token", "--op-bin", opBin, "--account-id", "account-fixture"], { cwd: process.cwd(), env: { ...process.env, ARGV_FILE: argvFile }, encoding: "utf8" });
    assert.equal(authorization, "Bearer ticket-fixture");
    assert.equal(submitted.accessToken, "credential-fixture");
    assert.deepEqual(JSON.parse(readFileSync(argvFile, "utf8")), ["read", "op://Private/ClawRouter/access_token"]);
    assert.equal(stdout.includes("credential-fixture"), false);
    assert.equal(stdout.includes("ticket-fixture"), false);
  } finally {
    server.closeAllConnections(); server.close(); rmSync(directory, { recursive: true, force: true });
  }
});

test("pool contribution rejects literal secrets and broadly readable tickets", () => {
  const directory = mkdtempSync(join(tmpdir(), "clawrouter-pool-contribute-"));
  const ticketFile = join(directory, "ticket.json");
  try {
    writeFileSync(ticketFile, JSON.stringify({ version: 1, ticketToken: "ticket-fixture", submissionUrl: "https://router.invalid/consume" }), { mode: 0o600 });
    const literal = spawnSync(process.execPath, ["scripts/pool-contribute.mjs", "--ticket-file", ticketFile, "--access-token", "credential-fixture"], { cwd: process.cwd(), encoding: "utf8" });
    assert.notEqual(literal.status, 0);
    assert.match(literal.stderr, /would expose the secret in process argv/);
    chmodSync(ticketFile, 0o644);
    const broad = spawnSync(process.execPath, ["scripts/pool-contribute.mjs", "--ticket-file", ticketFile, "--access-token-env", "TEST_POOL_ACCESS"], { cwd: process.cwd(), env: { ...process.env, TEST_POOL_ACCESS: "credential-fixture" }, encoding: "utf8" });
    assert.notEqual(broad.status, 0);
    assert.match(broad.stderr, /permissions are too broad/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("pool ticket writer keeps the one-time secret in a new mode-0600 file", async () => {
  const directory = mkdtempSync(join(tmpdir(), "clawrouter-pool-ticket-")), output = join(directory, "ticket.json");
  let authorization;
  const server = createServer(async (request, response) => {
    authorization = request.headers.authorization;
    response.writeHead(201, { "content-type": "application/json" });
    response.end(JSON.stringify({ ticket: { id: "pst_ticket_fixture_1" }, ticketToken: "ticket-fixture", submissionUrl: "https://router.example/v1/pool-submissions/pst_ticket_fixture_1/consume" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { stdout } = await execFileAsync(process.execPath, ["scripts/pool-ticket.mjs", "--url", `http://127.0.0.1:${server.address().port}`, "--out", output, "--scope", "policies", "--scope-id", "policy", "--token-ref", "openai-test", "--provider", "openai", "--admin-token-env", "TEST_POOL_ADMIN"], { cwd: process.cwd(), env: { ...process.env, TEST_POOL_ADMIN: "admin-fixture" }, encoding: "utf8" });
    assert.equal(authorization, "Bearer admin-fixture");
    assert.equal(statSync(output).mode & 0o777, 0o600);
    assert.equal(JSON.parse(readFileSync(output, "utf8")).ticketToken, "ticket-fixture");
    assert.equal(stdout.includes("ticket-fixture"), false);
    assert.equal(stdout.includes("admin-fixture"), false);
  } finally {
    server.closeAllConnections(); server.close(); rmSync(directory, { recursive: true, force: true });
  }
});
