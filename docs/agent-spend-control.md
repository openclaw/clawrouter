# Agent spend control

ClawRouter enforces centralized model budgets with pre-request reservation and
post-response settlement. Provider credentials remain server-side; clients use
a ClawRouter credential and receive only the providers and models allowed by
their policy.

## Reading costs and budgets

Dashboard and Usage show **accounted spend** for the last 30 days. This total
can include token-based estimates, fixed policy tariffs, and retained
reservation estimates; it is not a provider invoice. Unpriced calls are counted
separately. Recent request rows label their recorded accounting basis:

| Label | Meaning |
| --- | --- |
| Token-based estimate | Reported usage priced at declared rates. A published rate upper bound is labeled separately when recorded. |
| Fixed policy tariff | The operator's configured request amount, including an explicit zero. |
| Retained reservation estimate | Usage was incomplete or dispatch outcome uncertain. |
| Accounted · no charge | The recorded `none` basis, shown as `$0.00`. |
| Price unavailable | No complete price is available; the call is excluded from accounted spend. |
| Accounting basis unavailable | A historical or unknown basis; the recorded amount is preserved. |

Fusion detail covers the calls visible in the recent-event window. Partial
groups stay labeled partial; their sum does not replace the 30-day totals.
Budget balances use the **UTC calendar month**. **Used** includes outstanding
reservations, and **remaining** is the capacity reported by that budget ledger.
Shared policy pools, per-principal balances, and provider-wide budgets stay
separate. No cap at one scope does not remove other policy or provider limits.
Unavailable balances remain unknown; failed refreshes keep their last-known
timestamp and stale warning.

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
response with `cost_basis: none`. Refusals after output begins remain billable.
Explicit fixed policy prices still apply independently of upstream token billing;
successful fixed zero and positive tariffs retain `cost_basis: policy_fixed`.

`requestCostMicros` on a policy is an explicit fixed-cost override. Routes
without pricing use the legacy one-micro fallback only when no monthly budget
is configured. Every budgeted call fails closed until its route has versioned
manifest pricing or a fixed policy price. A zero-cost route, such as Anthropic
token counting, skips reservation.

Gemini native requests containing `fileData` or `inlineData`
reserve the full declared input window, including media in system instructions
or typed function-response parts. With the bundled Standard Gemini 3.5 Flash
rate card, 1,048,576 input tokens reserve **$1.572864 before output**.
`generationConfig.maxOutputTokens` [bounds thinking and visible output together](https://ai.google.dev/gemini-api/docs/generate-content/thinking#token-limits-and-max_output_tokens);
`candidateCount` multiplies that bound. For example, 100 output tokens and one
candidate add $0.000900, for a total reservation of **$1.573764**.

Each configured policy and provider monthly budget must have enough unreserved
headroom for the entire request. Otherwise ClawRouter returns HTTP 402 before
dispatch, even for a small media request. This corrected bound
also applies to existing callers after upgrading. Increase the applicable budget
headroom, or explicitly choose the fixed `requestCostMicros` policy tariff when
that accounting model fits your deployment. A fixed tariff records the operator's
chosen amount rather than measured provider charges.

These amounts reserve budget capacity. Complete valid response usage settles
the reported input, cache hits, visible output, and thinking tokens at the manifest
rates and releases the unused reservation. Missing or malformed usage retains
the reservation, as for other providers. The reservation is not an upstream
invoice charge.

Native Gemini `serviceTier` (or `service_tier`) selects Standard, Flex, or
Priority pricing. Omitted, null, and `unspecified` select Standard; OpenAI's
`default`, `auto`, and `fast` strings are not native Gemini aliases. Unknown or
malformed tiers require a fixed tariff when either monthly budget is enabled;
unmetered requests still forward.

The September 23, 2026 [Gemini 3.5 Flash price snapshot](https://ai.google.dev/gemini-api/docs/pricing#gemini-3.5-flash)
uses these USD rates per million tokens; the snapshot date does not claim an
upstream price change:

| Tier | Input | Cached input | Output, including thinking |
| --- | ---: | ---: | ---: |
| Standard | $1.50 | $0.15 | $9.00 |
| Flex | $0.75 | $0.08 | $4.50 |
| Priority | $2.70 | $0.27 | $16.20 |

[Flex never upgrades automatically](https://ai.google.dev/gemini-api/docs/generate-content/flex-inference),
so its reservation uses Flex rates. [Priority can downgrade to Standard](https://ai.google.dev/gemini-api/docs/generate-content/priority-inference),
so its reservation covers both. Settlement uses the returned
`usageMetadata.serviceTier` and `x-gemini-service-tier` header: one known source
or matching sources establishes the tier; conflicting or invalid evidence
retains the reservation. With neither source, Standard and Flex retain their
documented service, while Priority retains its reservation. Tier headers do
not supply missing token usage. Fixed tariffs and incomplete hosted-tool prices
keep their existing accounting rules.

Token rates alone do not always describe a complete request price. Sonar Pro has
a [mandatory request fee](https://docs.perplexity.ai/docs/sonar/models/sonar-pro),
including its default search mode. Its manifest retains the known token rates
and declares `pricing.unpricedCosts: [request_fee]` until fee metering is available.
The documented example of 26 input and 832 output tokens costs $0.018558 including
the low-context fee, rather than the token-only $0.012558.

ClawRouter also recognizes these incomplete request prices by wire format:

- OpenAI Responses web search (including dated variants), file search, code
  interpreter, image generation, and shell tools with hosted container
  environments, including Responses Lite `additional_tools` and
  [tool search `tool_search_output` input declarations](https://developers.openai.com/api/docs/guides/tools-tool-search#understand-what-gets-loaded);
  Chat `web_search_options`; Anthropic `web_search_*` and separately billed
  `code_execution_*`.
- OpenAI Responses MCP, programmatic tool calling, hosted tool search, and
  `multi_agent.enabled`. Their server work lacks a qualified cumulative
  reservation bound. Hosted tool search is conservatively unqualified under
  measured budgets; this does not assert a separate fee or an observed overrun.
- Anthropic web fetch, fee-waived code execution, advisor, server tool search,
  and MCP toolsets/server declarations. Server tool loops can accumulate input
  across iterations; one context window does not bound the total.
- Anthropic `context_management.edits` with `compact_20260112` and on-demand
  `compaction: {type: summarize}`. [Compaction usage](https://platform.claude.com/docs/en/build-with-claude/compaction-on-demand#count-compaction-usage)
  is billed through iterations outside the ordinary top-level totals.
- Opaque Responses `prompt` references, because
  [saved prompts retain tool configuration](https://developers.openai.com/api/docs/assistants/migration).
- Gemini Google Search, legacy search retrieval, and Maps grounding fees.
- Gemini URL context, File Search, code execution, and MCP servers, whose hosted token work
  is not fully bounded or metered by the ordinary model counters. A tool can
  have no separate fee and still make token-only settlement incomplete.
- Gemini `cachedContent` references, because a
  [cached resource can retain tools and tool configuration](https://ai.google.dev/api/caching).
  The opaque reference cannot establish a complete token-only request price.

These calls return `pricing_required` before dispatch when either policy or
provider has a monthly budget and no fixed policy price. Choose a model/request
with complete token pricing, or let the operator set an explicit fixed tariff.
This applies to existing callers after upgrading, including native and manifest
proxy routes and every Responses WebSocket turn.

With both monthly limits disabled, these requests still forward. Their
billable usage records zero accounted micros with `cost_basis: unpriced_usage`,
meaning **price unavailable**, even when complete tokens and a known served tier
are returned. Pre-dispatch denials and proven nonbillable responses remain known
zero. Free token counting and fixed policy tariffs keep their existing behavior.
Model discovery and Fusion preflight apply the same completeness guard for both
policy and provider budgets. Unmetered models remain available; Fusion displays
their incomplete prices as unavailable rather than a zero-cost estimate.
Anthropic [waives code-execution fees](https://platform.claude.com/docs/en/agents-and-tools/tool-use/code-execution-tool#usage-and-pricing)
when `web_fetch_20260209`, `web_search_20260209`, or a later version is present;
the waived combination still needs a fixed tariff under a measured budget
because cumulative server-loop token usage is unqualified. Web search retains
its separate fee. This does not introduce a tool-fee or sub-inference meter.
Client-executed function, custom, namespace, local-shell, and apply-patch tools
use the model's token rates, as does OpenAI tool search with `execution: client`.
Claude client tools, historical compaction blocks, and `clear_*` context edits
do not introduce these server-work gaps. A function named `web_search` is still
a function.
A fixed `requestCostMicros` is an operator-defined
tariff, not a measurement of provider tool charges.

Responses requests with a nonempty `previous_response_id` also consume the
parent response's durable tool-pricing evidence before reservation. Only a
final `token_only` proof allows ordinary token pricing. Retained hosted
fees or server work remain unpriced even when the delta omits their declarations.
Legacy, pending, corrupt, future-version, and otherwise unknown evidence returns
`pricing_required` under either measured budget; fixed tariffs and unmetered
requests keep the behavior above. A served tier or token total cannot clear this
captured gap. Enabling a provider budget can therefore reject an existing chain
without changing the policy generation. Missing, expired, or changed routing
ownership still returns `continuation_restart_required` instead.

Deploy the durable proof producer before this consumer. The upgrade does not
drain old writers, promote pending rows, or infer proof from a lost publication
acknowledgment: each request uses the authoritative evidence present when it
resolves its parent. An already-captured unknown remains unknown for that request.
Start a supported token-priced request without the response ID, or configure an
explicit fixed tariff, when an older chain has no qualified proof. Turn-state
aliases remain routing affinity and never certify inherited tool prices.

This boundary covers response-ID ancestry only. Full-input conversation and
`item_reference` state, encrypted compaction witnesses, and complete compaction
metering remain separate work. A producer-observed opaque compaction can leave
a response row unknown; this change does not certify it or disable all full-input
sessions. Root `tools` remain current-request configuration, not automatically
inherited declarations.

Complete hosted-tool metering remains unqualified. The published
[OpenAI tool prices](https://developers.openai.com/api/docs/pricing) and
[search contract](https://developers.openai.com/api/docs/guides/tools-web-search)
do not establish a complete mapping from returned input usage to separately billed
search content, the mini-model 8,000-token block, multiple queries per action, or
failed/incomplete search charges. The
[search usage API](https://developers.openai.com/api/reference/python/resources/admin/subresources/organization/subresources/usage/methods/web_search_calls)
can support later reconciliation. Complete metering needs provider clarification
or isolated upstream usage/cost reconciliation, plus a demonstrated finite bound
on cumulative input and tool work. Anthropic also charges
[searches separately](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool),
while [web fetch](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-fetch-tool)
has no additional tool fee. OpenAI containers and generated images need their
own [billing contracts](https://developers.openai.com/api/docs/pricing), rather
than a guessed flat fee per model response. Gemini
[tool pricing](https://ai.google.dev/gemini-api/docs/pricing) and
[URL-context usage](https://ai.google.dev/gemini-api/docs/generate-content/url-context)
include hosted work beyond ordinary prompt and candidate counters. ClawRouter
preserves reported token counts and totals without claiming they account for
every charged dimension. This guard does not claim an upstream invoice cap.

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

## Speech character estimates

OpenAI [`tts-1`](https://developers.openai.com/api/docs/models/tts-1) has a
published rate of $15 per million input characters. Send a JSON speech request
to `/v1/audio/speech` with `model: "openai/tts-1"`, `input`, and `voice`, or use
`/v1/native/openai/v1/audio/speech` with the native `tts-1` model spelling.
The manifest route `/v1/proxy/openai/speech` accepts the same request inside
its `body` envelope. API-key grants and configured API keys are supported;
subscription grants remain Responses-only.

The [speech API](https://developers.openai.com/api/reference/resources/audio/subresources/speech/methods/create)
accepts at most 4096 input characters. ClawRouter validates 1–4096 Unicode code
points before reserving either budget. Other speech fields pass through;
`response_format` selects MP3, Opus, AAC, FLAC, WAV, or PCM, and `speed` retains
its upstream meaning. ClawRouter rejects `instructions` and SSE for `tts-1`;
`stream_format`, when supplied, must be `audio`. The manifest declares separate
`openai.audio_speech` JSON request and `audio.binary` response formats.

Admission reserves UTF-8 input bytes at 15 micros each, up to 245,760 micros.
Only nonempty successful `audio/*` or `application/octet-stream` delivery through
EOF settles to input code points at 15 micros each, up to 61,440 micros. The
usage basis is `request_character_estimate`, not an invoice or token usage.
Empty audio, wrong MIME, cancellation, and unknown dispatched outcomes retain
the reservation; known HTTP rejection and known-unsent failures remain no-charge.
Explicit fixed tariffs, including zero, keep their existing precedence. Catalog
availability remains request-dependent rather than promising that every input
fits the remaining balance.

When existing content-retention policy requires it, the request JSON includes
the speech input text. Generated audio is streamed without buffering or archiving;
all token fields stay null. Transcription, multipart requests, Realtime, and
other speech models are outside this contract.

## Per-provider budgets

Provider connections can set a monthly budget that applies tenant-wide to all
traffic routed to that provider, independent of policy and principal budgets.
The UTC calendar-month ledger uses the same conservative reservation and actual
cost settlement flow as policy budgets. Both limits must admit a request; an
exhausted provider limit returns HTTP 402 with `provider_budget_exhausted`.
Leaving the provider budget blank keeps the provider unmetered and adds no
provider-ledger call to the request path.

Policy, principal, and provider budgets have distinct logical scopes, even when
their identifiers share a storage address. For example, tenant `provider` with
policy `openai` does not consume the OpenAI provider budget twice. Admission and
budget status use the same scope recorded on each reservation receipt.

Upgrades keep existing storage addresses, monthly balances, and settlement
receipts. Older charges lack a scope tag and cannot be reliably separated, so
they remain shared conservative debt for their original monthly window. Late
settlement updates that original receipt; it never moves debt into a new month.
No operator migration or budget reset is needed. During mixed-version deployment,
older callers conservatively count all charges in the shared window. Rolling back
to the durable-settlement implementation also retains every charge, but restores
that shared-budget behavior until re-upgrade. Rollback to versions predating
durable settlement is not covered by this compatibility guarantee.

Rates are integer micro-US-dollars per million tokens. Update `pricingRef` and
`effectiveAt` together when a provider changes price. Subscription traffic uses
the equivalent public API list price for governance; it is not an invoice for
the subscription.

Together GLM-5.2 uses the [published 1,048,575-token context ceiling](https://docs.together.ai/docs/serverless/models)
for input reservation and retains its [131,072-token output limit](https://www.together.ai/models/glm-52).
The September 23, 2026 snapshot corrects the earlier 262,144-token ceiling;
it does not mark a provider price change. Rates remain $1.40 input, $0.26 cached
input, and $4.40 output per million tokens. A full-window input bound with a
1,000-token output limit reserves **$1.472405** in each configured budget.
Existing callers with less headroom receive HTTP 402 before dispatch. Complete
reported usage settles at the same rates and releases unused capacity; this
reservation is not an upstream invoice charge.

Bundled dated pricing also covers Together GLM-5.2, DeepSeek V4 Flash,
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
requested tiers fail with `pricing_required` when either the policy or provider
has a monthly budget. When both limits are disabled, existing and new policies
continue forwarding the requested tier unchanged. Explicit fixed policy tariffs
remain available. A short-only card stays in the reservation
envelope when actual input may fit below its published limit.

Settlement uses the actual served tier from JSON, terminal Responses SSE, or
Chat Completions chunks followed by `[DONE]`. A priority request served as
`default` is charged Standard rates. Missing or unknown served tiers, unpublished
context ranges, and incomplete token usage retain the reservation and record
`cost_basis: manifest_reservation`; measured costs record `manifest_pricing`.
Usage events include `requested_service_tier` and `served_service_tier`.
For unmetered requests with an undeclared requested tier, a known served tier and
complete usage still produce a measured price. Otherwise, the event records
`cost_basis: unpriced_usage` and zero accounted micros. This means the price
is unavailable, not that the request was free. Summary, provider, and daily usage
include `unpricedRequestCount`; spend totals exclude these unavailable prices.
The console marks them as unavailable or reports the known subtotal with the
unpriced count. Pre-dispatch denials and nonbillable responses do not increment this count.
Dispatched requests whose transport fails before response headers have no complete
usage. Token-priced calls retain their qualified estimate with
`cost_basis: manifest_reservation`; fixed tariffs remain `policy_fixed`, and
unpriced calls remain `unpriced_usage`. An estimate is not measured upstream spend.
This replaces the earlier zero-charge policy for pre-response transport failures:
missing headers cannot prove that upstream work was free. Pre-dispatch failures
still release reservations to zero; HTTP error and cancellation outcomes are unchanged.
Historical admission denials marked `unpriced_service_tier` remain known zero. No policy migration or new setting is required.
New known-unsent and nonbillable outcomes record `cost_basis: none`, while
preserving their original reservation and observed token fields. A zero amount
alone does not establish this basis: free manifest rates retain their pricing
basis, and unavailable prices remain `unpriced_usage`. Existing event strings
and stored usage history are not rewritten.
The bundled OpenAI route is pinned to the global `api.openai.com` endpoint.
Regional data-residency endpoints are not exposed; a regional deployment needs
a separate versioned price with OpenAI's 10% uplift or a fixed policy price.
Request `stream_options.include_usage=true` for Chat Completions streams
so successful terminal events can release unused reservation. Known model IDs
retain the same pricing when called through native or manifest proxy routes.
Declared background Responses retain the original reservation while the router
collects terminal usage for up to one hour from admission. This is a router
collection limit, not an upstream storage guarantee; `store: false` does not
promise results remain retrievable for that hour. Missing usage, upstream 404,
or a disconnected caller does not establish a refund. A known-unsent creation
releases its original holds, while uncertain dispatched work retains the
conservative amount. JSON/SSE create, retrieve, cancel and collection share one
immutable accounting event; repeated controls do not create new charges.
Successful pending observations poll again after five seconds. Observation errors
back off to at most 30 seconds; these are router scheduling policies, not a
provider retention guarantee. Financial retries keep their separate backoff.

Financial recovery retries that frozen receipt automatically until seven days
after admission. Authenticated operator replay remains available until 44 days
after admission. Neither path repeats the generation request or resets the
deadlines. Policy, provider and usage acknowledgements are independent; an absent
or conflicting budget receipt remains unresolved. Usage retention expiry is not
a financial acknowledgement. At day 44, unresolved recovery is marked expired,
not paid. Each authorization scope admits at most 16 active admissions/collections
and 64 total recovery records, including evictable completed summaries. Serialized
job metadata is capped at 64 KiB at admission and subsequent transitions; this is
not a bound on the SQLite file's physical size. Raw response IDs and collection
headers are erased when collection ends; the original 30-day continuation binding
can still authorize caller-supplied response IDs without reopening accounting.
See the [background API and recovery operator contract](api-reference.md#background-responses).
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

The enforcement slice covers token-priced model calls and rejects known incomplete
request prices under measured budgets. Provider request/tool fees and cumulative
hosted-tool work are not metered; unknown dynamic models require manifest pricing or a policy
`requestCostMicros` override. This is not a hard provider invoice cap.

Reservations have a 15-minute admission lease. Before upstream dispatch, both
policy and provider ledgers must record that the request may incur charges.
Expired reservations that never reached this transition settle to zero. Dispatched
work retains its conservative charge across lease expiry, including long HTTP
streams and delayed settlement recovery. Complete usage can replace that estimate
once; identical settlement retries are idempotent and conflicting final charges
are rejected. Missing or unconfirmed settlement receipts remain retryable.

Receipts expire 45 days after reservation creation, beyond the current UTC month
and the documented four-day dead-letter recovery window. Delayed work must settle
within that retention period. Existing reservations preserve their ledger address,
month, and charge; migration treats their unknown dispatch state conservatively.
Older binaries retain conservative expiry receipts but do not clean that new state
until the upgraded code runs again. No operator migration or budget reset is needed.

Durable Objects remain the authoritative ledger;
the protocol and pricing types live in provider-neutral TypeScript so another durable
backend can implement the same reserve/settle contract.
