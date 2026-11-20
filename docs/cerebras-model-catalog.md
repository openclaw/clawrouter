# Cerebras public model metadata

Frozen source: OpenClaw `31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`,
`extensions/cerebras/provider-catalog.ts` and `pricing-api.ts`. Current primary
qualification: 2026-11-03.

The [public models API](https://inference-docs.cerebras.ai/api-reference/models/public-models)
is separate from the [authenticated models API](https://inference-docs.cerebras.ai/api-reference/models/list-models).
Its native list contains limits, feature flags, deprecation state and per-token
USD price strings. The frozen discovery uses the public endpoint only when the
configured inference service is exactly Cerebras. It must not receive the
inference key or describe a custom proxy's inventory.

`worker/cerebras-model-catalog.ts` exports three focused contracts:

- `cerebrasPublicCatalogRequest(inferenceBaseUrl, signal): Request` constructs
  a fixed GET to `https://api.cerebras.ai/public/v1/models`, with only an Accept
  header, credentials omitted and redirects rejected. Noncanonical services,
  userinfo, alternate ports, query strings and fragments fail without echoing
  their values. A trailing slash on the canonical `/v1` base is accepted.
- `parseCerebrasPublicCatalog(payload, permittedModelIds): CerebrasPublicModel[]`
  projects a native list onto exact upstream IDs already permitted by the
  consumer. It preserves positive safe integer limits and known boolean flags,
  skips deprecated or malformed rows and sorts results. Duplicate authorized
  identities fail instead of allowing row order to overwrite facts. An empty
  catalog is authoritative; static seeds do not revive missing rows.
- `readCerebrasPublicCatalog(response, signal, permittedModelIds)` reuses the
  existing `readNativeJson` reader. It requires complete HTTP 200 JSON, rejects
  redirects/ranges, limits input to 2 MiB and 4,096 rows, and honors the supplied
  abort signal. Errors contain no upstream response or credential material.

Price observations remain exact bounded decimal strings. Missing, malformed or
unsupported price representations stay unknown. Explicit zero is preserved only
when both native input and output observations say zero. No token-rate conversion,
cache-price fallback, account tariff or free-tier inference occurs. Missing
feature flags remain null rather than becoming invented support or rejection.

The [GPT OSS model card](https://inference-docs.cerebras.ai/models/openai-oss)
still qualifies frozen `gpt-oss-120b`, but documents different free/paid context
and output limits. Public limits are metadata observations, not proof of a
selected account's quota. The [deprecation list](https://inference-docs.cerebras.ai/support/deprecation)
does not retire that frozen identity. The existing Qwen seed is preserved by
this code-only PR. A public metadata read during research returned HTTP 403;
no credential was sent and there was no authenticated fallback.

Source1 must call the fixed public request under the discovery deadline, then
feed its complete response and caller-authorized upstream IDs to this reader.
It must keep original grant authorization/revocation and response filtering,
including after a public fetch. Metadata does not select or issue a credential.
Source3 owns mapping observed model facts and qualified tariffs into the common
catalog; source2 owns native client consumption and source6 actual integration
proof. No shared runtime, compiler/types, manifest or snapshot is changed here.

Eighteen deterministic fixtures cover request isolation, projection, missing
facts, row/envelope bounds, fragmented UTF-8, HTTP/JSON/size failures, abort and
native Node module loading without the test resolver.
They prove the codec and reader contract. They do not claim active Worker
refresh, live entitlement, deployment or whole-family parity.
