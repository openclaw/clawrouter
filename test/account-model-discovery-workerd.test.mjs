import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startWorkerdFixture } from "./helpers/workerd.mjs";

const accountPath = "/v1/admin/upstream-grants/policies/discovery/acct_12345678-1234-4123-8123-123456789abc";
const inventoryPath = `${accountPath}/models`;
const routerScript = 'export { default } from "./worker/index.ts"; export * from "./worker/index.ts";';
const upstreamScript = `
  let mode = "complete", calls = [], partialBodies = 0, completedBodies = 0;
  export default { async fetch(request) {
    const url = new URL(request.url);
    if (url.origin === "https://fixture.example") {
      if (url.pathname === "/state" && request.method === "GET") return Response.json({ calls, partialBodies, completedBodies });
      if (url.pathname === "/mode" && request.method === "POST") {
        const next = await request.json();
        if (!["complete", "reduced", "rejected", "partial", "redirect"].includes(next)) throw new Error("invalid fixture mode");
        mode = next;
        return new Response(null, { status: 204 });
      }
    }
    calls.push({ url: request.url, method: request.method, authorized: request.headers.get("authorization") === "Bearer synthetic-discovery-key" });
    if (request.url !== "https://api.openai.com/v1/models" || request.method !== "GET" || !calls.at(-1).authorized) return new Response("unexpected fixture request", { status: 500 });
    if (mode === "rejected") return new Response("synthetic-provider-error-do-not-return", { status: 403 });
    if (mode === "redirect") return new Response("synthetic-redirect-error-do-not-return", { status: 302, headers: { location: "https://redirect.example/not-a-model-list" } });
    if (mode === "partial") {
      let timer;
      const body = new ReadableStream({
        start(controller) {
          partialBodies++;
          controller.enqueue(new TextEncoder().encode('{"object":"list","data":['));
          // Keep the body open after its first bytes. The router's 10s
          // deadline must finish before this fixture would close the body.
          timer = setTimeout(() => { completedBodies++; controller.enqueue(new TextEncoder().encode(']}')); controller.close(); }, 20_000);
        },
        cancel() { clearTimeout(timer); },
      });
      return new Response(body, { headers: { "content-type": "application/json" } });
    }
    const ids = mode === "reduced" ? ["kept"] : ["removed", "kept"];
    return Response.json({ object: "list", data: ids.map(id => ({ id, object: "model", created: 1_700_000_000, owned_by: "fixture" })) });
  } };
`;

const start = temporary => startWorkerdFixture(temporary, routerScript, upstreamScript, { activate: false, persistencePath: join(temporary, "resources") });

async function request(mf, method, path = inventoryPath, body) {
  // This is only a failing client guard. It cannot complete discovery or
  // replace the unmodified 10s deadline inside the actual Worker.
  const response = await fetch(new URL(path, await mf.ready), {
    method, headers: { authorization: "Bearer fixture-activation-admin", "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000),
  });
  assert.equal(response.headers.get("cache-control"), "no-store");
  const result = await response.json();
  assert.doesNotMatch(JSON.stringify(result), /synthetic-discovery-key|synthetic-provider-error|synthetic-redirect-error|redirect\.example/);
  return { status: response.status, body: result };
}

async function createAccount(mf) {
  const created = await request(mf, "POST", accountPath, { provider: "openai", kind: "api_key", credential: "synthetic-discovery-key", enabled: true });
  assert.equal(created.status, 201);
  assert.equal(created.body.outcome, "committed");
  assert.equal(created.body.grant.credentialGeneration, 1);
  const empty = await request(mf, "GET");
  assert.equal(empty.status, 200);
  assert.equal(empty.body.attempt, null);
  assert.equal(empty.body.snapshot, null);
}

async function upstream(mf, mode) {
  const worker = await mf.getWorker("upstream");
  if (mode !== undefined) assert.equal((await worker.fetch("https://fixture.example/mode", { method: "POST", body: JSON.stringify(mode) })).status, 204);
  return (await worker.fetch("https://fixture.example/state")).json();
}

const refresh = mf => request(mf, "POST", inventoryPath, { expectedCredentialGeneration: 1 });
const expectedCall = { url: "https://api.openai.com/v1/models", method: "GET", authorized: true };

test("account discovery retains the last complete snapshot and failed attempt through an actual workerd restart", { timeout: 30_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-model-restart-"));
  let mf;
  try {
    mf = await start(temporary);
    await createAccount(mf);
    assert.deepEqual((await upstream(mf)).calls, []);
    const first = await refresh(mf);
    assert.equal(first.status, 200);
    assert.equal(first.body.stale, false);
    assert.equal(first.body.sourceMatches, true);
    assert.deepEqual(first.body.snapshot.models.map(model => model.id), ["kept", "removed"]);
    assert.equal(first.body.snapshot.providerId, "openai");
    assert.equal(first.body.snapshot.adapter, "openai.models");
    assert.equal(first.body.snapshot.credentialGeneration, 1);
    assert.equal(first.body.snapshot.snapshotGeneration, 1);
    assert.equal(first.body.snapshot.attemptGeneration, 1);
    assert.ok(Number.isFinite(Date.parse(first.body.snapshot.observedAt)));
    await upstream(mf, "rejected");
    const failed = await refresh(mf);
    assert.equal(failed.status, 502);
    assert.equal(failed.body.attempt.error, "upstream_rejected");
    assert.equal(failed.body.attempt.attemptGeneration, 2);
    assert.equal(failed.body.attempt.status, "failed");
    assert.ok(Number.isFinite(Date.parse(failed.body.attempt.completedAt)));
    assert.equal(failed.body.stale, true);
    assert.deepEqual(failed.body.snapshot, first.body.snapshot);
    assert.deepEqual((await upstream(mf)).calls, [expectedCall, expectedCall]);
    await mf.dispose();
    mf = undefined;
    mf = await start(temporary);
    const restored = await request(mf, "GET");
    assert.equal(restored.status, 200);
    assert.deepEqual(restored.body, failed.body, "attempt, snapshot, source identity and timestamps persist without replay");
    assert.deepEqual((await upstream(mf)).calls, [], "restart and inspection make no upstream request");
    await upstream(mf, "reduced");
    const next = await refresh(mf);
    assert.equal(next.status, 200);
    assert.equal(next.body.attempt.attemptGeneration, 3);
    assert.equal(next.body.snapshot.snapshotGeneration, 2);
    assert.equal(next.body.snapshot.attemptGeneration, 3);
    assert.deepEqual(next.body.snapshot.models.map(model => model.id), ["kept"]);
    assert.deepEqual(next.body.snapshot.removedIds, ["removed"]);
    assert.equal(next.body.stale, false);
    assert.deepEqual((await upstream(mf)).calls, [expectedCall]);
  } finally {
    await mf?.dispose();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("the native discovery deadline aborts a body read after headers and retains the prior snapshot", { timeout: 30_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-model-deadline-"));
  let mf;
  try {
    mf = await start(temporary);
    await createAccount(mf);
    const first = await refresh(mf);
    assert.equal(first.status, 200);
    await upstream(mf, "partial");
    const started = Date.now();
    const failed = await refresh(mf);
    assert.equal(failed.status, 502);
    assert.ok(Date.now() - started >= 9_000, "the real 10s product deadline ran, not an immediate fixture failure");
    assert.equal(failed.body.attempt.status, "failed");
    assert.equal(failed.body.attempt.error, "timeout");
    assert.equal(failed.body.attempt.attemptGeneration, 2);
    assert.equal(failed.body.stale, true);
    assert.deepEqual(failed.body.snapshot, first.body.snapshot);
    const state = await upstream(mf);
    assert.deepEqual(state.calls, [expectedCall, expectedCall]);
    assert.equal(state.partialBodies, 1);
    assert.equal(state.completedBodies, 0, "the fixture did not finish the response for the router");
    assert.deepEqual((await request(mf, "GET")).body, failed.body);
  } finally {
    await mf?.dispose();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("native model-list fetch refuses redirects without forwarding the account credential", { timeout: 30_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-model-redirect-"));
  let mf;
  try {
    mf = await start(temporary);
    await createAccount(mf);
    const first = await refresh(mf);
    assert.equal(first.status, 200);
    await upstream(mf, "redirect");
    const failed = await refresh(mf);
    assert.equal(failed.status, 502);
    assert.equal(failed.body.attempt.status, "failed");
    assert.equal(failed.body.attempt.error, "transport_error");
    assert.equal(failed.body.stale, true);
    assert.deepEqual(failed.body.snapshot, first.body.snapshot);
    assert.deepEqual((await upstream(mf)).calls, [expectedCall, expectedCall], "the redirect destination is never requested");
    assert.deepEqual((await request(mf, "GET")).body, failed.body);
  } finally {
    await mf?.dispose();
    await rm(temporary, { recursive: true, force: true });
  }
});
