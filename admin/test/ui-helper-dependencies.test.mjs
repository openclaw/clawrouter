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
