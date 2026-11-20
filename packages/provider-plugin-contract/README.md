# Provider plugin contract

Data-only descriptors, conformance fixtures, package indexes, product/offer
declarations, model capabilities, authentication configuration, endpoints, quotas,
and published tariffs for ClawRouter provider packages. No Worker, filesystem, network, or runtime
dependencies. Validation does not authorize a provider or qualify its execution.

## Build and pack locally

From the ClawRouter repository after installing its frozen workspace dependencies:

```sh
pnpm --filter @clawrouter/provider-plugin-contract build
pnpm --filter @clawrouter/provider-plugin-contract pack --pack-destination /tmp
```

Packing builds the JavaScript and declarations first. The archive includes only
compiled contracts, the service-provider JSON Schema, package metadata, this README, and the MIT license. The
package remains private and is not published to a registry.

## Consume the archive

Install the resulting `.tgz` using your package manager, then import by package
name from ESM JavaScript or TypeScript:

```ts
import {
  parseProviderPluginDescriptor,
  parseProviderConformanceScenario,
  bindingSupportsOperation,
  productSupportsBinding,
  transportForGrant,
  type ProviderBindingGrant,
  type ProviderBindingRequirement,
  type ProviderPluginDescriptor,
  type ProviderPackageIndex,
  type ProviderProduct,
  type ProviderOfferDefinition,
  type AuthScheme,
  type AuthorizationConfig,
  type RefreshConfig,
  type CompiledGrantTransport,
  type ModelPricing,
  type RequestPricing,
  type CompiledEndpoint,
  type CompiledQuotaConfig,
  type ProviderModelDefinition,
  type ProviderModelCatalogRef,
  type NativeDecisionCapabilities,
  type ProviderSnapshot,
  type CompiledProvider,
  type CompiledModel,
} from "@clawrouter/provider-plugin-contract";
```

Node 24 or newer is supported. Consumers do not need TypeScript at runtime,
ClawRouter source files, or a TypeScript loader. The package exports the same
contracts used by ClawRouter's source-based build tools. It does not include the
manifest compiler, package loader, conformance runner, or provider assets.

## Manifest JSON Schema

The archive exports the canonical service-provider v1 schema for editors and
validators that support JSON Schema Draft 2020-12:

```js
import schema from "@clawrouter/provider-plugin-contract/service-provider.schema.json"
  with { type: "json" };
```

Builds copy `providers/_schema/service-provider.schema.json` from the repository
without rewriting it. The schema is a separate export and is not loaded by the
main JavaScript entry point. Building this private workspace package from source
requires the repository layout; using the packed archive does not.

Schema validation checks manifest structure. The ClawRouter compiler still owns
semantic qualification, including supported adapters, endpoint bindings, model
relationships, and pricing constraints. Passing the schema does not establish
provider support or authorize execution.

`ProviderProduct`, its binding and offer selections, and `ProviderOfferDefinition`
are static declarations. `ProviderGrantKind` retains the legacy `api_key`,
`oauth`, and `subscription` credential classifications. Neither declares
protocol support, admission, live entitlement, or an executable offer.

`bindingSupportsOperation`, `productSupportsBinding`, and `transportForGrant`
provide the same static product/transport checks used by ClawRouter. They inspect
compiled declarations and a credential classification without I/O or mutation.
A positive result is compatibility only: the host must still check provider
qualification, credential ownership, policy, entitlement, quota, and budgets.

`AuthScheme`, `AuthorizationConfig`, `RefreshConfig`, `GrantTransportAuth`, and
`CompiledGrantTransport` describe host configuration. They do not store runtime
credentials, perform OAuth exchanges, refresh tokens, or certify setup support.

`ModelPricing`, `RequestPricing`, and their component types describe published
tariffs. They preserve units, nullable rates, provenance, and provider-specific
qualifications. They do not supply policy overrides, compute charges, or certify
that a price is current or applicable to an account.

`CompiledEndpoint`, `ManagedProtocol`, `ManagedFileLinks`, `OutputTokenLimit`, and
`ToolPricing` describe compiled endpoint configuration. They preserve lifecycle
links, formats, limits, and pricing references. They do not validate manifests,
load adapters, or authorize requests.

`CompiledQuotaConfig` and its probe/window types declare where to read quota
observations. `GrantAccount` and `GrantExtraUsage` describe provider-reported
metadata. These types do not poll providers, store credentials, or establish
entitlement, remaining budget, or an admission decision.

`ProviderModelDefinition` includes availability, request-parameter support, and
native endpoint capabilities, including decision protocols. These are compiled
provider facts, not a generic model catalogue or account entitlement.
An optional `catalogRef` names a catalogue provider and exact `modelId` separately
from the router `id` and upstream slug. It is an authored lookup target, not a
validated catalogue match. It supplies no capabilities, prices, or permissions.
`isPublishedMusicInputSupport` checks the existing closed support record; it does
not grant permission to publish input. Request assessment remains host-owned.

`ProviderSnapshot`, `CompiledProvider`, and `CompiledModel` describe the existing
compiled registry, including its provider and model indexes. They do not parse
or validate snapshots, load packages, or admit providers to the running host.
