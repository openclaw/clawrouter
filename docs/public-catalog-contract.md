# Public catalog projections

This compiler contract reserves two manifest-only metadata operations. It does
not activate a provider declaration, native route or generated snapshot.

| Provider | Request and response format | Canonical inference base |
| --- | --- | --- |
| Cerebras | `cerebras.public_catalog` | `https://api.cerebras.ai/v1` |
| NVIDIA | `nvidia.public_catalog` | `https://integrate.api.nvidia.com/v1` |

Both declarations use endpoint ID `public_models`, capability `models.list`,
`method: GET`, `path: /models` and **`nativeProxy: false`**. The existing manifest
caller route is `POST /v1/proxy/{provider}/public_models`; the endpoint's GET is
its operation method. `/models` selects the operation and is never used to
construct an upstream URL. No new compiled field is needed. No model card gains
`models.list`, and no native or OpenAI-compatible catalog alias is implied.

The manifest envelope has no upstream body, model, path parameter or query.
Common dispatch must reject caller overrides, including headers and transport
selection, before any fetch. The compiler rejects endpoint authentication,
upstream-path overrides, streaming, lifecycle, pricing and input-profile fields;
it also rejects provider credential injection, request renaming and alternate
transport origins. The original private caller still requires the selected
provider's API-key grant. Public metadata access does not qualify that key for
inference or establish account entitlement.

## Fixed requests and output

Use the existing factories and bounded readers unchanged:

- Cerebras: `cerebrasPublicCatalogRequest` and `readCerebrasPublicCatalog` in
  `worker/cerebras-model-catalog.ts`, from [PR568](https://github.com/openclaw/clawrouter/pull/568).
  The sole URL is `https://api.cerebras.ai/public/v1/models`.
- NVIDIA: `nvidiaPublicCatalogRequests` and `readNvidiaPublicCatalog` in
  `worker/nvidia-model-catalog.ts`, from [PR572](https://github.com/openclaw/clawrouter/pull/572).
  A successful operation fetches both
  `https://integrate.api.nvidia.com/v1/models` and
  `https://assets.ngc.nvidia.com/products/api-catalog/featured-models.json`.
  Authority, cancellation or a fetch failure may stop earlier; there is no
  invented single upstream catalog API.

Both factories use GET with JSON Accept, omitted credentials and rejected
redirects. Never forward an inference credential, switch to an authenticated
fallback or accept a caller-selected URL.

[PR779](https://github.com/openclaw/clawrouter/pull/779), published helper pin
`98d6171093add7cc3b307b6c7e98a2847ef3a03c`, defines the shared
`fetchPublicModelDiscovery` result as a discriminated `{ providerId, catalog }`
union. For these two providers, **`catalog` remains a normalized fact array**,
not an OpenAI `{ object: "list", data: [...] }` envelope. Chutes and Venice keep
their separate native envelope shapes. The helper is a runtime dependency;
this compiler change neither copies it nor registers its dispatch.

Cerebras retains exact decimal-string price observations and null unknown flags
or prices. NVIDIA retains `metadataSource`, null pricing and `outputTokenBudget`
as a catalog default, not an account maximum. Neither projection converts units,
creates an admitted tariff, changes a model card or establishes entitlement.
The existing [Cerebras](cerebras-model-catalog.md) and
[NVIDIA](nvidia-model-catalog.md) contracts define the bounded row semantics.

An authoritative empty result stays empty. It cannot revive cached, static or
featured rows. In NVIDIA's paired reader, an empty valid inventory wins even
when featured parsing fails; that does not turn an interrupted fetch or failed
authority check into a successful empty response.

## Runtime qualification boundary

Common runtime owns exact format registration, manifest-only mode enforcement,
private caller authentication and original-grant revalidation. It must use one
original `HttpOperation` deadline, revalidate before each physical fetch and
after parsing before publication, filter exact caller-permitted upstream IDs,
and return private/no-store metadata. Tests of the factories and readers do not
prove those HTTP authority guarantees.

`worker/test/public-catalog-compiler.test.mjs` supplies eleven focused cases for
compiler restrictions, catalog shape, existing input guards and actual reader
composition. Provider YAML and snapshots remain unchanged until the separately
owned runtime has qualified its dispatch and authority tests.
