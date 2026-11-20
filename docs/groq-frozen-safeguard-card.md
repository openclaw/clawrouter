# Frozen Groq model dispositions

The E01 source is `extensions/groq/openclaw.plugin.json` at OpenClaw
`31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`. Current primary evidence was checked
2026-11-03. These two identities have different dispositions.

## Safeguard 20B

Groq currently lists `openai/gpt-oss-safeguard-20b` as a **preview**, with text
input/output, tool calling, low/medium/high reasoning, 131,072 context tokens and
65,536 maximum output tokens. The public router identity is
`groq/gpt-oss-safeguard-20b`, using the existing Chat endpoint. Default model and
upstream identity stay unchanged; no Responses or media capability is inferred.

Published USD per million tokens: input $0.075, output $0.30, cached input
$0.037 on the model page. The cache guide specifies a 50% discount, yielding
$0.0375. The card uses the higher cached rate and labels settlement as
`published_upper_bound`; it is not a claim of exact invoice reconciliation.
Omitted/default and `on_demand` requests use the same card. Flex uses the same
rates and requires the caller's paid-account entitlement. Performance and auto
remain unqualified; no enterprise tariff is invented.

The declaration depends on the generic conditional-pricing fix in
[PR409](https://github.com/openclaw/clawrouter/pull/409). Plain Chat and ordinary
client functions remain priced. Actual hosted `browser_search` and
`code_interpreter` declarations fail closed before egress under dollar hard
budgets. Function names, message strings and nested user JSON never imply hosted
execution. No unconditional request-fee flag blocks ordinary calls.

Primary sources:

- [Safeguard model and rates](https://console.groq.com/docs/model/openai/gpt-oss-safeguard-20b)
- [Supported models and preview status](https://console.groq.com/docs/models)
- [Cache discount and supported models](https://console.groq.com/docs/prompt-caching)
- [Service tiers](https://console.groq.com/docs/service-tiers)
- [Flex pricing and paid-account availability](https://console.groq.com/docs/flex-processing)

## Qwen 3.6 27B

Groq's current [deprecation notice](https://console.groq.com/docs/deprecations)
states that `qwen/qwen3.6-27b` shut down on **2026-09-14** for free and developer
tiers. Enterprise customers with committed-spend contracts are exempt. Historical
public prices and frozen rows therefore do not establish a generally available
current offer or an enterprise price.

Do not add a public priced working row, silently alias it to Qwen 3.8, or infer
enterprise entitlement. The existing opaque passthrough remains explicitly
unpriced. A separately configured enterprise consumer needs its own access and
contract qualification; no account or commercial changes are part of this slice.
The recommended replacement is outside this frozen model inventory.

## Verification boundary

Focused tests compile the source manifest, exercise native identity and cached
arithmetic, and run the real Worker with the source card injected into its test
catalog. They verify dollar-budget admission, exact upstream dispatch, one
settlement and pre-egress conditional denial. This is synthetic runtime proof,
not a live vendor call or preview entitlement. Generated snapshot integration
stays serialized after PR409, with final-head CI required for the combined tree.
