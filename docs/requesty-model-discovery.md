# Requesty managed model discovery

The Requesty declaration exposes GET on both routes:

- `/v1/native/requesty/models/managed`
- `/v1/proxy/requesty/models_managed`

The endpoint is `models_managed`, capability `models.list`, with paired
`requesty.models_managed` formats. It dispatches only to
`https://router.requesty.ai/v1/models/managed` using the original managed Bearer
key. It accepts no query, body, path parameter, alternate destination, auth
override, stream or lifecycle. Environment credentials cannot replace a missing
or revoked selected owner.

The native `{data}` envelope retains eligible trimmed, deduplicated Chat IDs.
Bare policy names and hosting-prefixed IDs remain distinct; `@` regional IDs
and other APIs are excluded. The common runtime freshly checks the original
owner before fetch and after complete parsing, then intersects admitted model
IDs with current policy. An empty authorized inventory stays empty.

Missing facts remain unknown. Explicit zero/false and raw price representations
remain observations, not executable tariffs, free-service claims or default
limits. Price units and current account rates are unqualified. Discovery does
not add model cards or grant entitlement. Existing Chat, model and auth blocks
are unchanged; EU, BYOK, plans and stream-attribution behavior are outside this
declaration.

Provenance is the frozen OpenClaw revision
`31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`,
`extensions/requesty/provider-catalog.ts` and `provider-models.ts`. The qualified
[codec contract](requesty-managed-catalog-codec.md) preserves its managed-list
projection without copying historical price conversions or fallback limits.

Focused tests compile this exact YAML into the real Worker fixture and exercise
both routes. Committed snapshot integration and actual client qualification are
separate source6/source2 responsibilities; source1 owns shared dispatch and
authority, and source3 owns format validation. No live gateway calls are needed
for the deterministic fixtures.
