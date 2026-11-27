import assert from "node:assert/strict";
import test from "node:test";
import { consoleStatusPresentation } from "../src/status-display.ts";

test("healthy status is compact while actionable states retain the status bar", () => {
  assert.deepEqual(consoleStatusPresentation("connected", false), {
    tone: "success",
    label: "Connected",
    showBar: false,
  });
  assert.equal(consoleStatusPresentation("saved policy", false).showBar, false);
  assert.equal(consoleStatusPresentation("issued credential", false).showBar, false);
  assert.equal(consoleStatusPresentation("rotated credential", false).showBar, false);
  assert.equal(consoleStatusPresentation("enabled openai", false).showBar, false);
  assert.equal(consoleStatusPresentation("disabled openai", false).showBar, false);
  assert.equal(consoleStatusPresentation("local demo data loaded", true).label, "Demo");

  assert.deepEqual(consoleStatusPresentation("loading", false), {
    tone: "pending",
    label: "Working",
    showBar: true,
  });
  for (const status of ["issuing credential", "rotating credential", "reconciling assignments", "refreshing upstream grant"]) {
    assert.equal(consoleStatusPresentation(status, false).tone, "pending", status);
  }

  assert.deepEqual(consoleStatusPresentation("entitlements unavailable", false), {
    tone: "neutral",
    label: "Degraded",
    showBar: true,
  });
  assert.equal(consoleStatusPresentation("saved user; refresh failed", false).label, "Needs attention");
});

test("refresh failure remains visible alongside a successful action result", () => {
  assert.deepEqual(consoleStatusPresentation("saved policy", false, true), { tone: "error", label: "Needs attention", showBar: true });
  assert.equal(consoleStatusPresentation("connected", false, true).tone, "error");
  assert.equal(consoleStatusPresentation("connected", false, false).tone, "success");
  // Operation admission still uses the action status, independent of refresh health.
  assert.equal(consoleStatusPresentation("saving policy", false).tone, "pending");
  assert.equal(consoleStatusPresentation("connected", false, false, true).tone, "pending");
  assert.equal(consoleStatusPresentation("saved policy", false, true, true).tone, "error");
});
