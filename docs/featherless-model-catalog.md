# Featherless native model catalog

This focused codec publishes the finite catalog contract used by frozen OpenClaw
`31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`. It does not activate a discovery endpoint,
refresh a provider snapshot, replace the existing seed or claim actual client parity.

## Provenance

Frozen `extensions/featherless/index.ts` requests `models?capabilities=chat` with
strict discovery, optional original API-key authentication and configured entries.
`openclaw.plugin.json` contains the single frozen `Qwen/Qwen3-32B` card; `models.ts`
adds fallback limits for dynamic identities. Those fallback facts and frozen zero
cache costs are not native observations and are not copied here.

Primary contracts checked on 2026-11-03:

- [Models API](https://featherless.ai/docs/api-reference-models): Chat filtering,
  numbered pages and account-specific `available_on_current_plan`. `is_gated`
  describes a model's HuggingFace gate, not whether this account has unlocked it.
- [Plan API](https://featherless.ai/docs/api-reference-plan): catalog context size
  is not necessarily the selected account's effective plan limit.
- [Billing](https://featherless.ai/docs/billing): Developer token credits and
  dedicated Business capacity have distinct billing contracts.

Two bounded anonymous catalog observations used only `capabilities=chat` and
page parameters. Both returned HTTP 200 and `{data,pagination,total}`. A requested
page size of two returned `per_page:100`; page two returned 48 rows with
`current_page:2,total_items:844,total_pages:9`. A short page therefore cannot
establish completion. These observations establish neither account entitlement
nor inference access. No inference, billing, login or credential request was made.

## Published source ABI

`worker/featherless-model-catalog.ts` exports:

- `FEATHERLESS_MODELS_FORMAT = "featherless.models"`.
- `featherlessCatalogRequest(base, selectedApiKey, page, signal): Request`.
- `filterFeatherlessModels(payload, allows, expectedPage): FeatherlessModelPage`.
- `readFeatherlessModels(response, signal, allows, expectedPage)`.

The request accepts only `https://api.featherless.ai/v1` with an optional trailing
slash. It fixes GET `/models?capabilities=chat&page=N&per_page=100`, sends only
Accept plus the original selected Bearer key, forbids redirects and preserves
abort. Pages are integers from 1 through 1000. There is no caller-supplied URL,
filter, alternate key, anonymous retry or account/plan probe.

The parser requires the observed paginated envelope, the requested page and a
100-row maximum. It validates bounded integer totals and rejects inconsistent
page counts, extra envelope fields, duplicate IDs and malformed identity rows.
The minimal data-only documentation example cannot prove complete paginated
inventory and is deliberately rejected. It never becomes an empty successful
catalog or a fallback seed. Empty catalogs may advertise zero or one total page.

Original-policy filtering uses exact native IDs. Explicit account-plan denial
and non-active observations are excluded. Absent account fields remain absent;
`available_on_current_plan:true` does not remove a HuggingFace gate. The helper
retains upstream pagination separately from the filtered row count, including
empty intermediate pages. It does not follow pages itself.

Positive integer context/output/concurrency observations and named boolean
features are independent optional fields. Four decimal-string pricing fields
are copied independently, without arithmetic, cache defaults or tariff creation.
Names, model classes, parameters, loading state and HuggingFace metadata never
invent limits, capabilities, availability or account eligibility. Unknown fields,
routing URLs and account data are not forwarded.

The complete reader reuses the existing 2 MiB native JSON guard. Only complete
HTTP 200 JSON with valid UTF-8 and EOF is accepted; redirects, ranges, incorrect
lengths, oversize delivery and abort fail closed without exposing upstream text.
Both runtime imports have explicit `.ts` suffixes. The regression suite includes
a child Node import without the test-only TypeScript resolver.

## Narrow integration dependencies

Source1 retains common runtime dispatch, authorization, original-grant selection,
credential-scoped cache and policy filtering. Every page must use the same
original grant and selected key, with revalidation, aggregate byte/row/page scan
bounds and one deadline. Continue only while validated `current_page` is less
than `total_pages`; reject repeated pages or cross-page duplicate IDs. Never
infer termination from short/filtered pages or restart with public authentication.
Changing upstream inventory requires a conservative bounded outcome, not a claim
of a stable full snapshot. Preserve stopped-model filtering and unknown prices.

Source3 owns paired `featherless.models` validation and eligible bodyless GET
`/models` declaration. No endpoint auth override is proposed. The dispatch helper
owns its fixed query; no generic passthrough query or upstreamPath expansion is
requested. Actual compiler/runtime publications and Worker proof are prerequisites
for source4's later endpoint declaration.

Frozen explicit custom bases still require source1's qualified destination and
credential boundary; this canonical helper intentionally cannot send a key to a
custom origin. Source2 owns actual client pagination, replay and account-safe
catalog consumption, without synthesized 4096/1024 limits or zero prices.
Source6 retains later snapshot and composed client/Worker acceptance. Source4
has no snapshot lease. This leaf and deterministic fixtures are not activation,
account entitlement, host readiness, live cancellation or production proof.
