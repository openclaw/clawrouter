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
  assert.equal(consoleStatusPresentation("enabled openai", false).showBar, false);
  assert.equal(consoleStatusPresentation("disabled openai", false).showBar, false);
  assert.equal(consoleStatusPresentation("local demo data loaded", true).label, "Demo");

  assert.deepEqual(consoleStatusPresentation("loading", false), {
    tone: "pending",
    label: "Working",
    showBar: true,
  });
  for (const status of ["issuing credential", "reconciling assignments", "refreshing upstream grant"]) {
    assert.equal(consoleStatusPresentation(status, false).tone, "pending", status);
  }

  assert.deepEqual(consoleStatusPresentation("entitlements unavailable", false), {
    tone: "neutral",
    label: "Degraded",
    showBar: true,
  });
  assert.equal(consoleStatusPresentation("saved user; refresh failed", false).label, "Needs attention");
});
