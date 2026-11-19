# Frozen Gemini grounded search

Frozen source: OpenClaw `31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`,
`extensions/google/src/gemini-web-search-provider.runtime.ts`.
The qualified model is its default `gemini-3.6-flash`; arbitrary configured
models require their own declared capability and tariff qualification.

## Native request and result

`worker/google-grounded-search.ts` exports `prepareGoogleGroundedSearch`,
`observeGoogleGroundedSearch`, `readGoogleGroundedSearch`, and
`googleGroundedSearchModel`.

- POST `/v1beta/models/gemini-3.6-flash:generateContent` with one user text
  content and exactly one `tools: [{ google_search: ... }]` declaration.
  The native body and client-composed prompt stay unchanged.
- Optional `timeRangeFilter` requires both UTC second-precision timestamps,
  real calendar dates and an increasing interval. The frozen client removes
  fractional seconds. Its day-freshness request uses a prompt hint, not a
  guaranteed native 24-hour filter; preserve that distinction. Country/language
  handling, date-before exclusive-end mapping and cache policy stay client-owned.
- No native result-count field is invented. Additional tools, grounding image
  search, conversation/cached content and newer model aliases are rejected.
  Requests are bounded to 128 KiB JSON and 65,536 text code units.
- Response must be HTTP 200 JSON, valid UTF-8 through EOF, at most 1 MiB,
  without redirect/API error/block and with one STOP candidate. Missing final
  answer, incomplete output or thought-only text is an error, not zero matches.
- Normalized answer/citations exclude thought text and unsafe URL schemes or
  user-info URLs. URLs remain opaque; the codec never resolves redirects or
  forwards provider credentials to a citation destination.
- Native `groundingChunks`, `groundingSupports`, `searchEntryPoint` and
  `usageMetadata` remain unchanged in `body`. Native indices refer to native
  chunks/content, never the filtered normalized citation list. Do not remap
  attribution indices implicitly or execute returned HTML in the router.

The HTTP reader requires the runtime's deadline/caller AbortSignal and cancels
the reader on abort or malformed/oversized delivery. No result prefix or remote
POST retry is published on failure.

## Accounting and ownership

`observedQueryCount` is only the length of a qualified native query list, or
null when absent. It is not a billable query count, per-request price, refund or
zero-cost witness. An empty or entirely filtered citation list does not change
native search evidence. Text generation and grounding charges need separately
qualified model/tool tariffs and a whole-request admission bound. Existing
conservative tool-pricing guards remain active under upstream-dollar budgets;
`policy_fixed` charging is distinct.

Manifest handoff: existing `google-gemini` source owner may qualify a
`google.grounded_search` request/response format for `search.web`. The native
model path overlaps ordinary inference, so generic dispatch must classify the
selected capability/tool shape before admission. A text price card or unscoped
generic route must not bypass the search guard.

Client handoff: `providers/_fixtures/google/grounded-search.json` preserves
the frozen wire, native attribution and result. Credential/operator-header
scoped cache keys, external-content wrapping and any bounded citation redirect
resolution remain consumer-owned. Redirect resolution must never receive
upstream API credentials. Preserve native attribution and search suggestions
for the consumer's qualified display contract. This is a synthesized grounded
answer API, not raw search-result parity.

Six focused tests cover native inputs, date bounds, tool admission, attribution,
filtered citations, terminal errors and abort/EOF. Actual Worker/client routing,
tariff and live access remain owner integrations. No deployment or live search
call occurred. Current primary examples prefer Interactions; this slice retains
the frozen consumer's GenerateContent contract without silent substitutions.

## Complete-response wrapper

`worker/native-google-grounded-search.ts` exports
`prepareNativeGoogleGroundedSearch(selection): NativeResponse | undefined`.
The existing JSON body ABI fits this unary request. Both endpoint formats are
`google.grounded_search`, with capability `search.web`, provider `google-gemini`,
selected upstream `gemini-3.6-flash` and its exact model path. No generic
passthrough, stream, query, alias, extra tool or request tariff is accepted.
The original body remains unchanged; credentials stay runtime-owned.

The wrapper enforces the codec's 128 KiB request and 1 MiB response bounds,
complete HTTP 200 UTF-8 JSON through EOF, exact declared lengths and no redirects,
ranges or encoded responses. Its 8 MiB response lease charges 16 MiB of shared
capacity before dispatch. A valid response preserves native usage and attribution
but returns normalized `{ tokens: null, outcome: "success" }`, with no invoice
receipt or query-count tariff. Invalid or interrupted output cannot publish a
prefix, authorize a POST retry or establish free execution.

The frozen client joins every text part without checking the thought flag.
The wrapper therefore replaces thought payloads with empty marked placeholders,
preserving part positions. It rejects attribution to those placeholders and
validates bounded native part/chunk references and UTF-8 byte segments without
renumbering chunks. Unsupported or unsafe citation descriptors reject the whole
response instead of silently changing indices. Final native attribution,
suggestions and usage stay unchanged; returned HTML is JSON data, never executed.
The wrapper performs no citation fetch or redirect resolution.

Eleven focused cases cover destination/admission, capacity, complete attribution,
thought exclusion, UTF-8 offsets, citation safety, terminal state, exact size and
HTTP bounds, interruption and cancellation. This leaf does not activate a route.
Source1 owns capability-aware matching on the overlapping GenerateContent path,
original credentials, tool admission and conservative settlement; Source3 owns
declaration/pricing, Source2 actual consumption and Source6 composed proof.

## Primary evidence

Checked 2026-11-03 using current unlocalized documentation:

- [Search grounding](https://ai.google.dev/gemini-api/docs/google-search)
- [GenerateContent, GoogleSearch and grounding metadata](https://ai.google.dev/api/generate-content)
- [Model deprecation schedules](https://ai.google.dev/gemini-api/docs/deprecations)
