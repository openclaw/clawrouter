# Perplexity transport qualification

Checked 2026-11-03 against the [Agent quickstart](https://docs.perplexity.ai/docs/agent-api/quickstart),
[OpenAI compatibility guide](https://docs.perplexity.ai/docs/agent-api/openai-compatibility),
[Search quickstart](https://docs.perplexity.ai/docs/search/quickstart) and
[pricing](https://docs.perplexity.ai/docs/getting-started/pricing).

| Endpoint | Upstream path | Wire format | Capability |
| --- | --- | --- | --- |
| `responses` | `/v1/responses` | `openai.responses`, JSON/SSE | `llm.responses` |
| `agent` | `/v1/agent` | `openai.responses`, JSON/SSE | `llm.responses` |
| `search` | `/search` | `perplexity.search`, JSON | `web.search` |

All use `https://api.perplexity.ai` and the existing bearer credential.
`responses` is the preferred unified Responses route; `agent` retains the
provider's native entry point. The documented `openai/gpt-5.6-sol` example has an
explicit router model ID, `perplexity/openai/gpt-5.6-sol`. It does not inherit a
direct OpenAI price, context limit, tool tariff or authorization.

Search accepts `query` as text or an array, search filters, result limits and
extracted-text budgets. It does not accept Agent fields such as `model`, `input`,
`instructions`, `effort` or `tools`. Client codecs must retain that distinction.
The manifest forwards the native body; it is not a complete upstream request
validator or a runtime/client compatibility certificate.

Current request-cost evidence is separate from token pricing:

- A successful standard `POST /search` costs 5,000 USD micros; Fast Search costs
  1,000. Up to five queries in one request are one billing unit, even if the
  response has no results. Invalid, rate-limited and upstream-failed requests
  are not billed. Extracted-text budgets do not change this tariff.
- Agent web search, URL fetch, image/people/finance search and sandbox sessions
  have separate charges. A model's token counters cannot account for them.

Search now declares the dated successful-request tariff. The original bounded
response observer qualifies a complete native result (including an empty result)
before settling a successful charge. A recognized native rejection settles zero;
malformed, oversized, interrupted or otherwise unknown responses retain the
reservation. HTTP 200 alone cannot attest success. Agent model/tool/session
tariffs remain unqualified: hard budgets fail closed unless an explicit policy
tariff applies. `policy_fixed` is not vendor-cost certification. Keep legacy Sonar's `unpricedCosts: [request_fee]` guard until its
actual replacement and full tariff are qualified. Do not copy its old prices
onto Agent or Search.

Perplexity documents stored responses and conversation continuation. This slice
adds no retrieval/cancel links or background lifecycle activation. Actual
continuation ownership, replay, terminal/error usage and cancellation behavior
require separate runtime/client fixtures before advertising those features.

## Client and runtime qualification

The registered ClawRouter provider can select the catalog-eligible model
`clawrouter/perplexity/openai/gpt-5.6-sol` through its own credential-scoped
catalog. The consumer test uses that returned row and the registered wrapper,
public Responses stream, actual retained assistant/tool result, and captured
provider generation for replay. It does not construct an eligible model row.
Responses uses `/v1/responses`; it is not proof of `/v1/agent` selection.

The native Agent route is tested separately at the real Worker transport boundary,
including original source, handler, reader, cancellation and SQLite settlement.
Pinned OpenClaw D8 has no registered Agent consumer. No OpenClaw Agent parity is
claimed or invented.

Pinned OpenClaw D8 lacks a `perplexity.search` native web-search codec. Its
registered bridge currently rejects this format. Client Search parity remains
blocked until the OpenClaw owner adds and qualifies the bounded model-less codec:
nonblank query at most 4,000 characters, count 1–10 (default 5),
`POST {query,max_results}`, selected offer/origin/credential, 30-second/1-MiB
limits, unsafe-URL filtering, untrusted result wrapping and original abort/cleanup.
Worker transport tests are not a substitute for that registered client proof.

These are synthetic provider fixtures, not live vendor access or tariff invoices.
No new credential format, persistent owner or deployment transition is introduced.
The PR remains draft while the applicable client proof is incomplete; deployment
is separate and no manual deployment is requested.

### Frozen Search receipt grammar

The [OpenAPI contract](https://docs.perplexity.ai/api-reference/search-post.md)
was checked on 2026-11-20. A success requires HTTP 200, delivered EOF, string
`id`, array `results`, and string `title`, `url`, `snippet` on every result.
`server_time`, `date` and `last_updated` may be absent, string or null.
These types impose no UUID, nonempty-string or URL-format rule; client URL safety
filtering is a separate obligation. Error/result mixtures remain unknown.

The free-rejection grammar requires complete JSON with string `error.message`
and `error.type`, integer `error.code` matching the HTTP status, and no success
envelope. It admits the documented 400 types, 401 `invalid_api_key`, and 429.
Other error shapes/statuses, including unqualified upstream failures, keep the
reservation because their original receipt is not qualified here. That is an
uncertainty policy, not a claim that the vendor bills failed requests.

[Standalone pricing](https://docs.perplexity.ai/docs/getting-started/pricing)
and [Fast Search](https://docs.perplexity.ai/docs/search/fast-search) confirm the
frozen rates, default web selection, empty-result and multi-query request unit.
No Agent tool tariff is imported. The original 2-MiB observer uses fatal UTF-8,
full JSON parsing and delivered EOF; it never tees or fetches the response again.
