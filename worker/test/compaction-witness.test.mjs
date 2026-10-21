import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { fixture, grantKeys } from "./http-continuation-fixture.mjs";
import { putGrantCredentials, revokeGrantCredentials } from "../grant-credentials.ts";
import { compactionWitnessRetentionMs, compactionWitnessCapacity } from "../compaction-witness-store.ts";
import { sha256Hex } from "../utils.ts";

const item = { type: "compaction", id: "cmp_checkpoint", encrypted_content: "synthetic-opaque-window" };
const usage = { input_tokens: 100, output_tokens: 10, total_tokens: 110, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } };
const compact = output => ({ id: "cmp_pass", object: "response.compaction", output, usage, service_tier: "default", extra: { unchanged: true } });
const response = output => ({ id: "resp_threshold", object: "response", status: "completed", output, usage, service_tier: "default" });
function rows(f) {
  return f.bindings().flatMap(([, state]) => {
    assert.ok(state.db.prepare("SELECT name FROM sqlite_master WHERE name = ?").get("compaction_witnesses"), "real delivery must persist its immutable compaction witness");
    return state.db.prepare("SELECT * FROM compaction_witnesses").all();
  });
}

for (const unary of [false, true]) test((unary ? "unary" : "threshold") + " delivery produces a digest-only witness without changing bytes or accounting", async t => {
  const f = await fixture(t, false);
  const output = [{ type: "message", role: "user", content: "retained", extra: 42 }, item];
  const wire = JSON.stringify(unary ? compact(output) : response(output), null, 2) + "\n";
  f.response = () => new Response(wire, { headers: { "content-type": "application/json" } });
  const result = await f.request({ tools: [{ type: "web_search" }], service_tier: "default" }, {}, unary ? "/v1/responses/compact" : "/v1/responses");
  assert.equal(result.status, 200);
  assert.equal(await f.consume(result), wire);
  const stored = rows(f); assert.equal(stored.length, 1);
  const witness = JSON.parse(stored[0].witness_json);
  assert.equal(witness.ciphertextSha256, await sha256Hex(item.encrypted_content));
  assert.equal(witness.itemId, item.id);
  assert.equal(witness.knowledge, "hosted_tool_fee");
  assert.equal(witness.binding.model, "gpt-6-astra");
  assert.equal(witness.binding.credentialId, "fixture");
  assert.equal(witness.binding.policyId, "fixture");
  assert.equal(witness.binding.tenantId, "default");
  assert.equal(witness.binding.owner.grantKey, null);
  assert.ok(!JSON.stringify(stored).includes(item.encrypted_content));
  assert.equal(f.events.length, 1); assert.equal(f.events[0].actual_cost_micros, 7);
});


for (const order of ["incomplete-then-completed", "completed-then-incomplete", "completed-then-item", "completed-then-unknown"]) test("contradictory SSE terminal cannot certify a checkpoint: " + order, async t => {
  const f = await fixture(t, false);
  const completed = { type: "response.completed", response: response([item, { type: "additional_tools", tools: [{ type: "web_search" }] }]) };
  const incomplete = { type: "response.incomplete", response: { ...response([]), status: "incomplete" } };
  const events = order === "incomplete-then-completed" ? [incomplete, completed] : [completed, order === "completed-then-incomplete" ? incomplete : order === "completed-then-item" ? { type: "response.output_item.done", output_index: 1, item: { type: "additional_tools", tools: [{ type: "web_search" }] } } : { type: "response.future_event" }];
  const wire = events.map(value => 'data: ' + JSON.stringify(value) + '\n\n').join("");
  f.response = () => new Response(wire, { headers: { "content-type": "text/event-stream" } });
  const result = await f.request({ stream: true }); assert.equal(result.status, 200); assert.equal(await f.consume(result), wire);
  assert.equal(rows(f).length, 0); assert.equal(f.events.length, 1); assert.equal(f.events[0].actual_cost_micros, 7);
});

test("unattested encrypted reasoning cannot be laundered into token-only compaction evidence", async t => {
  const f = await fixture(t, false);
  const input = [{ type: "reasoning", id: "rs_unattested", summary: [], encrypted_content: "synthetic-unknown-reasoning" }];
  const wire = JSON.stringify(response([item]));
  f.response = () => new Response(wire, { headers: { "content-type": "application/json" } });
  const produced = await f.request({ input }); assert.equal(produced.status, 200); assert.equal(await f.consume(produced), wire);
  assert.deepEqual(f.sent[0].body.input, input);
  assert.equal(JSON.parse(rows(f)[0].witness_json).knowledge, "unknown");
  assert.equal(f.events.length, 1); assert.equal(f.events[0].actual_cost_micros, 7);
});
