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

The current manifest has no qualified new tariff. Hard budgets must fail closed
unless an explicit policy tariff applies; `policy_fixed` is not vendor-cost
certification. Keep legacy Sonar's `unpricedCosts: [request_fee]` guard until its
actual replacement and full tariff are qualified. Do not copy its old prices
onto Agent or Search.

Perplexity documents stored responses and conversation continuation. This slice
adds no retrieval/cancel links or background lifecycle activation. Actual
continuation ownership, replay, terminal/error usage and cancellation behavior
require separate runtime/client fixtures before advertising those features.
