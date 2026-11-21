import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "vite";

async function loadHeadlessModule(name) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const bundle = await build({
    root, configFile: false, publicDir: false, logLevel: "error",
    build: { write: false, ssr: true, minify: false, rollupOptions: {
      input: root + "src/" + name + ".ts",
    } },
  });
  const chunk = bundle.output.find((entry) => entry.type === "chunk" && entry.isEntry);
  assert.ok(chunk);
  for (const id of Object.keys(chunk.modules)) {
    assert.doesNotMatch(id, /\/(?:components\.tsx|ui-config\.ts|node_modules\/react\/)/);
  }
  assert.ok(!chunk.imports.some((id) => id === "react" || id.startsWith("react/")));
  return import("data:text/javascript;base64," + Buffer.from(chunk.code).toString("base64"));
}

test("plain UI helpers load without React components or browser initialization", async () => {
  const helpers = await loadHeadlessModule("ui-helpers");
  assert.equal(helpers.formatCount(1234), "1,234");
  const providers = [
    { id: "search", display_name: "Search", service_kind: "search", capabilities: [] },
    { id: "model", display_name: "Model", service_kind: "model_provider", capabilities: [] },
    { id: "gateway", display_name: "Gateway", service_kind: "gateway_platform", capabilities: [] },
  ];
  assert.deepEqual(helpers.groupedProviders(providers, "").map((group) => group.kind), ["gateway_platform", "model_provider", "search"]);
});

test("demo data owns its configuration without importing browser initialization", async () => {
  const { demoData } = await loadHeadlessModule("demo-data");
  const data = demoData();
  assert.deepEqual(data.connections.filter((connection) => !connection.enabled).map((connection) => connection.providerId).sort(), ["aws-bedrock", "cloudflare-ai-gateway"]);
  assert.equal(data.entitlements.providers.find((provider) => provider.provider === "azure-openai").readiness.status, "missing_config");
});

test("user demo projection keeps the selected user's presentation separate", async () => {
  const { demoData, projectUserDemo } = await loadHeadlessModule("demo-data");
  const data = demoData(), original = JSON.stringify(data);
  const user = data.users.find((candidate) => candidate.email === "research@example.com");
  const personal = projectUserDemo(data, user);
  assert.equal(personal.entitlements.session.email, user.email);
  assert.deepEqual(personal.policyIds, ["user_research"]);
  assert.deepEqual(personal.credentials.map((credential) => credential.credentialId), ["research_notebook"]);
  assert.deepEqual(personal.entitlements.providers.filter((provider) => provider.allowed).map((provider) => provider.provider).sort(), ["google-gemini", "openai", "tavily"]);
  assert.equal(JSON.stringify(data), original);
});

test("demo timelines preserve scoped totals and UTC days", async (t) => {
  const now = Date.UTC(2026, 5, 24, 18), dayMs = 86_400_000;
  t.mock.method(Date, "now", () => now);
  const { demoData, projectUserDemo } = await loadHeadlessModule("demo-data");
  const data = demoData();
  const sparse = structuredClone(data);
  for (const provider of sparse.usage.providers) {
    Object.assign(provider, { requestCount: 10, successCount: 9, errorCount: 1, totalTokens: 100, actualCostMicros: 500, unpricedRequestCount: 3 });
  }
  const empty = structuredClone(data);
  for (const provider of empty.usage.providers) {
    Object.assign(provider, { requestCount: 0, successCount: 0, errorCount: 0, totalTokens: 0, actualCostMicros: 0, unpricedRequestCount: 0 });
  }
  const snapshots = [data.usage, ...[data, sparse, empty].flatMap((source) => source.users.map((user) => projectUserDemo(source, user).usage))];
  for (const { summary, daily } of snapshots) {
    assert.equal(daily.length, 30);
    assert.deepEqual(daily.map((point) => point.dayStartMs), Array.from({ length: 30 }, (_, index) => Math.floor(now / dayMs) * dayMs - (29 - index) * dayMs));
    for (const field of ["requestCount", "successCount", "errorCount", "totalTokens", "actualCostMicros", "unpricedRequestCount"]) {
      assert.equal(daily.reduce((total, point) => total + point[field], 0), summary[field] ?? 0, field);
    }
  }
});
