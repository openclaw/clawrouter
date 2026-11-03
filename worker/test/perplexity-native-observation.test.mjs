import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createSseUsageInspector, extractUsageTokens, responseOutcome } from "../token-usage.ts";

const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/perplexity/native-contracts.json", import.meta.url), "utf8"));
const encode = events => new TextEncoder().encode(events.map(event => `event: ${event.type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`).join(""));

test("Perplexity Agent JSON observes inclusive tokens without turning provider-reported costs into a tariff", () => {
  const tokens = extractUsageTokens(wire.agent.response);
  assert.equal(tokens.input, 1000);
  assert.equal(tokens.output, 100);
  assert.equal(tokens.total, 1100);
  assert.equal(tokens.cached, 200);
  assert.equal(responseOutcome(wire.agent.response), "success");
  assert.equal(tokens.actual_cost_micros, undefined);
  assert.equal(wire.billing.agentQualifiedWholeRunBoundMicros, null);
  assert.notEqual(wire.billing.policyFixedMicros, wire.billing.agentReportedCostMicros);
});

test("Perplexity Agent typed SSE reaches the same terminal usage across UTF-8 and frame boundaries", () => {
  const bytes = encode(wire.agent.streamEvents);
  for (const width of [1, 7, bytes.length]) {
    const inspector = createSseUsageInspector();
    for (let i = 0; i < bytes.length; i += width) inspector.push(bytes.subarray(i, i + width));
    assert.deepEqual(inspector.result(), { tokens: extractUsageTokens(wire.agent.response), outcome: "success" });
  }
});

test("Perplexity Agent root-level stream failure after output cannot become successful completion", () => {
  const inspector = createSseUsageInspector();
  inspector.push(encode(wire.agent.failureEvents));
  assert.deepEqual(inspector.result(), { tokens: null, outcome: "provider_error" });
  assert.equal(wire.agent.failureEvents.at(-1).response, undefined, "native failed event carries error at the top level");
});

test("Perplexity Search results and empty success supply no invented token usage", () => {
  for (const body of [wire.search.response, wire.search.emptyResponse, wire.search.rejection.body]) {
    assert.equal(extractUsageTokens(body), null);
  }
  assert.equal(responseOutcome(wire.search.response), null, "Search has no Agent terminal envelope");
  assert.equal(wire.search.response.choices, undefined);
  assert.equal(wire.search.response.output, undefined);
});
