# Agent spend control

ClawRouter enforces centralized model budgets with pre-request reservation and
post-response settlement. Provider credentials remain server-side; clients use
a ClawRouter credential and receive only the providers and models allowed by
their policy.

## Enforcement contract

For a model with manifest pricing, ClawRouter reserves a conservative upper
bound before contacting the provider:

```text
upper-bound input tokens = serialized request bytes + manifest overhead
upper-bound output tokens = request maximum or manifest model maximum
reservation = input upper bound × input rate + output upper bound × output rate
```

Image, document, file-ID, screenshot, stored prompt, conversation, previous
response, and stored-item inputs reserve the model's full declared input window
because their billable token count cannot be inferred from the small serialized
reference. Chat Completions output bounds are multiplied by `n`.

Input reservation includes the declared generic cache-write rate; duration-specific
cache controls also select their declared write rates. After the response completes, ClawRouter settles reported input,
cached-input, cache-write, and output tokens at the manifest rates and releases
the unused reservation. Streaming SSE responses are inspected as the client consumes them, with a
bounded usage buffer and no response clone or body persistence. Missing usage, malformed terminal
events, oversized JSON responses, and interrupted streams remain charged at
the reservation.
Anthropic and OpenAI streaming settlement requires a provider terminal marker (`response.completed`,
`message_stop`, or `[DONE]`), not merely a clean transport EOF.

Usage events record total input tokens, including cache reads and writes.
[Anthropic reports these as disjoint counters](https://platform.claude.com/docs/en/build-with-claude/prompt-caching),
so ClawRouter adds them before pricing and selecting a long-context tier.
OpenAI's input total already includes its cache-detail counters and is not
increased. Cache writes are reported once in `cache_write_input_tokens`; known
five-minute and one-hour writes use their respective rates, and writes without
a duration use the highest declared cache-write rate. Anthropic streaming
updates replace cumulative counters while preserving omitted or null counters
from earlier events; an incomplete stream retains its reservation.

[Anthropic classifier refusals before any output](https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback)
report token usage but are not billed. ClawRouter preserves those counts in
usage events and settles token-priced requests at zero after the complete
response. Refusals after output begins remain billable. Explicit fixed policy
prices still apply independently of upstream token billing.

`requestCostMicros` on a policy is an explicit fixed-cost override. Routes
without pricing use the legacy one-micro fallback only when no monthly budget
is configured. Every budgeted call fails closed until its route has versioned
manifest pricing or a fixed policy price. A zero-cost route, such as Anthropic
token counting, skips reservation.

Server-executed tools can add fees and repeated model work that token pricing
does not cover. The proxy forwards these requests; its accounting allowance is
not an upstream invoice cap. Disable hosted tools for token-only accounting.
Client-executed function, custom, namespace, local-shell, and apply-patch tools
use the model's token rates. A fixed `requestCostMicros` is an operator-defined
tariff, not a measurement of provider tool charges.

Pricing lives beside the model in `providers/*.provider.yaml`:

```yaml
pricingRef: openai-gpt-5.4-standard-2026-06-19
pricing:
  effectiveAt: "2026-06-19"
  source: https://developers.openai.com/api/docs/models/gpt-5.4/
  inputMicrosPerMillion: 2500000
  cachedInputMicrosPerMillion: 250000
  outputMicrosPerMillion: 15000000
  maxInputTokens: 1050000
  defaultMaxOutputTokens: 128000
  longContext:
    thresholdInputTokens: 272000
    inputMicrosPerMillion: 5000000
    cachedInputMicrosPerMillion: 500000
    outputMicrosPerMillion: 22500000
```

## Per-provider budgets

Provider connections can set a monthly budget that applies tenant-wide to all
traffic routed to that provider, independent of policy and principal budgets.
The UTC calendar-month ledger uses the same conservative reservation and actual
cost settlement flow as policy budgets. Both limits must admit a request; an
exhausted provider limit returns HTTP 402 with `provider_budget_exhausted`.
Leaving the provider budget blank keeps the provider unmetered and adds no
provider-ledger call to the request path.

Rates are integer micro-US-dollars per million tokens. Update `pricingRef` and
`effectiveAt` together when a provider changes price. Subscription traffic uses
the equivalent public API list price for governance; it is not an invoice for
the subscription.

Bundled dated pricing also covers Together Qwen 2.5 7B, DeepSeek V4 Flash,
MiniMax M3, Google Gemini 2.5 Flash, Groq Llama 3.1 8B Instant, and xAI Grok
4.3, including provider cache and long-context tiers where applicable.
Dynamic catalogs such as OpenRouter and generic Hugging Face model routes stay
unpriced: monthly-budget policies fail closed unless an operator supplies a
fixed `requestCostMicros` override.

Long-context rates are selected conservatively from the preflight input bound
and exactly from reported input usage during settlement. OpenAI models declare
individual Standard (`default`), Fast (`priority`, alias `fast`), and supported
Flex rate cards in `pricing.serviceTiers`. Rates come from the
[dated OpenAI pricing table](https://developers.openai.com/api/docs/pricing);
Fast is not a universal multiplier. GPT-5.6 uses the Sol alias and its current
promotional prices, published through at least November 21, 2026.

ClawRouter forwards `service_tier` unchanged. Absent or `auto` can inherit the
provider project's default, so admission reserves the highest applicable known
rates. Explicit tiers reserve their card and Standard downgrade rates. Unknown
requested tiers fail with `pricing_required` under token pricing; explicit fixed
policy tariffs remain available. A short-only card stays in the reservation
envelope when actual input may fit below its published limit.

Settlement uses the actual served tier from JSON, completed Responses SSE, or
Chat Completions chunks followed by `[DONE]`. A priority request served as
`default` is charged Standard rates. Missing or unknown served tiers, unpublished
context ranges, and incomplete token usage retain the reservation and record
`cost_basis: manifest_reservation`; measured costs record `manifest_pricing`.
Usage events include `requested_service_tier` and `served_service_tier`.
The bundled OpenAI route is pinned to the global `api.openai.com` endpoint.
Regional data-residency endpoints are not exposed; a regional deployment needs
a separate versioned price with OpenAI's 10% uplift or a fixed policy price.
Request `stream_options.include_usage=true` for Chat Completions streams
so successful terminal events can release unused reservation. Known model IDs
retain the same pricing when called through native or manifest proxy routes.
Background Responses do not provide final usage in their initial response;
ClawRouter does not poll them for deferred settlement. Their reservation remains
charged when complete billable usage is unavailable.
The bundled Anthropic catalog includes Claude Opus 5, Sonnet 5, and Fable 5 with a 1M
context window and 128K output limit, alongside the existing model routes.
Fable 5 always uses adaptive thinking and requires
[30-day upstream data retention](https://platform.claude.com/docs/en/models/fable-5/introducing-claude-fable-5-and-claude-mythos-5).
Disabling ClawRouter request-content retention does not disable Anthropic's
retention; approve that requirement before selecting Fable 5.
Embedding manifests distinguish the per-input token limit from the aggregate
request limit, so batched inputs reserve against the provider's full request
allowance.
Provider-native JSON requests that need model normalization or listed-price
inspection are capped at 8 MiB. Larger raw payloads can use a provider-native
route with a fixed per-request policy price; compatibility routes still require
inspection so ClawRouter can safely rewrite the model identifier.

## Codex

Add a user-level entry to `~/.codex/config.toml`:

```toml
model = "openai/gpt-5.4"
model_provider = "clawrouter"
web_search = "disabled"

[model_providers.clawrouter]
name = "ClawRouter"
base_url = "https://router.example.com/v1"
wire_api = "responses"
env_key = "CLAWROUTER_API_KEY"
```

Codex hosted web search has separate provider-side pricing, so this token-priced
setup disables it. Codex also needs model metadata that advertises a service tier
before it sends that tier; setting `service_tier` alone is not a compatibility
proof. This configuration does not advertise WebSocket support.

Then export the issued ClawRouter credential:

```sh
export CLAWROUTER_API_KEY="<issued credential>"
```

Codex's `session-id` request header is recorded as agent-session attribution.
Static project or client dimensions can be added with provider `http_headers`.

## Claude Code

The root Anthropic-compatible routes expose `/v1/messages`,
`/v1/messages/count_tokens`, and `/v1/models`. Configure Claude Code with:

```sh
export ANTHROPIC_BASE_URL="https://router.example.com"
export ANTHROPIC_AUTH_TOKEN="<issued credential>"
export CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1
export ANTHROPIC_MODEL="anthropic/default"
export ANTHROPIC_DEFAULT_OPUS_MODEL="anthropic/default"
export ANTHROPIC_DEFAULT_SONNET_MODEL="anthropic/default"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="anthropic/default"
export CLAUDE_CODE_SUBAGENT_MODEL="anthropic/default"
```

Pinning every Claude Code model tier is required for list-price enforcement:
the bundled manifest prices `anthropic/default`, while model discovery alone
does not change Claude Code's active or background model selection. Enterprise
deployments should distribute these values through managed settings so local
model choices cannot bypass the priced route.

ClawRouter records `X-Claude-Code-Session-Id`, `X-Claude-Code-Agent-Id`, and
`X-Claude-Code-Parent-Agent-Id`. `anthropic-beta` is forwarded, except that the
price-changing `context-1m-2025-08-07` beta requires a fixed request price or a
matching versioned long-context price. Provider credentials and cookies are
stripped. Requests carrying `anthropic-version` receive Anthropic model objects
and cursor fields from `/v1/models`; other clients retain the OpenAI-compatible
model list.

## Shared attribution headers

Each model call may send `X-Request-ID`. ClawRouter trims and accepts a caller
value only when it is a safe ASCII identifier no longer than 128 characters;
otherwise it rejects the value and returns a generated safe ID with the owned
error response. Missing IDs are generated. Every owned success or error echoes
the canonical value, and CORS allows and exposes the header. Error logs include
that bounded ID as their only request-specific metadata.

A valid W3C `traceparent` contributes only its `trace_id` and parent `span_id`
to usage/status metadata. Invalid, all-zero, uppercase, or oversized contexts
are ignored. Request IDs and trace IDs remain event fields and are never metric
labels.

Clients and gateway adapters may separately send:

- `X-ClawRouter-Session-Id`
- `X-ClawRouter-Agent-Id`
- `X-ClawRouter-Parent-Agent-Id`
- `X-ClawRouter-Project-Id`
- `X-ClawRouter-Client`

Explicit ClawRouter identifiers take precedence over client-native identifiers.
For session attribution, `X-ClawRouter-Session-Id` wins, followed by the
documented Claude Code `X-Claude-Code-Session-Id` and Codex `session-id`
fallbacks. The selected value is normalized once and also drives policy session
stickiness; request IDs never substitute for sessions. Selected attribution
values must be safe ASCII identifiers no longer than 256 characters or the
request is rejected before provider routing.

Recent audit events include the resolved session, agent hierarchy, project,
request/trace lineage, pricing version, reservation bounds, actual tokens, and
settled cost. Prompts, completions, tool bodies, credentials, and error payloads
are never stored by the spend-control path. Optional request-content retention
is a separate policy-controlled R2 archive; see [Content retention](content-retention.md).

## Current boundary

The enforcement slice covers token-priced model calls. Provider tool-call
fees are not included; unknown dynamic models require manifest pricing or a policy
`requestCostMicros` override. Reservations have a 15-minute lease; streams that
outlast it need a separate reservation-renewal follow-up before this can be
described as a hard invoice cap. Durable Objects remain the authoritative ledger;
the protocol and pricing types live in provider-neutral TypeScript so another durable
backend can implement the same reserve/settle contract.
