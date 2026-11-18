import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(import.meta.url);
const typescript = require.resolve("typescript/package.json");
const tsc = resolve(dirname(typescript), JSON.parse(readFileSync(typescript, "utf8")).bin.tsc);

test("packed plugin contract runs and typechecks outside the repository", t => {
  const root = mkdtempSync(join(tmpdir(), "provider-plugin-package-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "source"), consumer = join(root, "consumer");
  cpSync(join(repo, "packages/provider-plugin-contract"), source, {
    recursive: true, filter: path => !["node_modules", "dist"].includes(path.split(/[\\/]/).at(-1)),
  });
  // Use the host's pinned build tool only. Neither source nor dependencies ship to the consumer.
  execFileSync("pnpm", ["pack", "--pack-destination", root], {
    cwd: source, encoding: "utf8", timeout: 30_000, stdio: "pipe",
    env: { ...process.env, PATH: `${join(repo, "node_modules/.bin")}${delimiter}${process.env.PATH ?? ""}` },
  });
  const archives = readdirSync(root).filter(name => name.endsWith(".tgz"));
  assert.equal(archives.length, 1);
  const installed = join(consumer, "node_modules/@clawrouter/provider-plugin-contract");
  mkdirSync(installed, { recursive: true });
  execFileSync("tar", ["-xzf", join(root, archives[0]), "--strip-components=1", "-C", installed], { timeout: 30_000 });
  const files = readdirSync(installed, { recursive: true }).map(name => name.replaceAll("\\", "/")).sort();
  assert.deepEqual(files.filter(name => name !== "dist"), [
    "LICENSE", "README.md", "dist/auth.d.ts", "dist/auth.js", "dist/conformance.d.ts", "dist/conformance.js", "dist/models.d.ts", "dist/models.js", "dist/model-availability.d.ts", "dist/model-availability.js", "dist/model-request-parameters.d.ts", "dist/model-request-parameters.js", "dist/native-capabilities.d.ts", "dist/native-capabilities.js", "dist/endpoints.d.ts", "dist/endpoints.js", "dist/index.d.ts", "dist/index.js",
    "dist/observations.d.ts", "dist/observations.js", "dist/quota.d.ts", "dist/quota.js", "dist/package-index.d.ts", "dist/package-index.js", "dist/pricing.d.ts", "dist/pricing.js", "dist/product-metadata.d.ts", "dist/product-metadata.js", "dist/products.d.ts", "dist/products.js", "package.json",
  ].sort());
  const manifest = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
  assert.deepEqual(manifest.dependencies ?? {}, {});
  assert.equal(manifest.private, true, "local packaging must not enable registry publication");
  writeFileSync(join(consumer, "package.json"), '{"type":"module"}\n');
  writeFileSync(join(consumer, "smoke.mjs"), `
import assert from "node:assert/strict";
import { parseProviderPluginDescriptor, providerPluginFiles, ProviderPluginContractError,
  isPublishedMusicInputSupport, parseProviderConformanceScenario, PROVIDER_PLUGIN_SCHEMA, PROVIDER_CONFORMANCE_SCHEMA } from "@clawrouter/provider-plugin-contract";
const descriptor = parseProviderPluginDescriptor({ schema: PROVIDER_PLUGIN_SCHEMA, id: "example", version: "1.0.0",
  manifest: "example.provider.yaml", documentation: "README.md", license: "LICENSE" });
assert.deepEqual(providerPluginFiles(descriptor), ["LICENSE", "README.md", "example.provider.yaml"]);
assert.throws(() => parseProviderPluginDescriptor({}), ProviderPluginContractError);
assert.equal(typeof parseProviderConformanceScenario, "function");
assert.equal(PROVIDER_CONFORMANCE_SCHEMA, "clawrouter.provider-conformance.v1");
assert.equal(isPublishedMusicInputSupport({}), false);
`);
  execFileSync(process.execPath, ["smoke.mjs"], { cwd: consumer, encoding: "utf8", timeout: 30_000 });
  writeFileSync(join(consumer, "consumer.ts"), `
import { parseProviderPluginDescriptor, type ProviderPluginDescriptor, type ProviderPackageIndex,
  type GrantQuotaKind, type CompiledQuotaWindow, type CompiledQuotaProbeWindow, type CompiledQuotaProbe, type CompiledQuotaConfig, type GrantAccount, type GrantExtraUsage,
  type ProviderModelDefinition, type ModelAvailability, type ProviderReasoningEffort, type ParameterSupport, type ModelRequestParameters, type OpenAiDecisionCapabilities, type BasetenSystemOneDecisionCapabilities, type SageDecisionCapabilities, type NativeDecisionCapabilities, type OpaquePcmSpeechProfile, type InlineMusicReferenceImage, type PublishedMusicInputSupport, type NativeEndpointCapabilities, type NativeModelCapabilities,
  type ManagedProtocol, type ManagedFileLinks, type OutputTokenLimit, type ToolPricing, type CompiledEndpoint,
  type TokenRates, type LongContextPricing, type ServiceTierPricing, type AnthropicPriceModifiers, type TokenPricing, type CharacterPricing, type ImageTokenPricing, type ModelPricing, type SuccessfulRequestPricing, type OutcomeRequestPricing, type ImageRequestPricing, type DeepSeekSearchRequestPricing, type RequestPricing,
  type AuthScheme, type AuthorizationConfig, type RefreshConfig, type GrantTransportAuth, type CompiledGrantTransport,
  type ProviderProductSummary, type ProviderGrantKind, type ProviderProduct, type ProviderProductBinding,
  type ProviderProductOffer, type ProviderOfferDefinition, type ProviderOfferReference, type ProviderConformanceScenario, type ProviderConformanceExecution,
  type ProviderConformanceValidation } from "@clawrouter/provider-plugin-contract";
const descriptor: ProviderPluginDescriptor = parseProviderPluginDescriptor({});
const product: ProviderProductSummary = { id: "api", displayName: "API", commercialModel: "metered", authenticationMethod: "api-key" };
const apiKey: AuthScheme = { type: "api_key", header: "x-api-key", secretKind: "api_key" };
const transportAuth: GrantTransportAuth = { type: "bearer", header: "authorization", format: "Bearer \${secret}" };
const transport: CompiledGrantTransport = { baseUrl: null, auth: transportAuth, endpointPaths: {},
  headers: {}, appendHeaders: {}, requestTransforms: { prependSystem: [] }, maintenance: { quotaPoll: null, keepWarm: null } };
declare const authorization: AuthorizationConfig;
declare const refresh: RefreshConfig;
// @ts-expect-error Header authentication must name the host-owned secret kind.
const invalidAuth: AuthScheme = { type: "api_key", header: "x-api-key" };
const freeCharacters: CharacterPricing = { unit: "character", effectiveAt: "2026-01-01", source: "https://example.invalid/pricing", inputMicrosPerMillionCharacters: 0, maxInputCharacters: 1000 };
const modelPrice: ModelPricing = freeCharacters;
const requestPrice: RequestPricing = { unit: "request", version: "1", effectiveAt: "2026-01-01", source: "https://example.invalid/pricing", successfulResponseMicros: 0 };
// @ts-expect-error Request tariffs cannot use token-price units.
const invalidPrice: SuccessfulRequestPricing["unit"] = "token";
// @ts-expect-error A nullable cached rate does not make the input rate optional.
const invalidRate: TokenRates["inputMicrosPerMillion"] = null;
const fileLinks: ManagedFileLinks = { mode: "download_only", download: "download" };
const endpoint: CompiledEndpoint = { id: "invoke", method: "POST", methods: ["POST"], path: "/invoke",
  native_proxy: true, auth: null, headers: {}, request_headers: [], response_headers: [], query: {},
  path_params: [], path_param_styles: {}, request_format: "native.json", response_format: "native.json",
  streaming: null, timeout_ms: null, lifecycle: { protocol: "replicate.predictions", retrieve: "get", files: fileLinks },
  requestPricing: requestPrice, modelPassthrough: { pricing_ref: null, pricing: null } };
// @ts-expect-error Download-only links do not expose a metadata endpoint.
const invalidLinks: ManagedFileLinks = { mode: "download_only", metadata: "get", download: "download" };
// @ts-expect-error Lifecycle protocols are a finite compiled contract.
const invalidProtocol: ManagedProtocol = "custom.jobs";
const account: GrantAccount = { displayName: "Synthetic account", extraUsageEnabled: false };
const extraUsage: GrantExtraUsage = { usedCredits: 0, spendLimitReached: false };
const quota: CompiledQuotaConfig = { responseHeaders: [], probes: [{ grantKinds: ["oauth"], requiresRefreshToken: false,
  url: "https://example.invalid/quota", method: "GET", headers: {}, windows: [],
  facts: { account: { displayName: "/name" }, extraUsage: { usedCredits: "/used" } } }] };
// @ts-expect-error Quota extraction is limited to declared account metadata fields.
const invalidAccountFacts: NonNullable<CompiledQuotaProbe["facts"]>["account"] = { accessToken: "/token" };
// @ts-expect-error Credential classifications are not quota measurement kinds.
const invalidQuotaKind: GrantQuotaKind = "oauth";
const availability: ModelAvailability = { version: "clawrouter.model-availability.v1", effectiveAt: "2026-01-01",
  checkedAt: "2026-01-01", sources: [], status: "upstream_alias", servingModel: "serving-model" };
const decision: OpenAiDecisionCapabilities = { protocol: "openai-decisions", questions: {
  boolean: { probabilities: "boolean", abstention: true } }, limits: { maxQuestions: 16 } };
const model: ProviderModelDefinition = { id: "example/model", upstream: "model", capabilities: ["inference.decision"],
  pricing_ref: null, pricing: null, availability, supportedReasoningEfforts: ["low", "high"],
  requestParameters: { invoke: { sources: [], checkedAt: "2026-01-01", temperature: "requires_reasoning_none" } },
  nativeCapabilities: { version: "clawrouter.native-capabilities.v1", endpoints: {
    invoke: { sources: [], checkedAt: "2026-01-01", inference: { decision } } } } };
// @ts-expect-error An upstream alias must name its serving model.
const invalidAvailability: ModelAvailability = { version: "clawrouter.model-availability.v1", effectiveAt: "2026-01-01", checkedAt: "2026-01-01", sources: [], status: "upstream_alias" };
// @ts-expect-error Request-parameter support is a finite qualification vocabulary.
const invalidParameterSupport: ParameterSupport = "maybe";
const kind: ProviderGrantKind = "subscription";
const binding: ProviderProductBinding = { type: "grant-transport", grantKind: kind };
const selection: ProviderProductOffer = { endpoint: "invoke", capability: "tool.invoke", models: null };
const fullProduct: ProviderProduct = { ...product, binding, endpoints: ["invoke"], offers: [selection] };
const definition: ProviderOfferDefinition = { id: "offer", providerId: "example", productId: product.id,
  endpoint: "invoke", capability: "tool.invoke", model: null, qualification: "declared" };
const reference: ProviderOfferReference = { id: definition.id, productId: definition.productId };
// @ts-expect-error Protocol labels cannot be used as credential classifications.
const invalidKind: ProviderGrantKind = "rest";
// @ts-expect-error Authored offers cannot claim runtime qualification.
const invalidQualification: ProviderOfferDefinition["qualification"] = "eligible";
const index: ProviderPackageIndex = { schema: "clawrouter.provider-package-index.v1", packages: [] };
declare const scenario: ProviderConformanceScenario;
declare const validation: ProviderConformanceValidation;
declare const execution: ProviderConformanceExecution;
export { model, decision, availability, account, extraUsage, quota, endpoint, fileLinks, modelPrice, requestPrice, descriptor, product, apiKey, transport, authorization, refresh, kind, binding, selection, fullProduct, definition, reference, index, scenario, validation, execution };
`);
  writeFileSync(join(consumer, "tsconfig.json"), JSON.stringify({
    compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", lib: ["ES2022"], types: [], strict: true, noEmit: true },
    files: ["consumer.ts"],
  }));
  execFileSync(process.execPath, [tsc, "--project", "tsconfig.json"], { cwd: consumer, encoding: "utf8", timeout: 30_000, stdio: "pipe" });
});
