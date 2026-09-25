import assert from "node:assert/strict";
import test from "node:test";
import { responsesObservation, responseOutcome } from "../token-usage.ts";

for (const status of ["queued", "in_progress", "completed", "incomplete", "failed", "cancelled"]) test(`generation ${status} is explicit and independent of delivery`, () => {
  const value = { id: "response-fixture", object: "response", status, usage: null };
  const terminal = !["queued", "in_progress"].includes(status);
  const expected = { id: value.id, status, terminal, tokens: null };
  assert.deepEqual(responsesObservation(value), expected);
  assert.deepEqual(responsesObservation({ type: `response.${status}`, response: value }), expected);
  assert.equal(responseOutcome(value), terminal ? ["completed", "incomplete"].includes(status) ? "success" : "provider_error" : null);
});

test("missing or contradictory protocol facts cannot mint a generation terminal", () => {
  for (const value of [null, {}, { id: "response", status: "completed" }, { object: "response", status: "completed" },
    { object: "response", id: "response", status: "future" }, { type: "error", response: { id: "response", status: "failed" } },
    { type: "response.completed", response: { id: "response", status: "queued" } },
    { object: "response", id: "é".repeat(129), status: "completed" }]) assert.equal(responsesObservation(value), null);
  assert.equal(responsesObservation({ object: "response", id: "é".repeat(128), status: "completed" }).terminal, true);
});
