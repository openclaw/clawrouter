# Frozen MiniMax M3 model facts

The E01 frozen model inventory includes `MiniMax-M3`. The existing MiniMax
manifest now declares its unchanged `minimax/MiniMax-M3` identity on the existing
OpenAI-compatible Chat endpoint. No new provider, transport, model generation,
default model, credential flow or account entitlement is introduced.

Primary evidence checked 2026-11-04:

- [OpenAI compatibility](https://platform.minimax.io/docs/api-reference/text-openai-api)
  names `MiniMax-M3`, a decimal 1,000,000-token context window, text/image/video
  Chat input and the existing `https://api.minimax.io/v1` service. This is not
  1,048,576 tokens. No numeric output ceiling is qualified by that page.
- [Current pricing](https://platform.minimax.io/docs/pricing/overview) publishes
  distinct M3 standard/priority and long-input rates. `priority` is a supported
  service tier, with separate charges; it is not a free performance flag.

The native facts preserve context, input modalities and supported tiers with
their provenance. Missing output limits and whole-request reservation bounds
stay unknown. No published unit rate is converted into a usable price card
without those bounds. Both caller and provider upstream-dollar hard budgets
remain denied; explicit `policy_fixed` accounting stays separately labeled.
Facts do not authorize remote asset fetching or prove live multimodal delivery.

The existing M2.7 row is unchanged. Its dated PAYG retirement/account-cohort
notice and separate plan alias require their own disposition; neither is inferred
from this M3 addition. The distinct M3.1 Flash preview identity is also not
silently replaced with M3.1 Flash. Other MiniMax regional, Anthropic and OAuth
contracts retain their owners and activation prerequisites.

Four focused cases cover exact compiled facts, selected-key Chat preparation,
tier preservation, both hard-budget levels, explicit fixed charges and unchanged
legacy/default/passthrough behavior. Snapshot generation and actual-client proof
remain with the serialized integration owner; static facts alone do not certify
runtime or account parity.
