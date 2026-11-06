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

for (const status of [401, 403, 429]) for (const cause of ["caller", "deadline"]) for (const late of ["resolve", "reject"]) test(
  `alternate ${status} preparation joins its held ${late} after ${cause} cancellation`,
  { timeout: 10_000 }, async t => {
    const f = await fixture(t, true, { limit: 1_000_000, fixedCost: 7 });
    const caller = new AbortController(), entered = Promise.withResolvers(), release = Promise.withResolvers();
    const { modelRoute } = await import("../providers.ts");
    const timeout = modelRoute("openai/gpt-6-astra").provider.endpoints.find(endpoint => endpoint.id === "responses").timeout_ms;
    const setTimer = globalThis.setTimeout;
    let deadline, canceled = false, selections = 0, pending, primary, consumed = false;
    const releaseSelection = () => late === "resolve" ? release.resolve() : release.reject(new Error("fixture late selection failure"));
    // Cleanup owns release and the originating request before either starts.
    t.after(async () => {
      releaseSelection(); const failures = [];
      try { if (pending) { const response = await pending; if (!consumed) await response.body?.cancel(); } }
      catch (error) { if (error !== primary) failures.push(error); }
      try { await f.drain(); } catch (error) { if (error !== primary) failures.push(error); }
      if (failures.length) throw new AggregateError(failures, "alternate preparation cleanup");
    });
    t.mock.method(globalThis, "setTimeout", (callback, delay, ...args) => {
      if (delay === timeout) deadline = callback;
      return setTimer(callback, delay, ...args);
    });
    f.env.ACCESS_CONTROL.beforeFetch = async (_name, request) => {
      if (new URL(request.url).pathname === "/admission/resolve" && (await request.clone().json()).selection?.excludedKeys?.length) {
        selections++; entered.resolve(); await release.promise;
      }
    };
    f.response = () => new Response(new ReadableStream({ cancel() { canceled = true; } }, { highWaterMark: 0 }), { status });
    try {
      pending = f.request({}, {}, "/v1/responses", caller.signal);
      const early = pending.then(() => { throw Error("request completed before held preparation"); }, error => { throw error; });
      early.catch(() => {});
      await Promise.race([entered.promise, early]);
      if (cause === "caller") caller.abort(new Error("fixture cancellation"));
      else { assert.equal(typeof deadline, "function"); deadline(); }
      await Promise.race([early, new Promise(resolve => setImmediate(resolve))]);
      assert.equal(selections, 1); assert.equal(f.sent.length, 1); assert.equal(f.events.length, 0);
      assert.equal(canceled, false, "the logical join precedes original-response cleanup");
      releaseSelection();
      const response = await pending;
      assert.equal(response.status, 502);
      assert.equal(JSON.parse(await f.consume(response)).error.code, "provider_unavailable"); consumed = true;
      assert.equal(canceled, true); assert.equal(f.sent.length, 1); assert.equal(f.events.length, 1);
      assert.equal(f.events[0].status, cause === "caller" ? "client_error" : "timeout");
      assert.equal(f.events[0].actual_cost_micros, 0);
      for (const owner of ["default:fixture", "provider:openai"]) {
        const rows = f.env.BUDGET_LEDGER.get(owner).reservations();
        assert.equal(rows.length, 1); assert.equal(rows[0].settled, 1); assert.equal(rows[0].reserved_micros, 0);
      }
    } catch (error) { primary = error; throw error; }
  },
);

for (const abortAtJoin of [false, true]) test(
  `rejected alternate preparation ${abortAtJoin ? "checks abort in the final-await continuation" : "preserves the original 429"}`,
  async t => {
    const f = await fixture(t, true, { limit: 1_000_000, fixedCost: 7 });
    const { HttpOperation } = await import("../http-operation.ts");
    const originalWait = HttpOperation.prototype.wait, caller = new AbortController();
    let failed = false, observed = 0, interceptions = 0, activeWhenQueued = false;
    t.mock.method(HttpOperation.prototype, "wait", function(pending, ...args) {
      const result = originalWait.call(this, pending, ...args);
      // Preserve the ORIGINAL wait promise. This observer runs before its caller's
      // catch; the queued abort runs while the finally await yields, even if settled.
      if (args.length === 0 && f.sent.length === 1) { interceptions++; result.then(() => {}, () => {
        if (failed && observed === 0) { observed++; activeWhenQueued = !caller.signal.aborted;
          if (abortAtJoin) queueMicrotask(() => caller.abort(new Error("fixture final-await abort"))); }
      }); }
      return result;
    });
    f.env.ACCESS_CONTROL.beforeFetch = async (_name, request) => {
      if (new URL(request.url).pathname === "/admission/resolve" && (await request.clone().json()).selection?.excludedKeys?.length) {
        failed = true; throw Error("fixture alternate selection failed");
      }
    };
    f.response = () => Response.json({ error: "original rejection" }, { status: 429 });
    const response = await f.request({}, {}, "/v1/responses", caller.signal);
    assert.equal(response.status, abortAtJoin ? 502 : 429);
    const body = JSON.parse(await f.consume(response));
    assert.deepEqual(body, abortAtJoin ? { error: { code: "provider_unavailable", message: "upstream request to provider openai failed" } } : { error: "original rejection" });
    assert.equal(observed, 1); assert.equal(interceptions, 1); assert.equal(activeWhenQueued, true); assert.equal(caller.signal.aborted, abortAtJoin);
    assert.equal(f.sent.length, 1); assert.equal(f.events.length, 1);
    assert.equal(f.events[0].status, "client_error"); assert.equal(f.events[0].actual_cost_micros, 0);
  },
);
