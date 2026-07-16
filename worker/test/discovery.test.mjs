import assert from "node:assert/strict";
import { extname } from "node:path";
import { registerHooks } from "node:module";
import test from "node:test";

import { providerById } from "../providers.ts";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier.startsWith(".") &&
      context.parentURL &&
      !extname(new URL(specifier, context.parentURL).pathname)
    ) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});
const { catalogModels } = await import("../discovery.ts");

const fireworks = providerById("fireworks");
assert.ok(fireworks);
const endpoints = fireworks.endpoints.map((endpoint) => endpoint.id);

test("budgeted proxy-key catalogs omit unpriced models without fixed request pricing", () => {
  const models = catalogModels(fireworks, endpoints, {
    enabled: true,
    generation: "test",
    providers: ["fireworks"],
    monthlyBudgetMicros: 1_000_000,
    requestCostMicros: null,
  });

  assert.ok(models.some((model) => model.id === "fireworks/glm-5.2"));
  assert.ok(!models.some((model) => model.id === "fireworks/gpt-oss-120b"));
});

test("unpriced catalog models remain for unmetered, fixed-price, and Access scopes", () => {
  const policies = [
    { enabled: true, generation: "unmetered", providers: ["fireworks"], monthlyBudgetMicros: null, requestCostMicros: null },
    { enabled: true, generation: "fixed", providers: ["fireworks"], monthlyBudgetMicros: 1_000_000, requestCostMicros: 25 },
    null,
  ];

  for (const policy of policies) {
    const models = catalogModels(fireworks, endpoints, policy);
    assert.ok(models.some((model) => model.id === "fireworks/gpt-oss-120b"));
  }
});
