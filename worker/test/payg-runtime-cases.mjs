import assert from "node:assert/strict";
import test from "node:test";

export function registerPaygRuntimeCases({ fixture, id, base, model, frozen, result, frame }) {
  for (const status of [401, 403, 429]) test(`${id} upstream ${status} never retries another region or billing product`, async t => {
    const f = await fixture(t, id);
    f.reply = () => Response.json({ error: { code: "plan_unavailable", message: "synthetic-plan-rejection" } }, { status });
    const r = await f.call({ model, messages: [] }); assert.equal(r.status, status, await r.clone().text()); await r.text(); await f.drain();
    assert.equal(f.sent.length, 1); assert.equal(f.sent[0].url, `${base}/chat/completions`);
    const [event] = f.events.filter(e => e.type === "clawrouter.usage.v1"); assert.equal(event.actual_cost_micros, 0);
  });
  test(`${id} routes every frozen model without changing its native identity`, async t => {
    const f = await fixture(t, id);
    for (const selected of frozen) {
      const body = { model: selected, messages: [{ role: "user", content: "synthetic-input" }], thinking: { type: "enabled" } };
      f.reply = () => Response.json({ ...result, model: selected });
      const r = await f.call(body); assert.equal(r.status, 200, await r.clone().text());
      assert.equal((await r.json()).model, selected);
      assert.deepEqual(await f.sent.at(-1).json(), body);
    }
    await f.drain(); assert.equal(f.sent.length, frozen.length);
  });

  for (const manifest of [false, true]) for (const outcome of ["usage-absent", "disconnect", "embedded-error"]) test(`${id} ${manifest ? "manifest" : "native"} ${outcome} preserves unknown usage and product isolation`, async t => {
    const f = await fixture(t, id);
    const chunk = frame({ id: result.id, object: "chat.completion.chunk", model, choices: [{ index: 0, delta: { content: "synthetic-partial" }, finish_reason: null }] });
    const wire = outcome === "embedded-error" ? frame({ error: { code: "plan_exhausted", message: "synthetic-plan-error" } }) : chunk + (outcome === "disconnect" ? "" : "data: [DONE]\n\n");
    let canceled = false;
    f.reply = () => new Response(new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode(wire)); if (outcome !== "disconnect") c.close(); },
      cancel() { canceled = true; },
    }), { headers: { "content-type": "text/event-stream" } });
    const r = await f.call({ model: manifest ? `${id}/${model}` : model, messages: [], stream: true }, { manifest });
    assert.equal(r.status, 200);
    if (outcome === "disconnect") {
      const reader = r.body.getReader(); assert.equal((await reader.read()).done, false);
      await reader.cancel("synthetic disconnect"); assert.equal(canceled, true);
    } else assert.equal(await r.text(), wire);
    await f.drain(); assert.equal(f.sent.length, 1); assert.equal(f.sent[0].url, `${base}/chat/completions`);
    const [event] = f.events.filter(e => e.type === "clawrouter.usage.v1");
    assert.deepEqual([event.input_tokens, event.output_tokens, event.total_tokens], [null, null, null]);
    assert.equal(event.status, outcome === "disconnect" ? "client_error" : outcome === "embedded-error" ? "provider_error" : "success");
    assert.equal(event.actual_cost_micros, outcome === "embedded-error" ? 0 : 7);
    assert.equal(event.cost_basis, outcome === "embedded-error" ? "none" : "policy_fixed");
    assert.equal(f.env.BUDGET_LEDGER.get("fixture:paid").reservations().length, 1);
  });

}
