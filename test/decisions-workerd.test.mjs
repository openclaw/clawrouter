import assert from "node:assert/strict";
import test from "node:test";
import { startDecisionsFixture, until } from "./helpers/decisions-workerd.mjs";

test("real Decisions Worker preserves protocol-complete responses, 400 questions, image input, errors and ledger settlement", async () => {
  const f = await startDecisionsFixture();
  try {
    const catalog = await f.read("/v1/catalog");
    const luna = catalog.providers.find(p => p.id === "openai").models.find(m => m.id === "openai/gpt-6-luna");
    assert.equal(luna.nativeCapabilities.endpoints.decisions.inference.decision.limits.maxQuestions, 400);
    assert.equal(luna.nativeCapabilities.endpoints.decisions.inference.chat, false);
    assert.equal(luna.nativeCapabilities.endpoints.responses.maxOutputTokens, 128000);
    const questions = [{ type: "predicate", name: "damage", instructions: "Damaged?" },
      { type: "choice", name: "typed", instructions: "Which?", choices: [{ value: true }, { value: "true" }] },
      { type: "score", name: "severity", instructions: "Severity?", levels: [{ label: "0" }, { label: "1" }] },
      { type: "predicate", name: "withheld", instructions: "Refusal sibling" }];
    const routes = ["/v1/decisions", "/v1/native/openai/v1/decisions", "/v1/proxy/openai/decisions"];
    for (const [index, route] of routes.entries()) {
      const image = ["png", "jpeg", "webp"][index];
      const body = { model: index === 1 ? "gpt-6-luna" : "openai/gpt-6-luna",
        input: [{ role: "user", content: [{ type: "input_text", text: "Fixture image" }, { type: "input_image", image_url: `data:image/${image};base64,AQID` }] }],
        questions: [...questions, ...Array.from({ length: 396 }, (_, i) => ({ type: "predicate", name: `q${i}`, instructions: "Fixture?" }))],
        prompt_cache_key: "fixture-cache", prompt_cache_options: { mode: "explicit", ttl: "30m" }, safety_identifier: "fixture-user" };
      const response = await fetch(f.origin + route, { method: "POST", headers: f.headers, body: JSON.stringify(index === 2 ? { body } : body) });
      assert.equal(response.status, 200, await response.clone().text());
      const result = await response.json();
      assert.equal(result.model, "gpt-6-luna");
      assert.equal(result.answers.length, 400);
      assert.deepEqual(result.answers.slice(0, 4), [
        { name: "damage", type: "predicate", probability: 0.9 },
        { name: "typed", type: "choice", choice: true, confidence: 0.8, probabilities: [{ value: true, probability: 0.8 }, { value: "true", probability: 0.2 }] },
        { name: "severity", type: "score", score: 0.75, confidence: 0.7, probabilities: [{ label: "0", value: 0, probability: 0.25 }, { label: "1", value: 1, probability: 0.75 }] },
        { name: "withheld", type: "refusal" },
      ]);
      const sent = (await f.read("/fixture-state")).requests[index];
      assert.equal(sent.upstreamAuth, true);
      assert.deepEqual(sent.body, { ...body, model: "gpt-6-luna" });
    }
    await until(async () => (await f.read("/v1/usage")).usage.events.length === 3 && (await f.ledgerFacts()).every(({ rows }) => rows.length === 3 && rows.every(row => row.settled === 1)));
    for (const event of (await f.read("/v1/usage")).usage.events) {
      assert.equal(event.capability, "llm.decisions"); assert.equal(event.actual_cost_micros, 100);
      assert.equal(event.pricing_ref, "openai-gpt-6-luna-decisions-2026-10-21");
      assert.equal(event.reserved_output_tokens, 0); assert.equal(event.reserved_cost_micros, 184400);
      assert.equal(event.content_retained, false);
    }
    for (const { rows } of await f.ledgerFacts()) assert.ok(rows.every(row => row.reserved_micros === 100));
    const response = await fetch(f.origin + routes[0], { method: "POST", headers: f.headers, body: JSON.stringify({ model: "openai/gpt-6-luna", input: "reject", questions }) });
    assert.equal(response.status, 422);
    assert.deepEqual(await response.json(), { error: { type: "invalid_request_error", code: "fixture_rejection", message: "Synthetic invalid input" } });
    await until(async () => (await f.read("/v1/usage")).usage.events.length === 4);
    assert.equal((await f.read("/v1/usage")).usage.events.find(event => event.status_code === 422).actual_cost_micros, 0);
    const denied = await fetch(f.origin + routes[0], { method: "POST", headers: { ...f.headers, authorization: `Bearer ${f.deniedKey}` }, body: JSON.stringify({ model: "openai/gpt-6-luna", input: "deny", questions }) });
    assert.equal(denied.status, 403);
    assert.equal((await f.read("/fixture-state")).requests.length, 4);
  } finally { await f.close(); }
});

test("canceling a real Decisions response aborts upstream and settles the dispatched reservation", async () => {
  const f = await startDecisionsFixture(), caller = new AbortController();
  const safety = AbortSignal.timeout(15_000);
  let response;
  try {
    const pending = fetch(f.origin + "/v1/decisions", {
      method: "POST", headers: f.headers, signal: AbortSignal.any([caller.signal, safety]),
      body: JSON.stringify({ model: "openai/gpt-6-luna", input: "cancel", questions: [{ type: "predicate", name: "damage", instructions: "Damaged?" }] }),
    }).then(async value => { response = value; assert.equal(value.status, 200); return value.text(); });
    const canceled = assert.rejects(pending, error => error === caller.signal.reason || error.name === "AbortError");
    await until(async () => (await f.read("/fixture-state")).requests.length === 1);
    caller.abort(new Error("fixture Decisions caller stopped"));
    await canceled;
    await until(async () => {
      const { requests } = await f.read("/fixture-state");
      return requests.length === 1 && (requests[0].aborted || requests[0].canceled)
        && (await f.read("/v1/usage")).usage.events.length === 1
        && (await f.ledgerFacts()).every(({ rows }) => rows.length === 1 && rows[0].settled === 1);
    });
    assert.equal(safety.aborted, false, "caller cancellation, not safety timeout, owns completion");
    assert.match(caller.signal.reason.message, /fixture Decisions caller stopped/);
    // workerd may cancel the response pump before request.signal fires (Linux).
    // Upstream termination and the settled client_error receipt above/below are
    // authoritative; both transport cleanup paths must preserve that outcome.
    const ingress = await f.read("/fixture-ingress");
    assert.equal(ingress.length, 1);
    assert.equal(ingress[0].path, "/v1/decisions");
    assert.equal(ingress[0].routerAuth, true);
    const [event] = (await f.read("/v1/usage")).usage.events;
    assert.equal(event.status, "client_error");
    assert.equal(event.cost_basis, "manifest_reservation");
    assert.ok(event.reserved_cost_micros > 0);
    assert.equal(event.actual_cost_micros, event.reserved_cost_micros);
    assert.equal(event.input_tokens, null, "interrupted JSON cannot invent usage");
    assert.equal(event.reserved_output_tokens, 0);
    for (const { rows } of await f.ledgerFacts()) {
      assert.equal(rows[0].dispatch_started, 1);
      assert.equal(rows[0].reserved_micros, event.reserved_cost_micros);
    }
  } finally {
    caller.abort();
    await response?.body?.cancel().catch(() => undefined);
    await f.close();
  }
});
