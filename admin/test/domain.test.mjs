import assert from "node:assert/strict";
import test from "node:test";
import {
  directUserBindingChanges,
  effectiveAccess,
  optionalCurrencyMicros,
  optionalNumber,
  playgroundAccessEndpoint,
  playgroundBlocker,
  playgroundPayload,
  policyUsageFallback,
  reconcileDirectUserBindings,
  readinessTone,
  serviceOutcome,
  tenantSummaryFallback,
} from "../src/domain.ts";

const services = [
  service("openai", true),
  service("tavily", true),
  service("disabled-provider", false, "disabled"),
];

const policies = [
  { policyId: "models", enabled: true, providers: ["openai"], tenantId: "openclaw" },
  { policyId: "tools", enabled: true, providers: ["tavily"], tenantId: "openclaw" },
  { policyId: "wildcard", enabled: true, providers: [], tenantId: "ops" },
  { policyId: "disabled", enabled: false, providers: ["disabled-provider"], tenantId: "openclaw" },
];

test("an Access admin without an explicit binding has zero provider access", () => {
  const user = { email: "admin@example.com", role: "admin", tenantId: "openclaw", enabled: true, groups: [] };
  const access = effectiveAccess(user, policies, [], services);
  assert.deepEqual(access.policies, []);
  assert.deepEqual(access.services, []);
});

test("direct and group bindings compose, while disabled policies do not", () => {
  const user = { email: "maintainer@example.com", role: "user", tenantId: "openclaw", enabled: true, groups: ["maintainers"] };
  const bindings = [
    { policyId: "models", principalType: "group", principalId: "maintainers", enabled: true, priority: 10 },
    { policyId: "tools", principalType: "user", principalId: user.email, enabled: true, priority: 20 },
    { policyId: "disabled", principalType: "user", principalId: user.email, enabled: true, priority: 30 },
  ];
  const access = effectiveAccess(user, policies, bindings, services);
  assert.deepEqual(access.policies.map((policy) => policy.policyId), ["models", "tools"]);
  assert.deepEqual(access.services.map((item) => item.provider), ["openai", "tavily"]);
});

test("a wildcard policy grants every declared service", () => {
  const user = { email: "ops@example.com", role: "user", tenantId: "ops", enabled: true, groups: ["ops"] };
  const bindings = [{ policyId: "wildcard", principalType: "group", principalId: "ops", enabled: true, priority: 1 }];
  assert.deepEqual(effectiveAccess(user, policies, bindings, services).services, services);
});

test("reconciling user bindings preserves inherited bindings and tombstones removals", () => {
  const current = [
    { policyId: "models", principalType: "user", principalId: "user@example.com", enabled: true, priority: 8 },
    { policyId: "tools", principalType: "group", principalId: "maintainers", enabled: true, priority: 20 },
  ];
  const next = reconcileDirectUserBindings(current, "user@example.com", policies, ["tools"]);
  assert.deepEqual(next.find((binding) => binding.principalType === "group"), current[1]);
  assert.deepEqual(next.find((binding) => binding.policyId === "models"), {
    policyId: "models",
    principalType: "user",
    principalId: "user@example.com",
    enabled: false,
    priority: 8,
  });
  assert.equal(next.find((binding) => binding.policyId === "tools" && binding.principalType === "user")?.enabled, true);
});

test("direct user binding changes separate removals from additions", () => {
  const current = [
    { policyId: "models", principalType: "user", principalId: "user@example.com", enabled: true, priority: 8 },
    { policyId: "tools", principalType: "user", principalId: "user@example.com", enabled: false, priority: 20 },
    { policyId: "wildcard", principalType: "group", principalId: "maintainers", enabled: true, priority: 30 },
  ];
  const changes = directUserBindingChanges(current, "user@example.com", policies, ["tools"]);

  assert.deepEqual(changes.removals.map((binding) => binding.policyId), ["models"]);
  assert.deepEqual(changes.additions.map((binding) => binding.policyId), ["tools"]);
});

test("service outcome and playground blocker require both access and readiness", () => {
  const allowed = services[0];
  assert.equal(serviceOutcome(allowed).label, "usable");
  assert.equal(playgroundBlocker(modelForm(), { id: "openai/default", provider: "openai", capabilities: [] }, undefined, new Map([["openai", allowed.access]]), { openai: allowed.readiness }), null);

  const denied = { ...allowed, access: { ...allowed.access, allowed: false, policies: [] } };
  assert.equal(serviceOutcome(denied).label, "denied");
  assert.match(playgroundBlocker(modelForm(), { id: "openai/default", provider: "openai", capabilities: [] }, undefined, new Map([["openai", denied.access]]), { openai: denied.readiness }), /not granted/);

  const disabled = services[2];
  assert.equal(serviceOutcome(disabled).label, "disabled");
  assert.match(playgroundBlocker(modelForm(), { id: "disabled/default", provider: "disabled-provider", capabilities: [] }, undefined, new Map([["disabled-provider", disabled.access]]), { "disabled-provider": disabled.readiness }), /disabled/);
});

test("readiness tone prioritizes current executability over historical verification", () => {
  assert.equal(readinessTone({ ...services[0].readiness, executable: false, verified: true, status: "disabled" }), "revoked");
  assert.equal(readinessTone({ ...services[0].readiness, executable: true, verified: true }), "active");
  assert.equal(readinessTone({ ...services[0].readiness, executable: true, verified: false }), "neutral");
});

test("playground payloads preserve model and service semantics", () => {
  assert.deepEqual(playgroundPayload(modelForm()), {
    model: "openai/default",
    messages: [
      { role: "system", content: "be concise" },
      { role: "user", content: "hello" },
    ],
    max_tokens: 256,
    temperature: 0.2,
  });

  const route = { provider: "replicate", endpoint: "prediction", route: "/v1/proxy/replicate/prediction", methods: ["GET"], pathParams: ["prediction_id"] };
  const form = { ...modelForm(), mode: "service", serviceMethod: "GET", servicePath: "pred_123", servicePayload: "{\"detail\":true}" };
  assert.deepEqual(playgroundPayload(form, route), {
    method: "GET",
    pathParams: { prediction_id: "pred_123" },
    body: { detail: true },
  });
  assert.equal(playgroundAccessEndpoint(form, route), "/v1/playground/proxy/replicate/prediction");
});

test("budget parsing and fallback summaries keep blocked and wildcard states explicit", () => {
  assert.equal(optionalCurrencyMicros("$1.25"), 1_250_000);
  assert.equal(optionalNumber("0"), 0);
  assert.throws(() => optionalNumber("-1"), /non-negative/);

  const blocked = policyUsageFallback({ policyId: "blocked", enabled: true, providers: ["openai"], monthlyBudgetMicros: 0 });
  assert.equal(blocked.budget.ledger, "blocked");
  assert.equal(blocked.budget.remainingMicros, 0);

  const summaries = tenantSummaryFallback(policies, [
    { credentialId: "models_a", policyId: "models", enabled: true },
    { credentialId: "models_b", policyId: "models", enabled: false },
    { credentialId: "wildcard_a", policyId: "wildcard", enabled: true },
  ]);
  const ops = summaries.find((tenant) => tenant.tenantId === "ops");
  assert.equal(ops?.allProviders, true);
  assert.equal(ops?.policies, 1);
  assert.equal(ops?.activePolicies, 1);
  assert.equal(ops?.keys, 1);
  assert.equal(ops?.activeKeys, 1);
  const openclaw = summaries.find((tenant) => tenant.tenantId === "openclaw");
  assert.equal(openclaw?.policies, 3);
  assert.equal(openclaw?.activePolicies, 2);
  assert.equal(openclaw?.keys, 2);
  assert.equal(openclaw?.activeKeys, 1);
});

function modelForm() {
  return {
    mode: "model",
    model: "openai/default",
    endpoint: "/v1/chat/completions",
    serviceRoute: "",
    serviceMethod: "POST",
    servicePath: "",
    servicePayload: "{}",
    system: "be concise",
    prompt: "hello",
    maxTokens: "256",
    temperature: "0.2",
  };
}

function service(provider, executable, status = executable ? "verified" : "missing_config") {
  const readiness = {
    id: provider,
    displayName: provider,
    class: "test",
    serviceKind: "model_provider",
    requiredConfig: [],
    optionalConfig: [],
    missingConfig: [],
    configPresent: true,
    oauthGrantRequired: false,
    oauthGrantCount: 0,
    openaiCompatible: true,
    manifestRoutes: 0,
    modelCount: 1,
    executable,
    verified: executable,
    status,
    reasons: executable ? [] : [`provider is ${status}`],
  };
  return {
    id: `${provider}:llm`,
    name: provider,
    provider,
    kind: "model_provider",
    category: "test",
    capabilities: ["llm.chat"],
    surfaces: ["/v1/chat/completions"],
    route: "/v1/chat/completions",
    routeCount: 1,
    models: 1,
    modelIds: [`${provider}/default`],
    access: { provider, displayName: provider, serviceKind: "model_provider", allowed: true, policies: ["models"], readiness },
    readiness,
  };
}
