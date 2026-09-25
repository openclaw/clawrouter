import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startWorkerdFixture } from "../../test/helpers/workerd.mjs";

test("workerd ingest client validates stored, duplicate and retention-expired producer receipts", { timeout: 60_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-usage-ingest-"));
  let worker;
  try {
    worker = await startWorkerdFixture(temporary, `
      export * from "./worker/index.ts";
      import { ingestUsage, usageStub } from "./worker/ledgers.ts";
      export default { async fetch(request, env) {
        if (new URL(request.url).pathname === "/producer-ingest") return usageStub(env, "tenant", "").fetch(new Request("https://ledger/ingest", request));
        if (request.method === "POST") {
          const target = new URL(request.url).pathname === "/unconfirmed"
            ? { ...env, USAGE_LEDGER: { idFromName: name => name, get: () => ({ fetch: async () => new Response("accepted") }) } }
            : env;
          try { return Response.json(await ingestUsage(target, await request.json())); }
          catch { return Response.json({ error: "unconfirmed usage ingestion" }, { status: 503 }); }
        }
        return usageStub(env, "tenant", "").fetch(request);
      } };
    `, 'export default { fetch() { throw new Error("unexpected upstream request"); } };');
    const ingest = body => worker.dispatchFetch("https://router.example/ingest", { method: "POST", body: JSON.stringify(body) });
    const original = { id: "runtime-event", type: "clawrouter.usage.v1", occurred_at_ms: Date.now(), tenant_id: "tenant", policy_id: "", key_id: "legacy-policy", provider: "openai", status: "success", status_code: 200, input_tokens: 3, output_tokens: 2, total_tokens: 5, actual_cost_micros: 7 };
    const stored = await ingest(original);
    assert.equal(stored.status, 200);
    assert.match(stored.headers.get("content-type"), /^application\/json/);
    assert.deepEqual(await stored.json(), { eventId: original.id, outcome: "stored" });
    const duplicate = await ingest({ ...original, occurred_at_ms: 0, actual_cost_micros: 999 });
    assert.equal(duplicate.status, 200);
    assert.deepEqual(await duplicate.json(), { eventId: original.id, outcome: "duplicate" });
    const expired = await ingest({ ...original, id: "expired", occurred_at_ms: Date.now() - 31 * 86_400_000 });
    assert.equal(expired.status, 200);
    assert.deepEqual(await expired.json(), { eventId: "expired", outcome: "expired_by_retention" });
    const invalid = await ingest({ ...original, id: "invalid", occurred_at_ms: undefined });
    assert.equal(invalid.status, 503);
    assert.deepEqual(await invalid.json(), { error: "unconfirmed usage ingestion" });
    const invalidProducer = await worker.dispatchFetch("https://router.example/producer-ingest", { method: "POST", body: JSON.stringify({ ...original, id: "invalid", occurred_at_ms: undefined }) });
    assert.equal(invalidProducer.status, 400);
    assert.equal((await invalidProducer.json()).error.code, "invalid_usage_event");
    const unconfirmed = await worker.dispatchFetch("https://router.example/unconfirmed", { method: "POST", body: JSON.stringify({ ...original, id: "unconfirmed" }) });
    assert.equal(unconfirmed.status, 503);
    assert.deepEqual(await unconfirmed.json(), { error: "unconfirmed usage ingestion" });
    const snapshotResponse = await worker.dispatchFetch("https://router.example/snapshot?events=admin");
    assert.equal(snapshotResponse.status, 200);
    const snapshot = await snapshotResponse.json();
    assert.equal(snapshot.summary.requestCount, 1);
    assert.equal(snapshot.summary.actualCostMicros, 7);
    assert.deepEqual(snapshot.events, [{ ...original, policy_id: "legacy-policy" }]);
  } finally {
    await worker?.dispose();
    await rm(temporary, { recursive: true, force: true });
  }
});
