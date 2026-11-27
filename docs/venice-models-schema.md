# Venice public text catalog declaration

This finite declaration consumes [PR666](https://github.com/openclaw/clawrouter/pull/666),
source `caef197f9da91ab1012e0a50e0f8cf1dd280a60f`, landed as
`a9dccd66bf642ab3d4f61e9dcfbe9c990397c1b7`. Actual exports are
`VENICE_MODELS_FORMAT`, `veniceCatalogRequest(base, signal)`,
`filterVeniceModels(payload, allows)` and `readVeniceModels(response, signal, allows)`.
See [the codec contract](venice-model-catalog.md).

## Exact declaration

Use provider `venice`, every base exactly `https://api.venice.ai/api/v1`, and one
required Bearer `api_key` scheme for private original-grant selection. Declare
one `models.list` capability with methods `[GET]` and one endpoint with explicit
`method: GET`, `path: /models`, paired `venice.models` formats and native proxy
enabled. No endpoint auth override or public-caller flag is added. Alternate
paths, query defaults, caller headers, grant transport, adapter injection and
inference/lifecycle features are rejected. Optional `accept: application/json`
is the only fixed header.

The actual helper owns the fixed `type=text` query and accepts **no credential**.
Shared dispatch must call it with only the canonical base and abort signal;
never forward the selected inference key, caller headers, wallet credentials or
cookies. Router caller authorization and original-grant filtering stay private.

The official [OpenAPI operation](https://github.com/veniceai/api-docs/blob/main/swagger.yaml),
checked 2026-11-03 at blob `37c318af208e3c2e9e46330e7cdde7ab4abfd4c0`, explicitly
lists anonymous and Bearer alternatives for GET `/models`. That primary operation,
not an anonymous HTTP200 observation, qualifies the public upstream constructor.
It does not authorize anonymous router calls or inference access.

## Observations and activation

The native text-list envelope remains strict and bounded. Exact policy filtering
is exercised across all 19 frozen OpenClaw `31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`
IDs from the published codec fixtures. No trait/default alias, fallback seed,
provider substitution, newer model or static model card is added here.

Absent limits, prices, capabilities and privacy facts stay absent. Independent
context/output limits are not serving entitlement. Explicit false flags remain
false. Offline and non-text rows are excluded. Dated deprecation observations
do not establish whether a past-date model is stopped, aliased or still served;
source1 must apply qualified availability and serving-identity rules before
executable discovery. A privacy label is not a cryptographic attestation.

USD and DIEM remain separate native numeric fields. No currency conversion,
account discount, zero cache fallback or executable tariff is derived. Extended
rates retain their independent fields and threshold; an invalid extended
threshold cannot make base rates look complete for long requests.

Seven focused cases compose compiler output with the actual codec: public
header isolation, rejected declarations/transports, all frozen policy identities,
unknown metadata, independent currencies/extended schedules and bounded strict
reading. Existing OpenAI decoding remains unchanged. Source1 owns actual private
caller dispatch/filter/revalidation, stopped-model eligibility and cache/deadline
bounds. Source4 owns YAML and frozen cards after those shared contracts and real
Worker proof; source2/source6 own actual-client and serialized snapshot acceptance.
This compiler slice changes no YAML, generated snapshot, common runtime, account
or deployment and does not activate native discovery.
