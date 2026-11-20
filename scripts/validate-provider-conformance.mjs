import { pathToFileURL } from "node:url";
import { parseProviderConformanceScenario, PROVIDER_CONFORMANCE_VALIDATION_SCHEMA } from "../packages/provider-plugin-contract/src/index.ts";
import { compileProviderSnapshot } from "./compile-providers.mjs";
import { providerPluginManifest } from "./provider-manifest-inputs.mjs";
import { loadProviderPlugins } from "./provider-plugin-loader.ts";

/**
 * Capture and validate all package inputs once for declaration and execution tooling.
 * No fixture or adapter code is executed.
 */
export function loadProviderConformancePlan(pluginPaths) {
  if (!pluginPaths.length) throw new Error("select at least one provider plugin");
  const plugins = loadProviderPlugins(pluginPaths, { captureFixtures: true });
  const snapshot = compileProviderSnapshot(plugins.map(providerPluginManifest));
  const providers = new Map(snapshot.providers.map(provider => [provider.id, provider]));
  const cases = [];
  const report = {
    schema: PROVIDER_CONFORMANCE_VALIDATION_SCHEMA,
    scope: "declarations",
    packages: plugins.map(plugin => {
      const provider = providers.get(plugin.descriptor.id);
      if (!plugin.fixtureSources.length) throw new Error(`provider conformance ${provider.id}: at least one scenario fixture is required`);
      const ids = new Set();
      const scenarios = plugin.fixtureSources.map(({ path, source }) => {
        const fail = message => { throw new Error(`provider conformance ${provider.id} ${path}: ${message}`); };
        let value;
        try { value = JSON.parse(source); } catch { fail("invalid JSON fixture"); }
        let scenario;
        try { scenario = parseProviderConformanceScenario(value); }
        catch (error) { fail(error.message); }
        if (scenario.providerId !== provider.id) fail("providerId must match the selected plugin");
        if (ids.has(scenario.id)) fail("duplicate scenario ID within the package");
        ids.add(scenario.id);
        const endpoint = provider.endpoints.find(endpoint => endpoint.id === scenario.endpoint);
        if (!endpoint) fail("endpoint is not declared by the provider");
        const capabilities = provider.capabilities.filter(capability => capability.id === scenario.capability && capability.endpoint === endpoint.id);
        if (!capabilities.length) fail("capability is not declared for this endpoint");
        const method = scenario.upstream.request.method;
        if (!endpoint.methods.includes(method) || !capabilities.some(capability => capability.methods.includes(method))) fail("upstream method is not declared for this endpoint and capability");
        if (scenario.model !== undefined) {
          const model = provider.models.find(model => model.id === scenario.model);
          if (!model) fail("model must reference an exact declared router model ID");
          if (!model.capabilities.includes(scenario.capability)) fail("model does not declare this capability");
        }
        cases.push({ provider, scenario });
        return { id: scenario.id, fixture: path, endpoint: scenario.endpoint, capability: scenario.capability,
          ...(scenario.model !== undefined ? { model: scenario.model } : {}) };
      }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      return { id: provider.id, version: plugin.descriptor.version, digest: plugin.digest, scenarios };
    }),
  };
  return { report, snapshot, cases };
}

/** Authored-reference report only; the captured execution plan stays internal to tooling. */
export function validateProviderConformance(pluginPaths) {
  return loadProviderConformancePlan(pluginPaths).report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2), pluginPaths = [];
  for (let i = 0; i < args.length; i += 2) {
    if (args[i] !== "--plugin" || !args[i + 1] || args[i + 1].startsWith("--")) {
      throw new Error("usage: validate-provider-conformance --plugin descriptor [--plugin descriptor...]");
    }
    pluginPaths.push(args[i + 1]);
  }
  process.stdout.write(`${JSON.stringify(validateProviderConformance(pluginPaths), null, 2)}\n`);
}
