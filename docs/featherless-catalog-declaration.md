# Featherless keyed complete-catalog declaration

This declaration adds only a metadata capability and endpoint to the existing
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

## Qualified source and remaining integration

This declaration starts from qualified [PR792](https://github.com/openclaw/clawrouter/pull/792)
squash `fa12bfab595f438a8abb61fb95d3cd2347936552`. That base contains compiler
[PR786](https://github.com/openclaw/clawrouter/pull/786), complete-scan helper
[PR787](https://github.com/openclaw/clawrouter/pull/787) and workerd-compatible
manual-redirect factories from [PR794](https://github.com/openclaw/clawrouter/pull/794).
Common runtime qualification includes the complete 5,000-row workerd scan and
capacity lifetime. This declaration introduces no scan or credential logic.
Source6 retains serialized snapshot/composed qualification after
[PR799](https://github.com/openclaw/clawrouter/pull/799). Source2 retains actual
client guarded GET, selected proxy-key and unknown-fact materialization. The
accepted client handoff is not client execution or completed E01 parity.

Eight composed cases are authored in
`worker/test/featherless-catalog-declaration.test.mjs`: preserved declarations,
original-key multi-page results, authoritative empty scans, manifest-only caller
exposure, zero-egress overrides, missing/revoked owner, revocation between pages,
and incomplete traversal. They use the compiled YAML and real Worker fixture;
they remain unrun locally because this checkout has no qualified dependencies.
All-manifest compilation and hosted final-head checks remain required.

The two owned compiler suites only strip the newly bundled catalog from their
independent foundation inputs; their qualified redirect assertions are preserved.
The new declaration fixture likewise expects the actual manual-redirect factory.
The
explicitly authorized two-line correction in
`worker/test/featherless-native-chat.test.mjs` checks both endpoint memberships
independent of array order and selects `chat_completions` by ID. All other card,
pricing and replay assertions in that source4 fixture remain unchanged.
