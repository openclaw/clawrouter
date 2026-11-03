import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fixture, contract, path } from "./managed-runtime-fixture.mjs";
const { managedLifecycleAdapter } = await import("../managed-lifecycle-adapters.ts");
const { wanManagedAdapter } = await import("../managed-wan.ts");
const { createRunwayManagedAdapter } = await import("../managed-runway.ts");
const { createPixVerseManagedAdapter } = await import("../managed-pixverse.ts");
const wan = JSON.parse(readFileSync(new URL("../../providers/_fixtures/wan/lifecycle.json", import.meta.url)));
const pixverse = JSON.parse(readFileSync(new URL("../../providers/_fixtures/pixverse/lifecycle.json", import.meta.url)));
const protocols = [
  { name: "Wan UNKNOWN", codec: wanManagedAdapter, id: wan.create.response.output.task_id, loss: "expired_or_unknown", body: { output: { task_id: wan.create.response.output.task_id, ...wan.observations.find(item => item.observationUnavailable).native } } },
  { name: "PixVerse deleted", codec: createPixVerseManagedAdapter("text"), id: String(pixverse.text.response.Resp.video_id), loss: "deleted", body: { ErrCode: 0, Resp: { ...pixverse.observations.find(item => item.observationUnavailable).native } } },
];

for (const protocol of protocols) for (const source of ["public", "collector", "cancel"]) test(`${protocol.name}: ${source} stops polls and freezes one fixed receipt through lost ACK/restart`, async t => {
  const f = await fixture(t, { pooled: true }), adapter = managedLifecycleAdapter("replicate.predictions"), read = adapter.read;
  // Keep registration disabled. Feed actual source-owned observation parsers
  // into the existing qualified controller to test the common state boundary.
  t.mock.method(adapter, "read", (response, context) => context.action === "create" ? read(response, context) : protocol.codec.read(response, context));
  f.upstream = request => Response.json(request.method === "POST" && !request.url.endsWith("/cancel") ? { ...contract.responses.created, id: protocol.id } : protocol.body);
  const created = await f.call(path, contract.request.body, { headers: { "Idempotency-Key": "one-loss-job" } });
  assert.equal(created.status, 200, await created.clone().text()); const state = f.state(created), control = `${path}/${protocol.id}`;
  f.loseUsageAck();
  if (source === "collector") { f.advance(5000); await state.alarm(); }
  else {
    const response = await f.call(control + (source === "cancel" ? "/cancel" : ""), null, { method: source === "cancel" ? "POST" : "GET" });
    assert.equal(response.status, 410, await response.clone().text()); assert.equal((await response.json()).error.code, "prediction_observation_unavailable");
    await state.alarm();
  }
  assert.equal(state.job().managed.terminal, null); assert.equal(state.job().managed.observationUnavailable, protocol.loss);
  assert.equal(state.job().amount, 700); assert.equal(state.job().basis, "policy_fixed");
  assert.equal(f.sent.length, 2); assert.equal(f.sent.filter(request => request.method === "POST").length, 1, "loss during cancel preflight never sends cancellation");
  assert.ok(f.sent.every(request => request.headers.get("authorization") === "Bearer synthetic-original-key"));
  f.restart(); f.advance(30_000); await state.alarm(); await f.drain();
  const events = await f.events(); assert.equal(events.length, 1); assert.equal(events[0].actual_cost_micros, 700); assert.equal(events[0].cost_basis, "policy_fixed"); assert.equal(events[0].total_tokens, null);
  assert.equal(state.job().phase, "complete"); assert.deepEqual(state.job().settlements, ["settled", "settled"]);
  const replay = await f.call(path, contract.request.body, { headers: { "Idempotency-Key": "one-loss-job" } }); assert.equal(replay.status, 410);
  const again = await f.call(control, null); assert.equal(again.status, 410); assert.equal(again.headers.get("cache-control"), "no-store");
  f.advance(60 * 60_000); await state.alarm(); assert.equal(f.sent.length, 2, "uncertainty never polls for another hour or replays create");
  assert.equal(f.budgetCalls.filter(call => call.path === "/reserve").length, 2);
});

test("Runway cancel/delete ACK preserves bodyless 204 and freezes uncertainty without another GET", async t => {
  const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/runway/lifecycle.json", import.meta.url)));
  const f = await fixture(t), adapter = managedLifecycleAdapter("replicate.predictions"), read = adapter.read, codec = createRunwayManagedAdapter("text");
  t.mock.method(adapter, "read", (response, context) => context.action === "create" ? read(response, context) : codec.read(response, context));
  f.upstream = request => request.url.endsWith("/cancel") ? new Response(null, { status: wire.cancel.status })
    : Response.json(request.method === "POST" ? { ...contract.responses.created, id: wire.created.id } : { id: wire.created.id, ...wire.observations[2].native });
  const created = await f.call(path, contract.request.body, { headers: { "Idempotency-Key": "runway-ack" } });
  assert.equal(created.status, 200, await created.clone().text()); const state = f.state(created), control = `${path}/${wire.created.id}`;
  const response = await f.call(control + "/cancel", null, { method: "POST" });
  assert.equal(response.status, 204); assert.equal(response.body, null); assert.equal(await response.text(), ""); assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(f.sent.length, 3); assert.equal(state.job().managed.observationUnavailable, "canceled_or_deleted"); assert.equal(state.job().managed.terminal, null);
  assert.equal(state.job().event.status_code, 204); assert.equal(state.job().amount, 700); assert.equal(state.job().basis, "policy_fixed");
  f.loseUsageAck(); await state.alarm(); f.restart(); f.advance(30_000); await state.alarm(); await f.drain();
  assert.equal((await f.events()).length, 1); assert.equal(state.job().phase, "complete");
  assert.equal((await f.call(control, null)).status, 410);
  assert.equal((await f.call(control + "/cancel", null, { method: "POST" })).status, 410);
  f.advance(60 * 60_000); await state.alarm(); assert.equal(f.sent.length, 3, "no GET or DELETE retry after the qualified loss ACK");
});
