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

Input reservation uses the declared cache-write rate when the request contains
cache controls. After the response completes, ClawRouter settles reported input,
cached-input, cache-write, and output tokens at the manifest rates and releases
the unused reservation. Streaming SSE responses are inspected inline; bodies
retain backpressure and are not persisted. Missing usage, malformed terminal
events, oversized JSON responses, and interrupted streams remain charged at
the reservation.
Settlement requires a provider terminal marker (`response.completed`,
`message_stop`, or `[DONE]`), not merely a clean transport EOF.

`requestCostMicros` on a policy is an explicit fixed-cost override. Routes
without pricing use the legacy one-micro fallback only when no monthly budget
is configured. Every budgeted call fails closed until its route has versioned
manifest pricing or a fixed policy price. A zero-cost route, such as Anthropic
token counting, skips reservation.

Server-executed tools can add per-call charges that token pricing cannot cover.
Listed-price requests containing those tools fail closed; configure an explicit
`requestCostMicros` override until the manifest declares versioned tool rates.
Client-executed function, custom, namespace, local-shell, and apply-patch tools
remain token-priced. Anthropic web fetch has no separate tool fee, but its
server-side loop has no default fetch limit and can accumulate more tokens than
a single model-window reservation. It therefore also requires a fixed request
price for hard-budget enforcement.

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

Rates are integer micro-US-dollars per million tokens. Update `pricingRef` and
`effectiveAt` together when a provider changes price. Subscription traffic uses
the equivalent public API list price for governance; it is not an invoice for
the subscription.

Long-context tiers are selected conservatively from the preflight input bound
and exactly from reported input usage during settlement. For OpenAI list-priced
routes, ClawRouter pins absent or `auto` service tiers to `default`; premium or
contract-specific service tiers are rejected until their prices are declared.
The bundled OpenAI route is pinned to the global `api.openai.com` endpoint.
Regional data-residency endpoints are not exposed; a regional deployment needs
a separate versioned price with OpenAI's 10% uplift or a fixed policy price.
List-priced Chat Completions streams force `stream_options.include_usage=true`
so successful terminal events can release unused reservation. Known model IDs
retain the same pricing when called through native or manifest proxy routes.
Background Responses are rejected under listed pricing because their initial
response has no terminal usage; configure a fixed per-request policy price
until ClawRouter supports polling and deferred settlement.
The Anthropic Sonnet 4.5 route declares its current 200K context limit;
requests beyond it fail before an oversized reservation can be sent upstream.
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

Codex hosted web search has separate provider-side pricing, so the list-priced
setup disables it. Use a fixed `requestCostMicros` policy before enabling cached
or live hosted search.

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

Clients and gateway adapters may send:

- `X-ClawRouter-Session-Id`
- `X-ClawRouter-Agent-Id`
- `X-ClawRouter-Parent-Agent-Id`
- `X-ClawRouter-Project-Id`
- `X-ClawRouter-Client`

Explicit ClawRouter identifiers take precedence over client-native identifiers.
Recent audit events include the resolved session, agent hierarchy, project,
pricing version, reservation bounds, actual tokens, and settled cost. Prompts
and completions are never stored by the spend-control path.

## Current boundary

The first enforcement slice covers token-priced model calls. Provider tool-call
fees and unknown dynamic models require either manifest pricing or a policy
`requestCostMicros` override. Durable Objects remain the authoritative ledger;
the protocol and pricing types live in provider-neutral Rust so another durable
backend can implement the same reserve/settle contract.
