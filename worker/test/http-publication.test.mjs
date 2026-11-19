import { perRequestAuthority } from "./typescript-setup.mjs";
perRequestAuthority();
import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "./http-continuation-fixture.mjs";
import { bodyBudgetCharged } from "../body-budget.ts";

for (const delayedTail of [false, true]) test(`unary first bytes precede finalization${delayedTail ? " and upstream EOF" : ""}`, { timeout: 10_000 }, async t => {
  const f = await fixture(t), entered = Promise.withResolvers(), finalization = Promise.withResolvers();
  t.after(() => finalization.resolve());
  const actions = [], get = f.env.ACCESS_CONTROL.get.bind(f.env.ACCESS_CONTROL);
  f.env.ACCESS_CONTROL.get = name => {
    const stub = get(name);
    return { async fetch(url, init) {
      if (name.startsWith("http-continuations:")) {
        const body = JSON.parse(init.body); actions.push(body.action);
        if (body.action === "qualify") { entered.resolve(); await finalization.promise; }
      }
      return stub.fetch(url, init);
    } };
  };
  let tail;
  const prefix = '{"object":"response","id":"resp_1",';
  const suffix = '"status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":1}}';
  if (delayedTail) f.response = () => new Response(new ReadableStream({ start(controller) {
    tail = controller; controller.enqueue(new TextEncoder().encode(prefix));
  } }), { headers: { "content-type": "application/json" } });
  const response = await f.request(), reader = response.body.getReader();
  const first = await reader.read();
  assert.equal(first.done, false);
  assert.deepEqual(actions, ["register"], "identity is acknowledged before delivery; finalization is not on the first-byte path");
  assert.equal(bodyBudgetCharged(), 0);
  if (tail) { assert.equal(new TextDecoder().decode(first.value), prefix); tail.enqueue(new TextEncoder().encode(suffix)); tail.close(); }
  let delivered = new TextDecoder().decode(first.value);
  const consuming = (async () => {
    while (true) { const next = await reader.read(); if (next.done) break; delivered += new TextDecoder().decode(next.value); }
    await f.drain();
  })();
  await entered.promise;
  finalization.resolve(); await consuming;
  assert.equal(JSON.parse(delivered).id, "resp_1");
  assert.deepEqual(actions, ["register", "qualify"]);
  const rows = f.bindings().flatMap(([, state]) => state.db.prepare("SELECT pricing_evidence_json FROM http_continuations").all());
  assert.equal(JSON.parse(rows[0].pricing_evidence_json).state, "final");
  assert.equal(f.sent.length, 1); assert.equal(f.events.length, 1); assert.equal(f.events[0].actual_cost_micros, 7);
  assert.equal(bodyBudgetCharged(), 0);
});
