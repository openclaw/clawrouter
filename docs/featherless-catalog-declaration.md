# Featherless keyed complete-catalog declaration

This local candidate adds only a metadata capability and endpoint to the existing
Featherless manifest. All existing model, pricing, request-parameter, native
capability, Chat, authentication, routing and billing blocks are preserved.
No model roster, compatibility fallback or tariff is introduced.

## Exact endpoint

The endpoint is `catalog`, capability `models.list`, `method: GET`, `path: /models`,
paired request/response format `featherless.catalog`, and `nativeProxy: false`.
The caller uses bodyless, query-free `GET /v1/proxy/featherless/catalog`. The
operation deadline is 10 seconds; each physical page remains inside that one
original operation. No caller pagination, model, URL, header, credential or
transport selector is accepted.

The result is exactly `{ providerId: "featherless", catalog: FeatherlessModelRow[] }`.
It contains no native pagination or fabricated total. Rows preserve the existing
native observation fields and unknown values; they do not establish inference
entitlement, executable USD prices or default serving limits.

This is a keyed account-scoped scan. Every physical request uses the same
original selected Featherless grant and key with fresh caller/policy/owner checks.
It is separate from the credential-free Cerebras, NVIDIA, Chutes and Venice
metadata factories. Environment fallback, anonymous retry and unrelated grants
cannot replace the original Featherless owner.

The actual page codec stays `featherless.models`, with its real
`{ data, pagination, total }` envelope. The common scan follows validated page
progress through short or empty intermediate results. Only complete traversal
may publish an authoritative empty catalog; an interrupted, changed or revoked
scan cannot publish partial rows or revive static seeds.

Accepted ceilings remain 50 pages, 100 rows and 2 MiB per page, 8 MiB aggregate
wire bytes and a 4 MiB serialized result. Shared runtime and the source4 scan
helper own enforcement. This declaration does not add knobs or implement a scan.
See [the compiler contract](featherless-catalog-contract.md) and
[the actual page codec contract](featherless-model-catalog.md).

## Local qualification boundary

This candidate starts from [PR786](https://github.com/openclaw/clawrouter/pull/786)
source `83c1fe23a1f3b132cc74fcb441a4d3261ab392d1`. Publication, hosted execution,
provider snapshot generation and discovery activation remain closed until that
compiler, the source4 scan helper and source1 common runtime qualify. Restack
this retained candidate onto their actual qualified source before publication.
Source6 retains the existing serialized snapshot slot; source2 retains actual
client guarded-GET, selected proxy-key and unknown-fact proof.

Eight composed cases are authored in
`worker/test/featherless-catalog-declaration.test.mjs`: preserved declarations,
original-key multi-page results, authoritative empty scans, manifest-only caller
exposure, zero-egress overrides, missing/revoked owner, revocation between pages,
and incomplete traversal. They use the compiled YAML and real Worker fixture;
they remain unrun while common dispatch is unavailable.

The two owned compiler suites only strip the newly bundled catalog from their
independent foundation inputs; all existing assertions remain unchanged. A
source4-owned compatibility fixture still needs a portable correction:
`worker/test/featherless-native-chat.test.mjs` currently expects only the Chat
endpoint and selects it by array position. It must account for the catalog and
select `chat_completions` explicitly, preserving its card, pricing and replay
assertions. This candidate does not edit that source4 file.
