# Perplexity Agent and Search contracts

These synthetic fixtures qualify transport and observation behavior, not live
provider access or a shipped client integration. The manifest owner activates the
existing `perplexity` provider; there is no second provider ID.

Sonar support ended September 27, 2026. Its synchronous and streaming requests
continue through Agent reformulation. Asynchronous Sonar requests are unsupported.
Do not describe the synchronous endpoint as removed or apply its former price
card to the new underlying model/tool work.

## Wire handoff

`providers/_fixtures/perplexity/native-contracts.json` contains requests, unary
results, typed SSE events, a partial-output failure, Search rejection/empty results,
and synthetic consumer expectations. All content, identifiers and URLs are
synthetic. SSE serialization uses each event's `type` as the event name and JSON
as its data; there is no dependency on a Chat Completions `[DONE]` marker.

| Surface | Native transport | Consumer contract |
| --- | --- | --- |
| Search | POST `https://api.perplexity.ai/search`, Bearer, JSON | Model-less `query`, optionally an array; `results[]` with title/url/snippet/date/last_updated |
| Agent | POST `https://api.perplexity.ai/v1/agent`, Bearer, JSON or SSE | `input` plus `model`, `models` or `effort`; typed `output[]`, not `choices[]` |
| Agent compatibility alias | POST `/v1/responses` | Same Agent product; not a separate Orchestrator or OpenRouter credential |

For Search, map snippet to description and date to published; preserve ranked
order, query limits and caller count. Keep web text untrusted and apply the actual
client's external-content wrapper. Empty results are a successful search, not an
Agent answer or provider failure. Search is not an LLM and needs no fabricated
model row.

For Agent, join `message.content[]` entries of type `output_text`; keep
`search_results.results[]` as sources. These sources are not the raw Search
product's top-level result array. SSE delivers text deltas and typed search-result
events before `response.completed.response`. A `response.failed` event can
carry a top-level error without a nested response. HTTP 200 and partial text are
not proof of successful completion.

The first transport fixture sets `background: false` and `store: false`.
Neither setting proves zero upstream retention: the documented `store: false`
response can still be a continuation source. Do not expose retrieve, cancel,
files, reconnect, previous-response IDs or managed background behavior until
caller/policy/original-credential binding is qualified. A dropped stream does not
prove compute stopped.

## Billing boundaries

Agent token observations include input/cache/output and reasoning details.
`usage.cost` and `tool_calls_details` carry separate monetary/tool facts;
token extraction alone does not account for those charges. An effort alias can
select a changing model and configuration. A returned version pins an effort
only when it is actually versioned. `max_steps` alone is not a demonstrated
whole-run bound for every tool, session, model fallback and service tier.

The fixture reports 4,200 micro-USD and uses a separate 43-micro policy charge.
The tests require `policy_fixed`, never provider-price parity. A future native
pricing observer must validate the resolved model, currency, terminal evidence
and supported charge components without trusting user-supplied JSON. Missing
tool charges or an unqualified preflight bound must preserve hard-budget denial.
Do not reuse OpenAI hosted-tool prices just because Agent accepts Responses.

The current primary Search price card is more specific: each successful standard
request costs 5,000 micro-USD, or 1,000 for `search_type: fast`. An array of up to
five queries is one request, an empty successful result is billable, and rejected
or failed requests are not billed. Extracted-content token limits do not change
this price. These evidence values are fixtures, not an installed runtime tariff.
11.1/11.3 own native success-qualified request pricing and its admission/settlement
integration; until then the existing conservative guard remains.

## Source-owner handoff and proof

- **11.3:** add Search and Agent endpoints to the existing YAML, including an
  explicit model-less effort route if supported. Keep Sonar compatibility honest,
  preserve unknown model/tool guards and avoid broad model-eligibility claims.
  The candidate tests use `perplexity.search` and `openai.responses` formats.
- **11.1:** integrate any qualified native cost accounting and durable control
  binding. Existing token extraction observes counts but does not settle
  `usage.cost`, tool invocations or native Search request prices.
- **11.2:** use credential-scoped endpoint/format discovery, with proxy credentials
  sent only to the router. At OpenClaw revision
  `b3aa84d0d79e3bfe7f2ef697fec3f5bf15b634fd`,
  `extensions/perplexity/src/perplexity-web-search-provider.shared.ts` forces a
  configured base URL into Chat Completions; its runtime Search path is hardcoded
  to the upstream origin. A base-URL override alone cannot implement this bridge.
- **11.6:** import the actual OpenClaw consumer at its final revision and prove
  catalog → native route → result/stream → usage. Do not copy its parser into a
  fixture and call that cross-repository proof.

`worker/test/perplexity-native-observation.test.mjs` executes existing usage
observers without dependencies. `worker/test/perplexity-native-transport.test.mjs`
executes the real Worker with candidate endpoints injected only into the test
snapshot. It checks body/result/SSE preservation, credential substitution,
policy-fixed charges and zero-egress hard-budget denial. This candidate injection
does not activate the bundled manifest or certify the OpenClaw consumer.

## Primary sources

- [Sonar migration](https://docs.perplexity.ai/docs/agent-api/migrate-from-sonar/overview)
- [Agent request and event schema](https://docs.perplexity.ai/api-reference/agent-post)
- [Agent streaming](https://docs.perplexity.ai/docs/agent-api/output-control)
- [Search request and response schema](https://docs.perplexity.ai/api-reference/search-post)
- [Current API pricing](https://docs.perplexity.ai/docs/getting-started/pricing)
