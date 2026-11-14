# Requesty managed catalog compiler contract

This foundation consumes the qualified [managed catalog codec](requesty-managed-catalog-codec.md)
from [PR808](https://github.com/openclaw/clawrouter/pull/808), squash
`aef09502cf9726adab59827fdf4dc22da7ba62ba`. It adds no provider declaration,
model facts, shared runtime, generated snapshot or activation proof.

The exact endpoint ID is `models_managed`; its sole capability is `models.list`
with GET-only methods. Both request and response formats are
`requesty.models_managed`. The path is `/models/managed` under the canonical
`https://router.requesty.ai/v1` base. Native exposure is enabled, yielding
`/v1/native/requesty/models/managed`; the manifest route is
`/v1/proxy/requesty/models_managed`.

The compiler preserves the existing `CompiledEndpoint` fields: `request_format`,
`response_format`, `path`, `native_proxy: true`, `path_params: []`, `query: {}`,
`auth: null` and `streaming: null`. Omitted or empty path parameters are equivalent;
streaming is omitted in YAML. No new shared field or alias is introduced.

The schema and finite semantic validator reject a different pair, selector,
origin, path, method, nonempty query/path parameters, auth override, caller header,
streaming, WebSocket, lifecycle, passthrough, input profile or inference tariff.
Only original Bearer API-key binding qualifies. Existing Requesty Chat models,
prices, authentication and adapter declarations remain unchanged. The catalog
operation does not become a model capability or establish account entitlement.

The actual factory receives the selected original key and signal. Its result is
native `{data: RequestyModelRow[]}`, not an OpenAI list or normalized fact array.
Missing costs and limits remain unknown, and an empty authorized inventory stays
empty. Observed prices are not converted into an executable inference tariff.

Source1 retains format dispatch, authentication before reads, body/query denial,
original-owner revalidation, current-policy intersection and bounded response
lifetime. The focused tests compose existing guards and the actual factory/reader;
they do not prove activated HTTP dispatch. Source4 owns subsequent Requesty YAML,
source2 the actual client and source6 serialized snapshot/consumer qualification.
