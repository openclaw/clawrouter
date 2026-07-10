import assert from "node:assert/strict";
import test from "node:test";

import { deploymentTarget } from "../scripts/deployment-profile.mjs";
import {
  assertExactAccessApp,
  expectedAccessDestinations,
  teardownFakeco,
} from "../scripts/teardown-fakeco.mjs";

const executeEnv = {
  CLAWROUTER_DEPLOY_ENV: "fakeco",
  CLAWROUTER_DEPLOY_CONFIRM: "fakeco",
  CLAWROUTER_TEARDOWN_CONFIRM:
    "delete-clawrouter-edge-fakeco-and-durable-object-storage",
  CLAWROUTER_TEARDOWN_DATA_CONFIRM:
    "durable-object-storage-loss-is-irreversible",
  CLOUDFLARE_API_TOKEN: "cf-token",
  CLOUDFLARE_ACCOUNT_ID: "fixture-account",
  CLAWROUTER_POLICY_KV_ID: "fixture-kv",
};

test("FakeCo teardown defaults to a non-mutating retained-resource plan", async () => {
  const logs = [];
  const result = await teardownFakeco({
    env: { CLAWROUTER_DEPLOY_ENV: "fakeco" },
    fetchImpl: async () => {
      throw new Error("unexpected fetch");
    },
    log: (line) => logs.push(line),
  });
  assert.equal(result.executed, false);
  const output = logs.join("\n");
  assert.match(output, /dry-run plan \(no Cloudflare mutations\)/);
  assert.match(
    output,
    /delete Worker and its associated Durable Object storage: clawrouter-edge-fakeco/,
  );
  assert.match(output, /retain KV namespace: clawrouter-policy-fakeco/);
  assert.match(
    output,
    /CLAWROUTER_TEARDOWN_CONFIRM=delete-clawrouter-edge-fakeco-and-durable-object-storage/,
  );
  assert.match(
    output,
    /CLAWROUTER_TEARDOWN_DATA_CONFIRM=durable-object-storage-loss-is-irreversible/,
  );
  assert.doesNotMatch(output, /retain Durable Object storage/);
  assert.doesNotMatch(output, /clawrouter-edge$/m);
});

test("FakeCo teardown execution requires its target lock and both destructive confirmations", async () => {
  await assert.rejects(
    teardownFakeco({
      env: { ...executeEnv, CLAWROUTER_DEPLOY_CONFIRM: "" },
      execute: true,
      log: () => {},
    }),
    /CLAWROUTER_DEPLOY_CONFIRM=fakeco/,
  );
  await assert.rejects(
    teardownFakeco({
      env: { ...executeEnv, CLAWROUTER_TEARDOWN_CONFIRM: "" },
      execute: true,
      log: () => {},
    }),
    /CLAWROUTER_TEARDOWN_CONFIRM=delete-clawrouter-edge-fakeco-and-durable-object-storage/,
  );
  await assert.rejects(
    teardownFakeco({
      env: { ...executeEnv, CLAWROUTER_TEARDOWN_DATA_CONFIRM: "" },
      execute: true,
      log: () => {},
    }),
    /CLAWROUTER_TEARDOWN_DATA_CONFIRM=durable-object-storage-loss-is-irreversible/,
  );
  await assert.rejects(
    teardownFakeco({
      env: { CLAWROUTER_DEPLOY_ENV: "production" },
      execute: true,
      log: () => {},
    }),
    /CLAWROUTER_DEPLOY_ENV must be fakeco/,
  );
});

test("FakeCo teardown verifies KV and exact Access app before exact forced Worker deletion", async () => {
  const target = deploymentTarget(executeEnv);
  const events = [];
  const logs = [];
  const result = await teardownFakeco({
    env: executeEnv,
    execute: true,
    fetchImpl: async (url, init) => {
      assert.equal(init.headers.Authorization, "Bearer cf-token");
      if (url.endsWith("/storage/kv/namespaces/fixture-kv")) {
        events.push("kv-verify");
        return Response.json({
          success: true,
          result: { id: "fixture-kv", title: "clawrouter-policy-fakeco" },
        });
      }
      if (url.endsWith("/access/apps?per_page=100&page=1")) {
        events.push("access-read-1");
        assert.equal(init.method, "GET");
        return Response.json({
          success: true,
          result_info: { page: 1, total_pages: 2 },
          result: [{ id: "other-app", name: "Other app", destinations: [] }],
        });
      }
      if (url.endsWith("/access/apps?per_page=100&page=2")) {
        events.push("access-read-2");
        assert.equal(init.method, "GET");
        return Response.json({
          success: true,
          result_info: { page: 2, total_pages: 2 },
          result: [
            {
              id: "fakeco-access-app",
              name: "ClawRouter FakeCo Console",
              destinations: expectedAccessDestinations(target).map((uri) => ({ uri })),
            },
          ],
        });
      }
      if (url.endsWith("/workers/services/clawrouter-edge-fakeco?force=true")) {
        events.push("worker-delete");
        assert.equal(init.method, "DELETE");
        return Response.json({ success: true, result: null });
      }
      if (url.endsWith("/queues?per_page=100&page=1")) {
        events.push("queue-read");
        assert.equal(init.method, "GET");
        return Response.json({
          success: true,
          result_info: { page: 1, total_pages: 1 },
          result: [
            { queue_id: "usage-id", queue_name: "clawrouter-usage-fakeco" },
            {
              queue_id: "dlq-id",
              queue_name: "clawrouter-usage-fakeco-dead-letter",
            },
          ],
        });
      }
      if (url.endsWith("/queues/usage-id")) {
        events.push("queue-delete-usage");
        assert.equal(init.method, "DELETE");
        return Response.json({ success: true });
      }
      if (url.endsWith("/queues/dlq-id")) {
        events.push("queue-delete-dlq");
        assert.equal(init.method, "DELETE");
        return Response.json({ success: true });
      }
      if (url.endsWith("/access/apps/fakeco-access-app")) {
        events.push("access-delete");
        assert.equal(init.method, "DELETE");
        return Response.json({ success: true, result: { id: "fakeco-access-app" } });
      }
      throw new Error(`unexpected fetch ${url}`);
    },
    log: (line) => logs.push(line),
  });

  assert.equal(result.executed, true);
  assert.deepEqual(events.slice(0, 4), [
    "kv-verify",
    "access-read-1",
    "access-read-2",
    "queue-read",
  ]);
  assert.ok(events.indexOf("worker-delete") < events.indexOf("queue-delete-usage"));
  assert.ok(events.indexOf("queue-delete-dlq") < events.indexOf("access-delete"));
  assert.equal(events.at(-1), "access-delete");
  assert.match(logs.join("\n"), /deleted queue clawrouter-usage-fakeco/);
});

test("FakeCo teardown treats only an exact missing queue as absent", async () => {
  const logs = [];
  const target = deploymentTarget(executeEnv);
  await teardownFakeco({
    env: executeEnv,
    execute: true,
    fetchImpl: async (url) => {
      if (url.endsWith("/storage/kv/namespaces/fixture-kv")) {
        return Response.json({
          success: true,
          result: { id: "fixture-kv", title: "clawrouter-policy-fakeco" },
        });
      }
      if (url.includes("/access/apps?")) {
        return Response.json({ success: true, result: [], result_info: { total_pages: 1 } });
      }
      if (url.includes("/queues?")) {
        return Response.json({
          success: true,
          result: [{ queue_id: "usage-id", queue_name: target.queueName }],
          result_info: { total_pages: 1 },
        });
      }
      if (url.includes("/workers/services/")) {
        return Response.json({ success: true });
      }
      if (url.endsWith("/queues/usage-id")) {
        return Response.json({ success: true });
      }
      throw new Error(`unexpected fetch ${url}`);
    },
    log: (line) => logs.push(line),
  });
  assert.match(logs.join("\n"), /queue clawrouter-usage-fakeco-dead-letter already absent/);
});

test("FakeCo teardown refuses an Access app with foreign destinations", () => {
  const target = deploymentTarget(executeEnv);
  assert.throws(
    () =>
      assertExactAccessApp(target, {
        id: "wrong-app",
        name: target.accessAppName,
        destinations: [{ uri: "clawrouter.openclaw.ai/v1/admin/*" }],
      }),
    /destinations did not exactly match/,
  );
});
