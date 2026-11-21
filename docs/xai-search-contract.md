# Native xAI Responses search

Frozen consumer: OpenClaw `31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`,
`extensions/xai/src/{responses-tool-shared,web-search-shared,x-search-shared}.ts`.
The default selected model is `grok-4.7`. This module adds no catalog model,
price, endpoint, or live search claim.

## Wire and ownership

`prepareXaiSearch(value, qualification)` validates the native JSON body and returns
`POST /v1/responses` with JSON headers, no credentials. `qualification` comes from
the admitted server catalog: exact selected model, qualified serving identities,
and supported native reasoning efforts. It is not caller authority. Preserve the
selected model; never infer an alias from a returned model or accept an arbitrary
caller-provided qualification. The frozen client applies model-specific reasoning
compatibility before dispatch. For `grok-4.7`, the frozen X search request omits
unsupported `none`; web search sends supported `low`.

One user text input, one `web_search` or `x_search` tool, and `store:false` are
required. The frozen web tool has no filters. X handles allow up to 20 distinct
case-insensitive names without `@`; allow/exclude are mutually exclusive. Date
strings must be real calendar dates, with `from_date < to_date` when both exist.
The native interval includes the starting UTC date and excludes the ending date.
These filters do not constrain native thread fetches. The frozen X image/video
understanding flags are retained and require independent fee qualification.
Input text is limited locally to 32,768 UTF-16 units, `max_turns` to 1–10.
Neither is a monetary bound. No extra tools, history, raw file IDs, streaming,
background work, secret fields, or automatic paid POST replay enter this slice.

The bundled xAI provider declares `/v1/responses` with the existing
`openai.responses` wire format. Its qualified Grok 4.7 model declares
`web_search` support; that model fact does not authorize a request.

The authenticated catalog retains this support and computes
`clawrouter.hosted-tool-admission.v1` from the selected credential, policy and
current budget observation. Admission belongs only to the eligible selected
native offer, or the manifest offer when native routing is disabled. It is not
model metadata or a second advertised native/manifest route. OpenAI's existing
unified Responses admission is unchanged. Catalog projection never probes xAI.

An enforced dollar budget without a qualified hosted-tool bound reports
`pricing_required` and dispatch stays zero-egress/zero-charge. Explicit
`policy_fixed` admission retains that separate accounting basis; it does not
establish a vendor tool tariff. Registered OpenClaw search through Worker and
SQLite still requires separate exact-client qualification. No live vendor or
default-client parity is established by these catalog tests.

## Results and transport

`observeXaiSearch(body, request, complete)` and
`readXaiSearch(response, request, signal)` return a bounded observation. Only
complete HTTP 200 JSON is accepted, with a 1 MiB envelope limit, strict UTF-8,
no redirects or partial ranges, length consistency and an abortable reader.
Queued/in-progress responses are rejected: no asynchronous owner was admitted.
`completed`, `incomplete`, and `failed` remain distinct. A completed response
needs answer text and cannot carry contradictory error/incomplete details.
The original native body is transient; do not log or persist it by default.

Adjacent native output text is concatenated without inserted separators, then
bounded to 20,000 UTF-16 units without splitting a surrogate pair. Top-level
citations take precedence over output annotations. At most 1,000 candidates are
examined and 20 unique HTTP(S) URLs retained; embedded credentials are rejected.
URLs are opaque references, never router fetch targets. Text remains untrusted;
the actual client must sanitize and wrap it before presenting it as tool content.

Native inline offsets remain in the transient body only. The primary citation
documentation describes Python-style character offsets; the frozen client uses
JavaScript slicing and may sanitize/truncate text. Do not decorate transformed
text with those positions until the client qualifies the unit conversion and
retained-text mapping. No fabricated normalized offsets are emitted here.

## Accounting

Token counts, `web_search_calls`, `x_search_calls`, `x_posts_fetched` and
`x_users_fetched` are independent observations. Missing values stay `null`, never
zero. Fetched item counts are cumulative, not de-duplicated and not equal to
citations or calls. Native incomplete responses can contain billable usage.
Failure, truncation, filtering, transport loss or abort does not prove free work.
`upstreamCostMicros` remains `null`. Keep hard upstream-dollar budgets closed
without a qualified model/tool tariff and pre-dispatch bound; policy-fixed
charging is a separate basis. Preserve existing hosted-tool guards in shared
pricing code. This codec does not modify them.

Fixtures: `providers/_fixtures/xai/search.json`; tests:
`node --test worker/test/xai-search.test.mjs`. They cover native completed,
partial and failed results, separate item counters, safe citation handling,
identity/effort qualification, request isolation and incomplete transport.
No live inference or credentials are needed for deterministic tests.

Primary evidence checked 2026-11-03:

- [Web Search](https://docs.x.ai/developers/tools/web-search)
- [X Search and cumulative fetched-item usage](https://docs.x.ai/developers/tools/x-search)
- [Citation representation and positions](https://docs.x.ai/developers/tools/citations)
