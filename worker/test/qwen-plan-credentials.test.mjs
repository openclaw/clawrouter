import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
const { assertQwenCodingPlanCredential } = await import("../qwen-plan-credentials.ts");

for (const id of ["qwen-coding-global", "qwen-coding-cn"]) {
  test(`${id} credential shape accepts the documented plan prefix without rewriting`, () => {
    for (const credential of ["sk-sp-synthetic-plan", " sk-sp-synthetic-plan "]) {
      assert.equal(assertQwenCodingPlanCredential(id, credential), undefined);
    }
  });
  test(`${id} credential shape rejects PAYG, OAuth and malformed keys with a sanitized error`, () => {
    for (const credential of ["sk-synthetic-payg", "synthetic-portal-token", "sk-sp-", "sk-sp-synthetic key", "sk-sp-synthetic\nheader", "", null]) {
      assert.throws(() => assertQwenCodingPlanCredential(id, credential), e => {
        assert.equal(e.status, 503); assert.equal(e.code, "provider_credentials_invalid");
        assert.equal(e.message, "Qwen Coding Plan requires a plan credential"); return true;
      });
    }
  });
}

test("Qwen Coding Plan shape leaves standard and Token Plan credentials to their own contracts", () => {
  for (const id of ["qwen", "qwen-cn", "qwen-token-plan", "qwen-token-plan-cn", "other-provider"]) {
    assert.equal(assertQwenCodingPlanCredential(id, "synthetic-other-product"), undefined);
  }
});
