# GPT-6.2 Astra and Sol

The OpenAI manifest registers `openai/gpt-6.2-astra` and
`openai/gpt-6.2-sol`. Existing defaults, model pins, other model cards and
credential configuration are unchanged. This is a source-owned catalog addition,
not automatic registration of upstream discovery results.

## Provenance and route boundaries

Checked on 2026-11-17:

- OpenAI's [release announcement](https://openai.com/index/introducing-gpt-6-2-astra-sol/)
  establishes the exact IDs and API/subscription release.
- Account-scoped ChatGPT discovery at
  `https://chatgpt.com/backend-api/codex/models?client_version=<client-version>`
  returned both IDs, text/image input and reasoning choices. The existing OpenClaw
  OpenAI provider obtains this through its prepared subscription credential;
  explicit model refresh reacquires that inventory. No credential or backend
  prompt templates belong in the provider manifest.
- That subscription catalog reported an 872,000-token maximum and preferred
  runtime context of 272,000 for Astra and 500,000 for Sol. The preferred runtime
  contexts are retained as `contextTokens`, not as API input or billing ceilings.
- The [Astra](https://developers.openai.com/api/docs/models/gpt-6.2-astra)
  and [Sol](https://developers.openai.com/api/docs/models/gpt-6.2-sol) API model
  pages independently establish a 1,050,000-token context window, 922,000 maximum
  input and 128,000 maximum output. Subscription limits are not substituted for
  these public API limits.
- The [migration guide](https://developers.openai.com/api/docs/guides/latest-model)
  qualifies Chat and Responses, with tool calling restricted to Responses.
  Sampling/logprob fields are unsupported. The guide recommends starting with
  `medium`; it does not establish the API default when effort is omitted, so no
  default is declared here. `none` and `minimal` are not qualified. The existing shared effort domain
  advertises `low`, `medium`, `high`, `xhigh`, and `max`; the subscription-only
  observation of `ultra` does not extend that shared API contract.
- Existing public [compaction](https://developers.openai.com/api/docs/guides/compaction)
  and [input-token counting](https://developers.openai.com/api/docs/guides/token-counting)
  routes receive explicit model/product bindings. Their existing API-key,
  account-affinity, stateless-counting and budget restrictions remain in force.

API-key products expose Chat, Responses, compaction and counting. Stored
subscription grants expose only ordinary HTTP Responses, through the existing
ChatGPT transport. No subscription WebSocket, public compaction/counting or
response-lifecycle support is added. Discovery is availability evidence, not
proof that every account can execute either model.

## Pricing: current published rates

The [published tariff](https://developers.openai.com/api/docs/pricing) gives
Standard input/cached-input/output rates per million tokens of $8/$0.40/$40 for
Astra and $2/$0.10/$10 for Sol. Above 272,000 input tokens, input and cache rates
double and output rates increase 1.5 times for the entire request. Fast uses
twice Standard, represented by the existing `priority` tier and `fast` alias.
Flex is not published for these models and is not advertised. Batch is a
separate API, not a synchronous service tier.

- Cache writes use the published **default 30-minute rate**: $10/M Astra and
  $2.50/M Sol before long-context/tier multipliers, matching the ordinary tariff
  convention of the existing GPT-6 Astra card.
- Ultrafast uses the **current 3x promotion rate**, valid through 2027-02-28.
  OpenAI publishes 6x starting 2027-03-01 Pacific time. These static cards must
  be updated before that change; no automatic date transition is implemented.
- No `settlementBasis: published_upper_bound` override is declared. The new
  cards use the same ordinary manifest-pricing accounting as GPT-6 Astra.
- Explicit 12-hour cache writes are a different tariff ($20/M Astra, $5/M Sol
  at short-context Standard). The existing schema does not select prices by
  request TTL or per-breakpoint TTL; these cards do not claim accurate 12-hour
  accounting. Background discounts are likewise not represented.

Hosted web-search preview calls have explicit $0.01 entries; other tool fees
and account eligibility are not inferred. No pricing engine or hot-path code
is changed.

## Verification boundary

All provider manifests and the generated snapshot are validated. The focused
GPT-6.2 test additions were removed at the owner's request; existing test files
remain unchanged. Current rates and long-context/tier multipliers are checked
against the compiled cards without adding test files. No paid model call or
deployment is part of this catalog change.
