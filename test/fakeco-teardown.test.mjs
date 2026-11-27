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

function fixture() {
  const target = deploymentTarget(executeEnv);
  const consumer = {
    consumer_id: "consumer-id", type: "worker", script: target.workerName,
    dead_letter_queue: target.queueDlqName,
    settings: { batch_size: 50, max_retries: 5 },
  };
  const usage = {
    queue_id: "usage-id", queue_name: target.queueName,
    producers: [{ type: "worker", script: target.workerName }],
    consumers: [consumer],
  };
  const dlq = {
    queue_id: "dlq-id", queue_name: target.queueDlqName,
    producers: [], consumers: [],
  };
  const state = {
    usage, dlq, events: [], logs: [], overrides: new Map(),
    queues: [usage, dlq],
    metrics: {
      "usage-id": { backlog_count: 0, backlog_bytes: 0 },
      "dlq-id": { backlog_count: 0, backlog_bytes: 0 },
    },
    directConsumer: { ...consumer, queue_id: usage.queue_id, queue_name: usage.queue_name,
      created_on: "2026-01-01T00:00:00.000Z" },
    detached: false, keepConsumer: false, workerAbsent: false,
  };
  state.run = () => teardownFakeco({
    env: executeEnv, execute: true, log: (line) => state.logs.push(line),
    fetchImpl: async (url, init) => {
      assert.equal(init.headers.Authorization, "Bearer cf-token");
      const path = new URL(url).pathname.replace("/client/v4/accounts/fixture-account", "") +
        new URL(url).search;
      const event = `${init.method ?? "GET"} ${path}`;
      state.events.push(event);
      if (state.overrides.has(event)) return state.overrides.get(event)(state);
      const ok = (result, extra = {}) => Response.json({ success: true, result, ...extra });
      const absent = () => Response.json({ success: false }, { status: 404 });
      if (path === "/storage/kv/namespaces/fixture-kv") {
        return ok({ id: "fixture-kv", title: "clawrouter-policy-fakeco" });
      }
      if (path === "/access/apps?per_page=100&page=1") {
        return ok([{ id: "other-app", name: "Other app", destinations: [] }],
          { result_info: { page: 1, total_pages: 2 } });
      }
      if (path === "/access/apps?per_page=100&page=2") {
        return ok([{ id: "fakeco-access-app", name: target.accessAppName,
          destinations: expectedAccessDestinations(target).map((uri) => ({ uri })) }],
        { result_info: { page: 2, total_pages: 2 } });
      }
      if (path === "/queues?per_page=100&page=1") {
        // Inventory summaries need not contain full dependency metadata.
        return ok(state.queues.map(({ queue_id, queue_name }) => ({ queue_id, queue_name })),
          { result_info: { total_pages: 1 } });
      }
      if (path === "/queues/usage-id/consumers/consumer-id") {
        if (init.method === "DELETE") {
          state.detached = true;
          if (!state.keepConsumer) state.usage.consumers = [];
          return ok(undefined);
        }
        return state.detached ? absent() : ok(state.directConsumer);
      }
      for (const queue of state.queues) {
        if (path === `/queues/${queue.queue_id}/metrics`) {
          return ok(state.metrics[queue.queue_id]);
        }
        if (path === `/queues/${queue.queue_id}`) {
          if (init.method === "GET") return ok(queue);
          assert.equal(init.method, "DELETE");
          return ok(undefined);
        }
      }
      if (event === "DELETE /workers/services/clawrouter-edge-fakeco?force=true") {
        if (state.workerAbsent) return absent();
        state.usage.producers = [];
        return ok(null);
      }
      if (event === "DELETE /access/apps/fakeco-access-app") {
        return Response.json({ success: true }, { status: 202 });
      }
      throw new Error(`unexpected fetch ${event}`);
    },
  });
  return state;
}

function deletions(state) {
  return state.events.filter((event) => event.startsWith("DELETE "));
}

test("FakeCo teardown preflights both queues, verifies disconnection, then deletes Worker, queues and Access", async () => {
  const state = fixture();
  assert.equal((await state.run()).executed, true);
  assert.deepEqual(deletions(state), [
    "DELETE /queues/usage-id/consumers/consumer-id",
    "DELETE /workers/services/clawrouter-edge-fakeco?force=true",
    "DELETE /queues/usage-id", "DELETE /queues/dlq-id",
    "DELETE /access/apps/fakeco-access-app",
  ]);
  const disconnect = state.events.indexOf(deletions(state)[0]);
  assert.deepEqual(state.events.slice(0, 4), [
    "GET /storage/kv/namespaces/fixture-kv",
    "GET /access/apps?per_page=100&page=1", "GET /access/apps?per_page=100&page=2",
    "GET /queues?per_page=100&page=1",
  ]);
  assert.ok(state.events.indexOf("GET /queues/dlq-id/metrics") < disconnect);
  assert.ok(state.events.indexOf("GET /queues/usage-id/consumers/consumer-id") < disconnect);
  assert.deepEqual(state.events.slice(disconnect + 1, disconnect + 6), [
    "GET /queues/usage-id/consumers/consumer-id",
    "GET /queues/usage-id", "GET /queues/usage-id/metrics",
    "GET /queues/dlq-id", "GET /queues/dlq-id/metrics",
  ]);
  const worker = state.events.indexOf(deletions(state)[1]);
  assert.deepEqual(state.events.slice(worker + 1, worker + 4), [
    "GET /queues/usage-id", "GET /queues/usage-id/metrics", "DELETE /queues/usage-id",
  ]);
  assert.equal(state.events.at(-1), "DELETE /access/apps/fakeco-access-app");
  assert.match(state.logs.join("\n"), /disconnected verified FakeCo consumer/);
  assert.doesNotMatch(state.logs.join("\n"), /dry-run|no Cloudflare mutations/);
});

for (const field of ["script", "script_name"]) {
  test(`FakeCo teardown accepts the exact owned consumer via ${field}`, async () => {
    const state = fixture();
    for (const c of [state.usage.consumers[0], state.directConsumer]) {
      c[field] = c.script;
      if (field === "script_name") delete c.script;
    }
    await state.run();
    assert.equal(deletions(state).length, 5);
  });
}

const preflightCases = [
  ["nonempty usage queue", (s) => { s.metrics["usage-id"].backlog_count = 1; }, /not verified empty/],
  ["nonempty DLQ", (s) => { s.metrics["dlq-id"].backlog_bytes = 1; }, /not verified empty/],
  ["unknown backlog", (s) => { delete s.metrics["dlq-id"].backlog_count; }, /not verified empty/],
  ["string backlog", (s) => { s.metrics["usage-id"].backlog_count = "0"; }, /not verified empty/],
  ["foreign producer", (s) => { s.dlq.producers = [{ type: "worker", script: "production" }]; }, /foreign or ambiguous/],
  ["foreign consumer", (s) => { s.usage.consumers[0].script = "production"; }, /exact owned/],
  ["conflicting script fields", (s) => { s.usage.consumers[0].script_name = "production"; }, /exact owned/],
  ["pull consumer", (s) => { s.usage.consumers[0].type = "http_pull"; }, /exact owned/],
  ["foreign DLQ", (s) => { s.usage.consumers[0].dead_letter_queue = "production-dlq"; }, /exact owned/],
  ["missing consumer ID", (s) => { delete s.usage.consumers[0].consumer_id; }, /exact owned/],
  ["multiple consumers", (s) => { s.usage.consumers.push({ ...s.usage.consumers[0] }); }, /unexpected queue dependencies/],
  ["unexpected DLQ consumer", (s) => { s.dlq.consumers = [{ ...s.usage.consumers[0] }]; }, /unexpected queue dependencies/],
  ["missing consumer inventory", (s) => { delete s.dlq.consumers; }, /malformed queue consumers/],
  ["missing producer inventory", (s) => { delete s.dlq.producers; }, /malformed queue producers/],
  ["truncated consumers", (s) => { s.usage.consumers_total_count = 2; }, /incomplete queue consumers/],
  ["truncated producers", (s) => { s.usage.producers_total_count = 2; }, /incomplete queue producers/],
  ["changed direct consumer", (s) => { s.directConsumer.script = "production"; }, /exact owned/],
  ["changed direct ID", (s) => { s.directConsumer.consumer_id = "other-id"; }, /identity changed/],
  ["changed direct queue", (s) => { s.directConsumer.queue_id = "other-id"; }, /exact owned/],
  ["ambiguous queue name", (s) => { s.queues.push({ ...s.dlq }); }, /queue identity was ambiguous/],
];
for (const [name, change, error] of preflightCases) {
  test(`FakeCo teardown refuses ${name} before any mutation`, async () => {
    const state = fixture();
    change(state);
    await assert.rejects(state.run(), error);
    assert.deepEqual(deletions(state), []);
  });
}

test("FakeCo teardown rejects mismatched queue details before mutation", async () => {
  const state = fixture();
  state.overrides.set("GET /queues/dlq-id", () => Response.json({
    success: true, result: { ...state.dlq, queue_name: "production" },
  }));
  await assert.rejects(state.run(), /queue detail identity/);
  assert.deepEqual(deletions(state), []);
});

for (const response of [
  () => Response.json({ success: false }, { status: 403 }),
  () => Response.json({ success: true, result: null }),
  () => Response.json({ result: [] }),
  () => new Response("not json", { status: 200 }),
]) {
  test("FakeCo teardown refuses unavailable or malformed queue inventories", async () => {
    const state = fixture();
    state.overrides.set("GET /queues?per_page=100&page=1", response);
    await assert.rejects(state.run(), /Cloudflare GET|malformed queue inventory/);
    assert.deepEqual(deletions(state), []);
  });
}

for (const failedPath of [
  "/queues/usage-id/consumers/consumer-id",
  "/workers/services/clawrouter-edge-fakeco?force=true",
  "/queues/usage-id", "/queues/dlq-id",
]) {
  test(`FakeCo teardown preserves Access and stops after failure at ${failedPath}`, async () => {
    const state = fixture();
    state.overrides.set(`DELETE ${failedPath}`, () => Response.json({
      success: false, errors: [{ code: 10064, message: "fixture refusal" }],
    }, { status: 403 }));
    await assert.rejects(state.run(), /fixture refusal/);
    assert.equal(state.events.at(-1), `DELETE ${failedPath}`);
    assert.ok(!deletions(state).some((event) => event.includes("/access/apps/")));
    assert.equal(deletions(state).filter((event) => event === `DELETE ${failedPath}`).length, 1);
  });
}

test("FakeCo teardown stops on malformed Worker deletion acknowledgement", async () => {
  const state = fixture();
  state.overrides.set("DELETE /workers/services/clawrouter-edge-fakeco?force=true",
    () => Response.json({}));
  await assert.rejects(state.run(), /missing success acknowledgement/);
  assert.equal(deletions(state).length, 2);
});

test("FakeCo teardown requires direct consumer absence before deleting the Worker", async () => {
  const state = fixture();
  state.overrides.set("GET /queues/usage-id/consumers/consumer-id",
    () => Response.json({ success: true, result: state.directConsumer }));
  await assert.rejects(state.run(), /consumer still present/);
  assert.deepEqual(deletions(state), ["DELETE /queues/usage-id/consumers/consumer-id"]);
});

test("FakeCo teardown requires queue metadata to confirm disconnection", async () => {
  const state = fixture();
  state.keepConsumer = true;
  await assert.rejects(state.run(), /consumer still attached/);
  assert.deepEqual(deletions(state), ["DELETE /queues/usage-id/consumers/consumer-id"]);
});

test("FakeCo teardown rechecks backlog after disconnecting", async () => {
  const state = fixture();
  state.overrides.set("GET /queues/usage-id/metrics", () => Response.json({ success: true,
    result: { backlog_count: state.detached ? 1 : 0, backlog_bytes: 0 } }));
  await assert.rejects(state.run(), /not verified empty/);
  assert.deepEqual(deletions(state), ["DELETE /queues/usage-id/consumers/consumer-id"]);
});

test("FakeCo teardown preserves queue and Access when backlog appears after Worker deletion", async () => {
  const state = fixture();
  state.overrides.set("GET /queues/usage-id/metrics", () => Response.json({ success: true,
    result: { backlog_count: state.usage.producers.length === 0 ? 1 : 0, backlog_bytes: 0 } }));
  await assert.rejects(state.run(), /not verified empty/);
  assert.deepEqual(deletions(state), ["DELETE /queues/usage-id/consumers/consumer-id",
    "DELETE /workers/services/clawrouter-edge-fakeco?force=true"]);
});

test("FakeCo teardown supports already-detached consumers and an absent Worker on a retry", async () => {
  const state = fixture();
  state.usage.consumers = [];
  state.workerAbsent = true;
  await state.run();
  assert.deepEqual(deletions(state), [
    "DELETE /workers/services/clawrouter-edge-fakeco?force=true",
    "DELETE /queues/usage-id", "DELETE /queues/dlq-id",
    "DELETE /access/apps/fakeco-access-app",
  ]);
});

test("FakeCo teardown treats only an exact missing queue as absent", async () => {
  const state = fixture();
  state.queues = [state.usage, { queue_id: "unrelated", queue_name: "production" }];
  await state.run();
  assert.match(state.logs.join("\n"), /queue clawrouter-usage-fakeco-dead-letter already absent/);
  assert.ok(!state.events.some((event) => /queues\/(dlq-id|unrelated)/.test(event)));
});
