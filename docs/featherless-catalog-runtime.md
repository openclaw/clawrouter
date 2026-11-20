# Featherless complete catalog runtime

The private, manifest-only `GET /v1/proxy/featherless/catalog` uses paired
`featherless.catalog` formats. It accepts no body or query. Native `/models`
is not an aggregate alias. The result is `{providerId:"featherless",catalog:[...]}`;
a fresh empty catalog remains authoritative. Provider declarations and the actual
client composition are separate activation work.

The selected durable API-key owner supplies every page's original credential.
Neither environment configuration nor an alternate account can replace it.
The page factory owns the canonical URL and query. Caller/static headers are not
forwarded. Owner generation, lineage, account, enabled state, current caller and
policy are checked before every physical fetch and after each complete parse,
under the original operation deadline. A later check can narrow the initially
permitted model IDs; it cannot add models. Owner inspection does not refresh or
materialize another key. This is fresh-at-check authority, not instantaneous
revocation across the check-to-fetch interval.

The qualified scanner follows advertised numeric pages, including short or empty
intermediate pages. It rejects changing totals, duplicate IDs (also excluded
rows), incomplete responses and exhausted bounds. It never publishes a partial
catalog or caches one. Observed prices, limits and plan fields remain observations;
missing values are unknown, not zero or serving entitlement. This metadata route
uses existing discovery accounting, not inference pricing.

## Capacity and lifetime

One scan reserves the existing 96 MiB body pool before its first fetch: a 48 MiB
`BodyLease` charges twice that size. The bodyless GET has no media ingress lease.
An overlapping charged operation causes zero-egress refusal; there is no pool
increase, third lease or later capacity gamble.

The scanner bounds each page to 2 MiB and 8192 chunks, the complete scan to 50
pages / 5000 IDs / 8 MiB wire, and the final serialized envelope to 4 MiB. Pages
are not archived. At most one decoded page and its parsed objects coexist with
the retained result. The maximum raw ID string content is 5000 × 512 UTF-16
units (4.89 MiB); retained rows have only the codec's finite scalar/feature/price
fields. Their serialized content is bounded by 4 MiB. A current page can retain
2 MiB input plus at most 4 MiB decoded string content while parsing; raw JSON
object overhead also consumes the reservation. The remainder of the full pool
covers object/Set/array overhead and transport/parser copies. These byte limits
do not claim an engine-independent exact JavaScript heap layout.

After scanning, the existing chunked JSON serializer retains the bounded result
until response consumption. It does not allocate a whole-result JSON string and
UTF-8 copy; each pull emits at most about 48 KiB. The same lease remains held
through final filtering, serialization and publication, and releases only when
the existing response observer completes or cancels. Errors cancel the active
page and release the lease. No reliance on a later garbage collection authorizes
another scan before that release.

The runtime tests exercise original authority, no fallback, atomic failures,
capacity refusal and release. The workerd test sends the real Worker through 50
physical keyed pages and a 5000-row result above 3 MiB, checks capacity while
bytes remain, complete EOF, cancellation and zero-egress overlap refusal.
