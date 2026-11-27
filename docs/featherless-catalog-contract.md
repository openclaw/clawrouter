# Featherless complete-catalog projection

This compiler foundation separates a router-owned complete scan from the real
native page format. It adds no provider YAML, snapshot, shared scan runtime,
client mapping or discovery activation.

## Accepted wire contract

- Provider `featherless`; canonical base `https://api.featherless.ai/v1`.
- Endpoint ID `catalog`, capability `models.list`, method `GET`, path `/models`.
- Exact paired request/response format `featherless.catalog`.
- Required `nativeProxy: false`; no native API alias.
- Caller `GET /v1/proxy/featherless/catalog`, with no body, query or path input.
- Response `{ providerId: "featherless", catalog: FeatherlessModelRow[] }`.
  Rows use the existing typed native observations unchanged. No `pagination`,
  `total`, synthetic page size or caller-controlled completion flag is returned.

The compiler rejects mixed native-page/projection endpoints, arbitrary endpoint
names, transport or origin overrides, credential injection, model capabilities,
pricing and generation fields. No new common compiled field or configurable
scan-limit field is introduced.

## Page codec and runtime boundary

`worker/featherless-model-catalog.ts` remains unchanged:
`featherless.models` is its real page format; `featherlessCatalogRequest` fixes
`capabilities=chat&page=N&per_page=100` and sends the original selected Bearer key.
`readFeatherlessModels` validates the expected page and returns the actual
`{ data, pagination, total }` envelope. A short or empty intermediate page is not
completion. See the [page contract](featherless-model-catalog.md) and
[separate native-page schema](featherless-models-schema.md).

The accepted shared scan bounds are 50 pages, at most 100 rows and 2 MiB per page,
8 MiB aggregate wire bytes, and a 4 MiB serialized result. These are router
ceilings, not vendor or account limits. Source1 owns their enforcement under one
`HttpOperation`, the original selected key on every page, fresh caller/policy/
owner checks before each physical fetch and after parsing, and final filtering.
No environment-key or anonymous retry may replace the original grant.

A successful result requires complete validated traversal. Changing pagination,
duplicate returned identities, interruption, owner revocation or an exceeded
bound cannot yield partial success or restore a cached/static seed. Empty
`catalog: []` is authoritative only after successful traversal. Traversal does
not establish an atomic inventory snapshot, inference entitlement or a tariff.
Native decimal prices, unknown limits, plan flags and gated-model observations
remain distinct from serving rights and executable inference prices.

Source2 owns the actual guarded GET consumer, strict envelope/`readRows`
projection, selected proxy-key binding and unknown-fact preservation. Existing
zero-cost/default-limit fallback mappings are not qualified by this foundation.
Source6 retains later composed client and serialized snapshot proof. Provider
activation remains closed until the common scan runtime qualifies.

Seven focused compiler cases cover declaration restrictions, unchanged inference
facts, original-key page-factory composition, the separate page format and
existing body/query guards. They do not claim a complete scan or Worker dispatch.
