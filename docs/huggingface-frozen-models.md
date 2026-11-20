# Hugging Face frozen model identities

The OpenClaw comparison is pinned to `31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`,
`extensions/huggingface/openclaw.plugin.json`. This change adds only its exact
`deepseek-ai/DeepSeek-R1`, `deepseek-ai/DeepSeek-V3.1` and `openai/gpt-oss-120b`
identities. The existing `openai/gpt-oss-120b:fastest` default stays first.

## Transport and availability evidence

Checked 2026-11-03. [Hugging Face routing documentation](https://huggingface.co/docs/inference-providers/en/index)
qualifies OpenAI-compatible Chat Completions at
`https://router.huggingface.co/v1/chat/completions`. Unsuffixed IDs select the
fastest available provider. Native policy/provider suffixes remain verbatim;
ClawRouter does not choose or pin an underlying host.

The public Hub inference-provider mappings listed conversational hosts for all
three identities at the check date:

- [R1](https://huggingface.co/api/models/deepseek-ai/DeepSeek-R1?expand=inferenceProviderMapping): Novita live.
- [V3.1](https://huggingface.co/api/models/deepseek-ai/DeepSeek-V3.1?expand=inferenceProviderMapping): Featherless and DeepInfra live; Novita reported an error.
- [OSS 120B](https://huggingface.co/api/models/openai/gpt-oss-120b?expand=inferenceProviderMapping): multiple live hosts, including Groq, Cerebras and Fireworks.

These observations establish catalog availability, not a live authenticated
request or a uniform capability guarantee. Model cards qualify text input.
Selected-provider context/output limits, reasoning controls, tool support and
cache behavior are deliberately not inferred from local-weight specifications
or from the frozen client's 131072/8192 defaults.

## Cost boundary

[Hugging Face billing](https://huggingface.co/docs/inference-providers/en/pricing)
passes through selected-provider rates; account credits and custom-provider
keys affect who is billed. All three rows remain explicitly unpriced, as does
the existing suffix passthrough. The frozen zero OSS rate does not mean free
inference. Neither old DeepSeek rates nor another provider's card qualifies this
router's unknown selected provider.

A caller/provider dollar budget rejects these rows before dispatch unless a
separate explicit `policy_fixed` tariff supplies the policy price. Compiler and selection tests check this boundary and exact wire model names.
The controlled native route below is separate from provider-account entitlement.

## Registered client qualification

The dedicated `huggingface-frozen` consumer pins OpenClaw
`d8bb939408aa4d2be7df0161748edb52ebf3b1fb`. It registers the real Hugging Face
plugin, reads its unauthenticated static catalog, and uses the public
`openai-completions` stream and simple-stream entrypoints at a configured Worker
base URL. Authenticated live discovery is a different route and is not exercised.
The SDK onboarding default is R1; ClawRouter keeps its existing fastest OSS default
and display name. Static SDK prices and 131072/8192 limits do not qualify Router
prices, selected-host capacity or entitlement.

The 19 controlled cases cover all three identities, exact native routing at
`/v1/native/huggingface/v1/chat/completions`, and unchanged fastest/cheapest/
preferred/provider suffixes. Captured registered-provider scope surrounds the
actual sanitizer across its asynchronous work; matching synthetic tool history
then passes through the real converter and public stream. This tests transport
preservation, not live host tool capability. Distinct poisoned SDK environment
tokens and Router fallback credentials must never replace the selected proxy
credential or final upstream key.

Unknown-tariff dollar-budget requests must fail before upstream dispatch.
Successful transport cases explicitly use a synthetic seven-micro policy-fixed
price, including error and cancellation reservations; this is not vendor pricing.
Each authenticated attempt has a bound SQLite usage receipt and exact budget
settlement. An invalid unauthenticated proxy token does not claim a usage event.

Fragmented EOF, controlled embedded provider error and real post-content caller
cancellation retain original acquisitions, read/closed promises, release calls,
Worker handlers and source producer/waitUntil joins. Independent failures,
including falsey reasons, remain fatal. Cancellation uses the bound first logical
Worker outcome and complete source retirement, not a native read-error causal
claim. It does not qualify physical pre-header disconnect propagation.

The snapshot adds only these three unpriced models. Existing provider records,
credentials, defaults and pending-work contracts remain unchanged. Local controls
are separate from exact-head hosted qualification; the PR records the actual
hosted verdict. No deployment or account activation is performed.
