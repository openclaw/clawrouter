# Baseten native model discovery

Frozen source: OpenClaw `31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`,
`extensions/baseten/models.ts`, `index.ts`, `models.test.ts` and `index.test.ts`.
Primary qualification: 2026-11-03. The [Model APIs documentation](https://docs.baseten.co/inference/model-apis/overview#list-available-models)
documents `GET https://inference.baseten.co/v1/models` with a Baseten Bearer key.
This is the inference service's catalog, not the management API or a dedicated
deployment. No anonymous access or account entitlement is inferred.

The frozen actual discovery fixture returns `{data:[...]}` without an OpenAI
root object tag; row object tags are optional in the frozen parser. Preserve
that native shape through a focused `baseten.models` contract. Do not loosen
the existing strict `openai.models` decoder or relabel this response as its list.

## Published exports

`worker/baseten-model-catalog.ts` exports:

- `BASETEN_MODELS_FORMAT = "baseten.models"` names this focused contract. The
  constant alone does not register the format in the compiler or Worker.
- `basetenCatalogRequest(inferenceBaseUrl, selectedApiKey, signal): Request`
  accepts only the canonical inference `/v1` base, with an optional trailing
  slash, and the original selected credential. It constructs one fixed GET,
  omits browser credentials, forbids redirects and inherits the supplied abort
  signal. Alternate origins/products, userinfo, query strings, fragments,
  traversal spellings and invalid header values fail without echoing inputs.
- `filterBasetenModels(payload, allows): BasetenModelCatalog` validates at most
  4,096 rows, exact bounded IDs and unique identities. It preserves the data-only
  envelope and optional valid list/model tags, applies the original policy/grant
  predicate and excludes the entire `decision-models/` namespace from Chat
  discovery. Non-model rows are skipped. Unsupported root/error/pagination
  shapes fail rather than becoming a successful partial or empty inventory.
- `readBasetenModels(response, signal, allows): Promise<BasetenModelCatalog>`
  uses the existing complete JSON reader with a 2 MiB limit, HTTP 200, strict
  JSON MIME/UTF-8, length/range/redirect checks and cancellation. No rows publish
  before EOF. An authorized empty catalog stays empty; failures never seed it.

Rows expose only `id`, optional `object`, `name`, `context_length`,
`max_completion_tokens`, `supported_features` and three independent native
`pricing` observations: `prompt`, `completion`, `input_cache_read`. Unknown
fields are removed. Missing or invalid optional facts remain absent. Numeric
limit strings must represent positive safe integers. Valid price strings and
numbers retain their native values; no currency/unit assertion, conversion,
cache-write default or tariff is produced. Explicit zero survives only as an
actual field observation.

Baseten explicitly warns that catalog limits can differ from enforced serving
limits. Keep both native limit observations independent, even when output is
larger than context; neither becomes an admission limit automatically. Sparse
feature lists do not borrow vision, reasoning-effort or tools from a static
model card. Separately qualified static facts remain separate evidence.

## Integration handoff

Source3 must publish focused `baseten.models` request/response validation for a
bodyless GET `/models`; source1 must publish matching discovery dispatch using
`filterBasetenModels` and its existing bounded response/deadline path. The
endpoint uses `https://inference.baseten.co/v1` and needs no path remapping.
Both must be available before source4 activates the provider declaration and
actual Worker fixtures. Do not substitute `openai.models` or infer support from
another native format's registration.

Source1 retains original credential/grant selection, request authorization,
revocation, byte/scan/deadline guards, caching and executable-model eligibility.
The callback must include stopped-model exclusion; a permissive upstream list
cannot revive a stopped router identity. The frozen client requests a ten-second
refresh timeout and five-minute metadata cache; this helper has no cache and
does not change authorization freshness. Metadata presence is not entitlement.
The complete `decision-models/` Chat exclusion must also hold in the existing
opaque Chat selection path, beyond the three known decision rows in PR620.

Source2 owns actual native client catalog consumption. Source6 owns serialized
provider snapshot integration and actual Worker/client acceptance. The six
frozen Chat declarations remain in [PR620](https://github.com/openclaw/clawrouter/pull/620);
SystemOne codec/schema/wrapper are separate from this discovery surface. No
shared module, provider YAML, snapshot, live credential, deployment or commercial
account changes are part of this codec slice.

Twenty-two deterministic cases cover canonical credential binding, native
shape/filtering, decision namespace separation, unknown facts/prices, malformed
and oversized responses, fragmented UTF-8, complete EOF, cancellation and actual
native Node module loading without the test resolver. These prove the focused
codec boundary when run; they do not activate common discovery or establish
live entitlement.
