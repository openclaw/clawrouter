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
separate explicit `policy_fixed` tariff supplies the policy price. Synthetic
compiler/selection tests check this boundary and exact wire model names; they
do not certify the native client or a provider account.
