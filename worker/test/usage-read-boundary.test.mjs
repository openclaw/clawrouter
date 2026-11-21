import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import "../../scripts/typescript-resolver.mjs";

test("the reporting service loads without ledger implementations or SQL owners", async () => {
  const forbidden = /\/worker\/(?:ledgers|usage-report-store|usage-report-visibility|usage-rollups)\.ts(?:\?|$)/;
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      const result = nextResolve(specifier, context);
      assert.doesNotMatch(result.url, forbidden, "report service imported a storage implementation");
      return result;
    },
  });
  try {
    const service = await import("../usage-report.ts");
    assert.equal(typeof service.personalUsage, "function");
    assert.equal(typeof service.readCompleteUsage, "function");
  } finally {
    hooks.deregister();
  }
});

test("the read client preserves scoped URLs, results and grant failures", async () => {
  const { usageSnapshot, grantUsageSnapshot } = await import("../usage-ledger-client.ts");
  const { HttpError } = await import("../utils.ts");
  const { emptyUsageSnapshot } = await import("../usage-sharding.ts");
  const calls = [];
  let response = () => Response.json(emptyUsageSnapshot());
  const env = { USAGE_LEDGER: {
    idFromName: name => name,
    get: name => ({ fetch: async url => {
      calls.push([name, new URL(url).pathname, [...new URL(url).searchParams]]);
      return response();
    } }),
  } };
  for (const scope of [{ kind: "admin" }, { kind: "principal", id: "owner@example.test" }, { kind: "credential", id: "key-a" }]) {
    assert.deepEqual(await usageSnapshot(env, "tenant", "policy", scope, 7), emptyUsageSnapshot());
    assert.deepEqual(calls.at(-1), ["policy:tenant:policy", "/snapshot", [
      ["policy_id", "policy"], ["limit", "7"], ["events", scope.kind],
      ...(scope.kind === "admin" ? [] : [["event_owner", scope.id]]),
    ]]);
  }
  const grant = { grants: [], historyComplete: true };
  response = () => Response.json(grant);
  assert.deepEqual(await grantUsageSnapshot(env, "tenant", "policy", 3), grant);
  assert.deepEqual(calls.at(-1), ["policy:tenant:policy", "/grant-usage", [["policy_id", "policy"], ["days", "3"]]]);
  for (const status of [422, 503]) {
    response = () => new Response(null, { status });
    await assert.rejects(grantUsageSnapshot(env, "tenant", "policy", 3), error => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.status, status);
      assert.equal(error.code, "grant_usage_unavailable");
      assert.equal(error.message, status === 422 ? "choose a shorter usage range" : "grant usage is unavailable");
      return true;
    });
  }
});
