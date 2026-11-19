# Native image request accounting

The runtime consumes source-owned `prepareXaiImage`, `observeXaiImage`,
`imageRequestReserve` and `imageRequestCost`. It extends the existing
`endpoint.requestPricing` and accounting/outbox path with `unit: image`;
it does not add a second billing framework or activate a provider manifest.

Selection validates the native image body against the registered model before
credentials or budget dispatch. The admitted snapshot retains the selected and
serving model, operation, output count, input-image count, resolution, quality,
quality basis and a private copy of the original versioned tariff. It contains
no prompt, image data, URL or credential. The source helper computes the reserve;
runtime does not repeat its rate arithmetic. Alias low pricing, direct auto's
higher qualified reserve and edit reference multiplicity remain distinct.

The existing policy, original selected grant, reservation and dispatch
acknowledgment own egress. Only the qualified global xAI origin and native
generation/edit paths are accepted. Caller query parameters, unsupported tools,
tiers, media fields, streaming and deferred jobs are rejected. There is no
post-dispatch grant retry or uncertain-create replay. Unpriced declarations
remain closed to hard dollar budgets; explicit fixed policy pricing is separate.

The native response boundary shares the established body capacity budget and
Google embedding delivery infrastructure. Image decoding acquires 80 MiB of
shared capacity before paid dispatch and holds it through downstream completion
or cancellation. The source reader enforces HTTP 200, JSON MIME, fatal UTF-8,
length consistency, a 24 MiB envelope and complete EOF under the existing
operation deadline. The codec independently validates every image. Returned
URLs, partial image arrays or malformed bytes cannot be published as success.
Large concurrent inputs may be refused before dispatch because the same isolate
must also retain the bounded response. Native values/order are preserved;
whitespace, compression and representation-specific integrity headers are not.

A complete original native receipt settles its whole request cost once. The
source helper owns tick conversion, rounding and serving-model checks. Runtime
does not add token charges, the reserved image estimate or Responses outcome
fees. Valid explicit zero is distinct from missing usage. A complete bill can
still be recorded when image validation fails; it never authorizes delivery of
invalid media. Missing, unsafe, foreign-model or incomplete receipts retain the
original reserve. A known-unsent request releases it. Valid receipts above the
reserve are recorded honestly rather than clamped. Late soft-budget denial keeps
the original charge intent and any complete qualified receipt.

Events retain the original selected model and tariff version. Image counts,
encoded bytes and native token-shaped extension fields do not become token
usage. Catalog offers preserve the actual image tariff and request-dependent
affordability. Fixed policy charges keep their separate label, including zero.

Tests use synthetic native and manifest calls through the actual Worker,
authority and SQLite budget ledger. They cover reservation before fetch,
alias/direct quality, edit multiplicity, complete and missing receipts,
invalid output, deadline/cancellation, source-table mutation, soft denial,
catalog facts and one settlement. Source-owned schema and pricing tests remain
unchanged. YAML/snapshot activation and actual image-client qualification stay
with their existing owners. No live image call or production deployment occurs.
