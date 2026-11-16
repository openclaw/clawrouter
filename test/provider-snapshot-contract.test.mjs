import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(import.meta.url);
const packagePath = require.resolve("typescript/package.json");
const tsc = resolve(dirname(packagePath), JSON.parse(readFileSync(packagePath, "utf8")).bin.tsc);

function compile(root, name, compilerOptions, files) {
  const config = join(root, `${name}.json`);
  writeFileSync(config, JSON.stringify({ compilerOptions, files }));
  execFileSync(process.execPath, [tsc, "--project", config], { cwd: root, encoding: "utf8", timeout: 30_000, stdio: "pipe" });
}

test("compiled provider declarations build and typecheck without client or Worker contracts", t => {
  const root = mkdtempSync(join(tmpdir(), "provider-snapshot-contract-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const output = join(root, "declarations");
  const options = { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", lib: ["ES2022"],
    types: [], strict: true, allowImportingTsExtensions: true };
  compile(root, "build", { ...options, declaration: true, emitDeclarationOnly: true, rootDir: repo, outDir: output },
    [join(repo, "shared/provider-snapshot.ts"), join(repo, "shared/request-pricing.ts")]);
  const files = readdirSync(output, { recursive: true }).map(file => file.replaceAll("\\", "/"));
  assert.ok(files.includes("shared/provider-snapshot.d.ts"));
  assert.ok(files.includes("shared/provider-model.d.ts"));
  assert.ok(!files.includes("shared/contracts.d.ts"), "the client API must not own compiled-provider declarations");
  assert.ok(!files.some(file => /^(worker|admin)\//.test(file)), "the declaration graph must not depend on a runtime host");

  // This consumer imports emitted declarations without repository ambient types.
  const consumer = join(root, "consumer.ts");
  writeFileSync(consumer, `
import type { AuthScheme as LegacyAuth, AuthorizationConfig as LegacyAuthorization, RefreshConfig as LegacyRefresh, GrantTransportAuth as LegacyTransportAuth, CompiledGrantTransport as LegacyTransport, GrantKind, ProviderSnapshot, CompiledProvider, CompiledQuotaProbe } from "./declarations/shared/provider-snapshot.js";
import type { GrantAccount, GrantExtraUsage } from "./declarations/shared/provider-observations.js";
import type { ProviderProduct as LegacyProduct } from "./declarations/shared/provider-products.js";
import type { ProviderGrantKind, ProviderProduct } from "./declarations/packages/provider-plugin-contract/src/products.js";
import type { AuthScheme, AuthorizationConfig, RefreshConfig, GrantTransportAuth, CompiledGrantTransport } from "./declarations/packages/provider-plugin-contract/src/auth.js";
import type { TokenRates as LegacyTokenRates, LongContextPricing as LegacyLongContextPricing, ServiceTierPricing as LegacyServiceTierPricing, AnthropicPriceModifiers as LegacyAnthropicPriceModifiers, TokenPricing as LegacyTokenPricing, CharacterPricing as LegacyCharacterPricing, ImageTokenPricing as LegacyImageTokenPricing, ModelPricing as LegacyModelPricing } from "./declarations/shared/provider-model.js";
import type { SuccessfulRequestPricing as LegacySuccessfulRequestPricing, OutcomeRequestPricing as LegacyOutcomeRequestPricing, ImageRequestPricing as LegacyImageRequestPricing, DeepSeekSearchRequestPricing as LegacyDeepSeekSearchRequestPricing, RequestPricing as LegacyRequestPricing } from "./declarations/shared/request-pricing.js";
import type { TokenRates, LongContextPricing, ServiceTierPricing, AnthropicPriceModifiers, TokenPricing, CharacterPricing, ImageTokenPricing, ModelPricing, SuccessfulRequestPricing, OutcomeRequestPricing, ImageRequestPricing, DeepSeekSearchRequestPricing, RequestPricing } from "./declarations/packages/provider-plugin-contract/src/pricing.js";
declare const portablePricing: [TokenRates, LongContextPricing, ServiceTierPricing, AnthropicPriceModifiers, TokenPricing, CharacterPricing, ImageTokenPricing, ModelPricing, SuccessfulRequestPricing, OutcomeRequestPricing, ImageRequestPricing, DeepSeekSearchRequestPricing, RequestPricing];
const legacyPricing: [LegacyTokenRates, LegacyLongContextPricing, LegacyServiceTierPricing, LegacyAnthropicPriceModifiers, LegacyTokenPricing, LegacyCharacterPricing, LegacyImageTokenPricing, LegacyModelPricing, LegacySuccessfulRequestPricing, LegacyOutcomeRequestPricing, LegacyImageRequestPricing, LegacyDeepSeekSearchRequestPricing, LegacyRequestPricing] = portablePricing;
const roundTripPricing: typeof portablePricing = legacyPricing;
import type { ManagedProtocol as LegacyManagedProtocol, ManagedFileLinks as LegacyManagedFileLinks, OutputTokenLimit as LegacyOutputTokenLimit, ToolPricing as LegacyToolPricing, CompiledEndpoint as LegacyCompiledEndpoint } from "./declarations/shared/provider-snapshot.js";
import type { ManagedProtocol, ManagedFileLinks, OutputTokenLimit, ToolPricing, CompiledEndpoint } from "./declarations/packages/provider-plugin-contract/src/endpoints.js";
declare const portableEndpoints: [ManagedProtocol, ManagedFileLinks, OutputTokenLimit, ToolPricing, CompiledEndpoint];
const legacyEndpoints: [LegacyManagedProtocol, LegacyManagedFileLinks, LegacyOutputTokenLimit, LegacyToolPricing, LegacyCompiledEndpoint] = portableEndpoints;
const roundTripEndpoints: typeof portableEndpoints = legacyEndpoints;
declare const portableAuth: [AuthScheme, AuthorizationConfig, RefreshConfig, GrantTransportAuth, CompiledGrantTransport];
const legacyAuth: [LegacyAuth, LegacyAuthorization, LegacyRefresh, LegacyTransportAuth, LegacyTransport] = portableAuth;
const roundTripAuth: typeof portableAuth = legacyAuth;
declare const portableProduct: ProviderProduct;
declare const portableKind: ProviderGrantKind;
const legacyProduct: LegacyProduct = portableProduct;
const legacyKind: GrantKind = portableKind;
const roundTripProduct: ProviderProduct = legacyProduct;
const roundTripKind: ProviderGrantKind = legacyKind;
declare const snapshot: ProviderSnapshot;
const provider: CompiledProvider = snapshot.providers[0];
const facts: NonNullable<CompiledQuotaProbe["facts"]> = { account: { email: "/email" }, extraUsage: { currency: "/currency" } };
const account: GrantAccount = { displayName: "Synthetic account", extraUsageEnabled: false };
const usage: GrantExtraUsage = { usedCredits: 0, spendLimitReached: false };
export { roundTripEndpoints, roundTripPricing, provider, facts, account, usage, roundTripAuth, roundTripProduct, roundTripKind };
`);
  compile(root, "consumer", { ...options, noEmit: true }, [consumer]);
});
