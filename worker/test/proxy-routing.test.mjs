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
