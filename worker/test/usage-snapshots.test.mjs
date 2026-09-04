import assert from "node:assert/strict";
import test from "node:test";
import { usageSnapshots } from "../ledgers.ts";
import { emptyUsageSnapshot } from "../usage-sharding.ts";

test("aggregation reads each tenant/policy shard once and never the retired global ledger", async () => {
  const calls = [];
  const env = { USAGE_LEDGER: {
    idFromName: name => name,
    get: name => ({ fetch: async url => {
      calls.push({ name, policy: new URL(url).searchParams.get("policy_id") });
      const snapshot = emptyUsageSnapshot();
      snapshot.summary.requestCount = 1;
      return Response.json(snapshot);
    } }),
  } };
  const summary = await usageSnapshots(env, [
    { tenantId: "one", policyId: "same" },
    { tenantId: "one", policyId: "same" },
    { tenantId: "two", policyId: "same" },
  ]);
  assert.deepEqual(calls, [
    { name: "policy:one:same", policy: "same" },
    { name: "policy:two:same", policy: "same" },
  ]);
  assert.equal(summary.summary.requestCount, 2);
  calls.length = 0;
  assert.deepEqual(await usageSnapshots(env, []), emptyUsageSnapshot());
  assert.deepEqual(calls, []);
});

test("a current shard failure fails the aggregate instead of returning partial totals", async () => {
  const env = { USAGE_LEDGER: {
    idFromName: name => name,
    get: () => ({ fetch: async () => new Response(null, { status: 503 }) }),
  } };
  await assert.rejects(usageSnapshots(env, [{ tenantId: "one", policyId: "policy" }]), /503/);
});
