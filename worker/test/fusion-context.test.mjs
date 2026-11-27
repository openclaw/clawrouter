import assert from "node:assert/strict";
import test from "node:test";
import { boundedFusionText } from "../../shared/fusion-context.ts";

test("oversized adviser messages keep task instructions and the source tail", () => {
  const content = "TASK: preserve the public API.\n" + "x".repeat(3000) + "\nEND OF SOURCE";
  const bounded = boundedFusionText(content, 1000);
  assert.ok(bounded.startsWith("TASK: preserve the public API.\n"));
  assert.ok(bounded.endsWith("\nEND OF SOURCE"));
  assert.match(bounded, /middle of message omitted/);
  assert.equal(bounded.length, 1000);
});

test("complete messages stay byte-for-byte unchanged", () => {
  for (const content of ["", "exactly", "Unicode 🦊 instructions", "\0\nsource\r\n"]) {
    assert.equal(boundedFusionText(content, content.length), content);
    assert.equal(boundedFusionText(content, content.length + 100), content);
  }
});

test("small remaining budgets keep the recent tail without an overflowing marker", () => {
  for (let budget = 0; budget < 40; budget++) {
    const result = boundedFusionText("a".repeat(100), budget);
    assert.ok(result.length <= budget);
  }
  assert.equal(boundedFusionText("earlier context; latest", 6), "latest");
  assert.equal(boundedFusionText("🦊", 1), "");
});

test("every truncation boundary preserves valid supplementary characters", () => {
  for (const content of ["🦊".repeat(200), "a" + "🦊".repeat(200), "🦊".repeat(200) + "z"]) {
    for (let budget = 0; budget < content.length; budget++) {
      const result = boundedFusionText(content, budget);
      assert.ok(result.length <= budget);
      assert.ok(result.isWellFormed(), `invalid Unicode at budget ${budget}`);
    }
  }
});
