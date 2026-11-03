import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
const { assertXiaomiTokenPlanCredential } = await import("../xiaomi-plan-credentials.ts");

for (const id of ["xiaomi-token-plan", "xiaomi-token-plan-cn", "xiaomi-token-plan-ams"]) {
  test(`${id} credential contract accepts personal and team shapes without rewriting them`, () => {
    for (const credential of ["tp-synthetic-personal", "ttp-synthetic-team", " TP-synthetic-case "]) {
      assert.equal(assertXiaomiTokenPlanCredential(id, credential), undefined);
    }
  });

  test(`${id} credential contract rejects PAYG and malformed keys without exposing them`, () => {
    for (const credential of ["sk-synthetic-payg", "tp-", "ttp-", "tp-synthetic key", "tp-synthetic\nheader", "", null]) {
      assert.throws(() => assertXiaomiTokenPlanCredential(id, credential), e => {
        assert.equal(e.status, 503); assert.equal(e.code, "provider_credentials_invalid");
        assert.equal(e.message, "Xiaomi Token Plan requires a plan credential");
        return true;
      });
    }
  });
}

test("Xiaomi plan validation leaves unrelated provider contracts to their owners", () => {
  assert.equal(assertXiaomiTokenPlanCredential("xiaomi", "sk-synthetic-payg"), undefined);
  assert.equal(assertXiaomiTokenPlanCredential("other-provider", "synthetic-unrelated"), undefined);
});
