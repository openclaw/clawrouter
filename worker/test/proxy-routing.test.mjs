import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "./http-continuation-fixture.mjs";

for (const alternate of [false, true]) test(
  `redirect on the ${alternate ? "alternate" : "initial"} grant never replays or escapes to the client`,
  async t => {
    const f = await fixture(t);
    let canceled = false;
    f.response = (_request, index) => alternate && index === 1
      ? Response.json({ error: "fixture rate limit" }, { status: 429 })
      : new Response(new ReadableStream({ cancel() { canceled = true; } }, { highWaterMark: 0 }), { status: 307, headers: { location: "https://redirect.example/private-destination" } });
    const response = await f.request();
    assert.equal(response.status, 502);
    assert.equal(response.headers.has("location"), false);
    assert.equal(JSON.parse(await f.consume(response)).error.code, "provider_unavailable");
    assert.equal(f.sent.length, alternate ? 2 : 1);
    assert.ok(f.sent.every(request => request.redirect === "manual"));
    assert.equal(canceled, true);
    assert.equal(f.events.length, 1);
    assert.equal(f.events[0].status, "provider_error");
    assert.equal(f.events[0].actual_cost_micros, 0, "a received non-success is not an uncertain dispatch");
    assert.doesNotMatch(JSON.stringify(f.events), /synthetic-access|private-destination|fixture-secret/);
  },
);

for (const cause of ["caller", "deadline"]) for (const late of ["resolve", "reject"]) test(
  "blocked alternate selection settles on " + cause + " before its late " + late,
  async t => {
    const f = await fixture(t, true, { limit: 1_000_000, fixedCost: 7 });
    const caller = new AbortController(), entered = Promise.withResolvers(), release = Promise.withResolvers();
    const { modelRoute } = await import("../providers.ts");
    const timeout = modelRoute("openai/gpt-6-astra").provider.endpoints.find(endpoint => endpoint.id === "responses").timeout_ms;
    const setTimer = globalThis.setTimeout;
    let deadline, canceled = false;
    t.mock.method(globalThis, "setTimeout", (callback, delay, ...args) => {
      if (delay === timeout) deadline = callback;
      return setTimer(callback, delay, ...args);
    });
    f.env.ACCESS_CONTROL.beforeFetch = async (_name, request) => {
      if (new URL(request.url).pathname === "/admission/resolve" && (await request.clone().json()).selection?.excludedKeys?.length) {
        entered.resolve(); await release.promise;
      }
    };
    f.response = () => new Response(new ReadableStream({ cancel() { canceled = true; } }, { highWaterMark: 0 }), { status: 429 });
    const pending = f.request({}, {}, "/v1/responses", caller.signal);
    let guard;
    try {
      await entered.promise;
      if (cause === "caller") caller.abort(new Error("fixture cancellation"));
      else { assert.equal(typeof deadline, "function"); deadline(); }
      const response = await Promise.race([pending, new Promise(resolve => { guard = setTimer(() => resolve(null), 200); })]);
      assert.ok(response, "request must settle without waiting for the stalled alternate selection");
      assert.equal(response.status, 502);
      assert.equal(JSON.parse(await f.consume(response)).error.code, "provider_unavailable");
      assert.equal(canceled, true); assert.equal(f.sent.length, 1);
      assert.equal(f.events.length, 1);
      assert.equal(f.events[0].status, cause === "caller" ? "client_error" : "timeout");
      assert.equal(f.events[0].actual_cost_micros, 0);
    } finally {
      clearTimeout(guard);
      if (late === "resolve") release.resolve(); else release.reject(new Error("fixture late selection failure"));
      const response = await pending;
      await response.text().catch(() => {}); await f.drain();
      // Flush the abandoned preparation's completion, which must never dispatch.
      await new Promise(resolve => setTimer(resolve, 10));
    }
    assert.equal(f.sent.length, 1); assert.equal(f.events.length, 1);
    for (const owner of ["default:fixture", "provider:openai"]) {
      const rows = f.env.BUDGET_LEDGER.get(owner).reservations();
      assert.equal(rows.length, 1); assert.equal(rows[0].settled, 1); assert.equal(rows[0].reserved_micros, 0);
    }
  },
);
