import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import { extname } from "node:path";
registerHooks({ resolve(specifier, context, nextResolve) {
  return nextResolve(specifier.startsWith(".") && context.parentURL && !extname(new URL(specifier, context.parentURL).pathname) ? `${specifier}.ts` : specifier, context);
} });
const { credentialExpiryLabel, keyTierChoices } = await import("../src/member-key-options.ts");
import { credentialOutcome } from "../src/domain.ts";

test("expiry labels warn below fourteen days and mark expired keys inactive", () => {
  const now = Date.parse("2026-10-18T00:00:00Z");
  assert.deepEqual(credentialExpiryLabel("2026-10-28T00:00:00Z", now), { label: "expires in 10 days", warning: true });
  assert.equal(credentialExpiryLabel("2026-11-01T00:00:00Z", now).warning, false);
  assert.deepEqual(credentialExpiryLabel("2026-10-17T00:00:00Z", now), { label: "expired on 2026-10-17", warning: true });
  assert.equal(credentialOutcome({ enabled: true, expired: true }, []).active, false);
});
test("key choices inherit available tiers with independent fast and ultrafast opt outs", () => {
  assert.deepEqual(keyTierChoices(undefined, true, false), ["default", "flex", "priority"]);
  assert.deepEqual(keyTierChoices(undefined, false, false), ["default", "flex"]);
  const policy = { serviceTiers: { allowed: ["default", "flex", "priority"], models: { "openai/gpt-6.1-sol": ["default", "priority", "ultrafast"] } } };
  assert.deepEqual(keyTierChoices(policy, false, true), ["default", "flex", "ultrafast"]);
  assert.deepEqual(keyTierChoices({ ...policy, models: [] }, true, true), []);
});
