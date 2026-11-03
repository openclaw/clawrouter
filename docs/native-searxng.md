# SearXNG native search

Configure `SEARXNG_BASE_URL` to an operator-controlled, reachable SearXNG instance.
There is no bundled public-instance default. An edge deployment cannot reach a
host's loopback interface; private instances require an explicitly configured
reachable bridge or self-hosted router. This manifest does not provision either.
Use HTTPS for a remotely reachable instance. `SEARXNG_API_KEY` is optional and
only applies when the operator's reverse proxy accepts Bearer authentication;
SearXNG itself does not define a universal API-key contract.

Call `GET /v1/native/searxng/search?q=...&format=json`. The instance must enable
JSON in `search.formats`; otherwise it returns 403. Native query parameters and
response bytes are preserved, including engine errors and empty results. Omitting
`format=json` can return HTML; the client bridge must request and validate JSON.
POST form search is not exposed because the generic native request parser expects
JSON. See the [SearXNG search API](https://docs.searxng.org/dev/search_api.html),
checked 2026-11-03.

There are no fabricated model rows or zero-cost claims. Instance hosting and
upstream engine costs are operator-specific. Reserve budgets need an explicit
fixed policy request charge. Legacy unmetered telemetry records a one-micro-unit
`flat_fallback`; this is not a measured operating cost. The fixture exercises a
synthetic reachable endpoint, optional proxy authentication, query preservation,
disabled JSON errors and missing configuration. A real instance probe and actual
OpenClaw consumer execution remain separate qualification gates.
