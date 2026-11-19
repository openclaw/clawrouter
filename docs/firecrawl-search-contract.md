# Firecrawl Search integration contract

The existing provider manifest exposes scrape only. The portable synthetic
fixture `providers/_fixtures/firecrawl/search.json` supplies the missing native
Search contract for the existing YAML owner and actual OpenClaw consumer.

Use POST `https://api.firecrawl.dev/v2/search` with a JSON query, limit, sources,
domain filters and optional `scrapeOptions`. Preserve the v2
`{ success, data: { web, news, images }, creditsUsed }` envelope. Return native
errors unchanged; `success: false` is not success merely because HTTP status is
200. Search results and scraped text remain untrusted content.

The fixture includes web/news groups, markdown, an empty response and an error.
At OpenClaw revision `b3aa84d0d79e3bfe7f2ef697fec3f5bf15b634fd`, the consumer
is `extensions/firecrawl/src/firecrawl-client.ts`. It selects web, news and image
results, bounds count/content and wraps external text. Its configured-origin
resolution and credential-scoped cache must be preserved when implementing the
router bridge; do not copy its result parser into an acceptance test and claim
that the actual consumer ran. A proxy credential must never reach Firecrawl.

The public service documents keyless starter access separately from authenticated
capacity. This fixture qualifies the credentialed route only; router access always
requires its own authorized caller. Self-hosted reachability, search backends,
capacity and billing are separate operator contracts.

## Billing

Primary documentation currently describes two search credits per ten results,
rounded up, plus optional scrape costs. Full search ZDR is ten credits per ten
results. Scraping, PDF pages and extraction can add charges. Account-plan credit
conversion is not established by `creditsUsed`, result count or a generic request
counter. A result limit does not bound arbitrary PDF page/extraction costs.

The four reported credits in the synthetic result are ledger units, not dollars.
The test policy charges 37 micro-USD with `policy_fixed`; it does not certify
upstream-dollar parity. Keep unknown-price hard budgets closed until the supported
request options, whole-request bound and account credit tariff are qualified.
Do not infer refunds or universally free failures from missing result data.

## Ownership and verification

- **11.3:** add `web.search` and `search` POST `/v2/search` with native
  `firecrawl.search` formats to the existing provider YAML. No new provider ID.
- **11.1:** qualify any native success/credit accounting and option-dependent bound.
- **11.2:** register credential-scoped search discovery and invoke the actual
  consumer with the fixture; preserve external-content and origin guards.
- **11.6:** integrate the bundled manifest snapshot, run actual Worker/client proof
  and distinguish synthetic transport qualification from live access.

`worker/test/firecrawl-search-transport.test.mjs` exercises the real Worker with
a candidate endpoint injected into its test snapshot. It covers internal/native
routes, credential substitution, source preservation, HTTP-200 errors, empty results,
fixed-policy settlement and zero-egress denial. It does not activate the manifest.

Sources: [Search API](https://docs.firecrawl.dev/api-reference/endpoint/search),
[Search behavior and credit costs](https://docs.firecrawl.dev/features/search).
