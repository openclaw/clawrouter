# Provider plugin contract

Data-only descriptors, conformance fixtures, package indexes, product/offer declarations, and authentication configuration
for ClawRouter provider packages. No Worker, filesystem, network, or runtime
dependencies. Validation does not authorize a provider or qualify its execution.

## Build and pack locally

From the ClawRouter repository after installing its frozen workspace dependencies:

```sh
pnpm --filter @clawrouter/provider-plugin-contract build
pnpm --filter @clawrouter/provider-plugin-contract pack --pack-destination /tmp
```

Packing builds the JavaScript and declarations first. The archive includes only
compiled contracts, package metadata, this README, and the MIT license. The
package remains private and is not published to a registry.

## Consume the archive

Install the resulting `.tgz` using your package manager, then import by package
name from ESM JavaScript or TypeScript:

```ts
import {
  parseProviderPluginDescriptor,
  parseProviderConformanceScenario,
  type ProviderPluginDescriptor,
  type ProviderPackageIndex,
  type ProviderProduct,
  type ProviderOfferDefinition,
  type AuthScheme,
  type AuthorizationConfig,
  type RefreshConfig,
  type CompiledGrantTransport,
} from "@clawrouter/provider-plugin-contract";
```

Node 24 or newer is supported. Consumers do not need TypeScript at runtime,
ClawRouter source files, or a TypeScript loader. The package exports the same
contracts used by ClawRouter's source-based build tools. It does not include the
manifest compiler, package loader, conformance runner, or provider assets.

`ProviderProduct`, its binding and offer selections, and `ProviderOfferDefinition`
are static declarations. `ProviderGrantKind` retains the legacy `api_key`,
`oauth`, and `subscription` credential classifications. Neither declares
protocol support, admission, live entitlement, or an executable offer.

`AuthScheme`, `AuthorizationConfig`, `RefreshConfig`, `GrantTransportAuth`, and
`CompiledGrantTransport` describe host configuration. They do not store runtime
credentials, perform OAuth exchanges, refresh tokens, or certify setup support.
