import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const ticket = {
  ticket: { id: "pst_ticket_fixture_1" },
  ticketToken: "ticket-secret-fixture",
  submissionUrl: "/v1/pool-submissions/pst_ticket_fixture_1/consume",
};
const accessEnv = { CF_ACCESS_CLIENT_ID: "access-id-fixture", CF_ACCESS_CLIENT_SECRET: "access-secret-fixture" };

async function fixture(t, respond = (_request, response) => {
  response.writeHead(201, { "content-type": "application/json" });
  response.end(JSON.stringify(ticket));
}) {
  const directory = mkdtempSync(join(tmpdir(), "clawrouter-pool-ticket-"));
  const output = join(directory, "ticket.json");
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({ method: request.method, url: request.url, headers: request.headers, body: Buffer.concat(chunks).toString("utf8") });
    respond(request, response);
  });
  t.after(() => {
    server.closeAllConnections();
    server.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const run = ({ env = {}, args = [], stdin } = {}) => new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [
      "scripts/pool-ticket.mjs", "--url", `${url}/`, "--out", output,
      "--scope", "policies", "--scope-id", "policy", "--token-ref", "provider-test", "--provider", "openai",
      ...(stdin === undefined ? ["--admin-token-env", "TEST_POOL_ADMIN"] : ["--admin-token-stdin"]), ...args,
    ], {
      cwd: process.cwd(), encoding: "utf8", timeout: 10_000,
      env: { TEST_POOL_ADMIN: "admin-secret-fixture", ...env },
    }, (error, stdout, stderr) => {
      if (error && typeof error.code !== "number") return reject(error);
      resolve({ status: error?.code ?? 0, stdout, stderr });
    });
    child.stdin.end(stdin);
  });
  return { output, requests, run, url };
}

function assertNoSecrets(result) {
  for (const secret of [ticket.ticketToken, "admin-secret-fixture", "access-secret-fixture"]) {
    assert.equal(`${result.stdout}${result.stderr}`.includes(secret), false);
  }
}

for (const access of [false, true]) {
  test(`pool ticket uses the admin transport ${access ? "with" : "without"} Access credentials`, async (t) => {
    const state = await fixture(t);
    const result = await state.run({
      env: { ...(access ? accessEnv : {}), CLAWROUTER_BASE_URL: "https://unused.invalid", CLAWROUTER_ADMIN_TOKEN: "unused-token" },
      args: ["--label", "Fixture pool", "--contributor", "maintainer@example.com", "--priority", "7", "--weight", "2", "--ttl-seconds", "600", "--no-keep-warm"],
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(state.requests.length, 1);
    const request = state.requests[0];
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/v1/admin/pool-submission-tickets");
    assert.equal(request.headers.authorization, "Bearer admin-secret-fixture");
    assert.equal(request.headers["cf-access-client-id"], access ? accessEnv.CF_ACCESS_CLIENT_ID : undefined);
    assert.equal(request.headers["cf-access-client-secret"], access ? accessEnv.CF_ACCESS_CLIENT_SECRET : undefined);
    assert.equal(request.headers.accept, "application/json");
    assert.deepEqual(JSON.parse(request.body), {
      scope: "policies", scopeId: "policy", tokenRef: "provider-test", provider: "openai", kind: "subscription",
      label: "Fixture pool", contributor: "maintainer@example.com", priority: 7, weight: 2, ttlSeconds: 600, keepWarm: false,
    });
    if (process.platform !== "win32") assert.equal(statSync(state.output).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(state.output, "utf8")), { version: 1, ...ticket, submissionUrl: `${state.url}${ticket.submissionUrl}` });
    assertNoSecrets(result);
  });
}

test("pool ticket preserves stdin admin tokens and exclusive output files", async (t) => {
  const state = await fixture(t);
  writeFileSync(state.output, "existing protected ticket", { mode: 0o600 });
  const result = await state.run({ stdin: "admin-secret-fixture\n", env: accessEnv });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /EEXIST/);
  assert.equal(state.requests[0].headers.authorization, "Bearer admin-secret-fixture");
  assert.equal(readFileSync(state.output, "utf8"), "existing protected ticket");
  assertNoSecrets(result);
});

test("pool ticket rejects literal admin secrets before dispatch", async (t) => {
  const state = await fixture(t);
  const result = await state.run({ args: ["--admin-token", "admin-secret-fixture"] });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /would expose the secret in process argv/);
  assert.equal(state.requests.length, 0);
  assert.equal(existsSync(state.output), false);
  assertNoSecrets(result);
});

for (const name of Object.keys(accessEnv)) {
  test(`pool ticket rejects an incomplete Access pair containing ${name} before dispatch`, async (t) => {
    const state = await fixture(t);
    const result = await state.run({ env: { [name]: accessEnv[name] } });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET must be configured together/);
    assert.equal(state.requests.length, 0);
    assert.equal(existsSync(state.output), false);
    assertNoSecrets(result);
  });
}

test("pool ticket refuses Access redirects without forwarding credentials or writing a ticket", async (t) => {
  const state = await fixture(t, (_request, response) => {
    response.writeHead(307, { location: "/login" });
    response.end(ticket.ticketToken);
  });
  const result = await state.run({ env: accessEnv });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /admin API redirected with 307; configure CF_ACCESS_CLIENT_ID/);
  assert.equal(state.requests.length, 1);
  assert.equal(existsSync(state.output), false);
  assertNoSecrets(result);
});

for (const scenario of [
  { name: "malformed JSON", status: 200, body: `invalid ${ticket.ticketToken}`, error: /admin API returned non-JSON 200/ },
  { name: "oversized JSON", status: 200, body: JSON.stringify({ ...ticket, padding: "x".repeat(128 * 1024) }), error: /admin API response was too large/ },
  { name: "structured failure", status: 400, body: JSON.stringify({ ...ticket, error: { message: "policy does not exist" } }), error: /failed \(400\): policy does not exist/ },
  { name: "unstructured failure", status: 403, body: JSON.stringify(ticket), error: /failed \(403\): request failed/ },
  { name: "invalid ticket", status: 201, body: JSON.stringify({ ticketToken: ticket.ticketToken }), error: /ticket issuance returned an invalid response/ },
]) {
  test(`pool ticket rejects ${scenario.name} without printing response secrets`, async (t) => {
    const state = await fixture(t, (_request, response) => {
      response.writeHead(scenario.status, { "content-type": "application/json" });
      response.end(scenario.body);
    });
    const result = await state.run({ env: accessEnv });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, scenario.error);
    assert.equal(state.requests.length, 1);
    assert.equal(existsSync(state.output), false);
    assertNoSecrets(result);
  });
}
