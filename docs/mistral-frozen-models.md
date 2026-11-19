# Frozen Mistral Chat identities

These five identities come from `extensions/mistral/openclaw.plugin.json` at
OpenClaw `31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`. The source manifest retains
those exact upstream names and qualifies their facts against Mistral's primary
sources checked on 2026-11-03. Existing default model ordering is unchanged.

| Identity | Primary model source | Pricing disposition |
| --- | --- | --- |
| `codestral-latest` | [Codestral 25.08](https://docs.mistral.ai/models/codestral-25-08) | Standard input/cache/output: $0.30/$0.03/$0.90 per million tokens |
| `mistral-small-latest` | [Small 4](https://docs.mistral.ai/models/mistral-small-4-0-26-03) | Standard input/cache/output: $0.15/$0.015/$0.60 per million tokens |
| `devstral-medium-latest` | [Devstral 2](https://docs.mistral.ai/models/devstral-2-25-12) | Deprecated; no qualified current tariff |
| `mistral-large-latest` | [Large 3](https://docs.mistral.ai/models/mistral-large-3-25-12) | Deprecated; no qualified current tariff |
| `mistral-medium-2508` | [Medium 3.1](https://docs.mistral.ai/models/mistral-medium-3-1-25-08) | Deprecated; no qualified current tariff |

The model pages' alias lists explicitly include the requested `latest` names.
[Current pricing](https://docs.mistral.ai/inference/pricing) qualifies Codestral
and Small. Deprecated identities do not inherit a replacement's prices. Their
catalog presence does not establish current account access or live availability.

The price cards reserve a full context ceiling when an output limit is omitted;
this is not a declaration of a provider default or maximum output. Model facts
therefore omit the frozen client's output defaults. The [Priority Tier contract](https://docs.mistral.ai/inference/priority-tier)
qualifies a 1.75× multiplier on all rates. `auto` reserves that premium;
`standard_only` uses the standard card. Unknown tiers are rejected. Missing
served-tier evidence retains conservative settlement instead of guessing a tariff.

Small's canonical `none`/`high` reasoning values follow the
[reasoning contract](https://docs.mistral.ai/studio/conversations/reasoning).
The registered-client fixture exercises typed reasoning chunks, exact model and
credential selection, `max_tokens`, and the captured Mistral replay hook's
nine-character tool IDs through the public OpenClaw stream entrypoint. It pins
OpenClaw `d8bb939408aa4d2be7df0161748edb52ebf3b1fb`; that runtime pin is separate
from the frozen identity evidence above. Its Large default and non-deprecated
Large catalog metadata do not replace ClawRouter's existing Medium default or
the dated tariff disposition in this document.

The fixture uses policy-fixed synthetic charges to exercise the three unpriced
identities without inventing vendor prices. Separate hard-budget cases require
zero upstream dispatch and zero charge for those same unpriced models. Codestral
and Small also use their actual manifest tariffs, including cached tokens,
standard/standard_only and Priority/auto selection through the supported SDK
payload callback. Every authenticated attempt requires its own SQLite receipt.

Cancellation is after actual partial response delivery. Acceptance requires the
SDK's original guard acquisition, reader and release, the Worker's exact first
caller outcome, source cancellation and joined producer/callback work without
expiry, and cancellation accounting. Retained read rejections are not rewritten
as fulfillment. Independent source, release, observer and cleanup failures stay
fatal. This does not qualify physical disconnect propagation before response
headers. Provider-error cleanup separately requires the controlled SSE error,
the actual SDK error callback and returned output.

Native qualification comes from a fresh successful hosted consumer on the exact
PR head, not from fixture authorship or another provider's result. No Agents,
Conversations, built-in tool charges, or newer model IDs are introduced by these
Chat rows. Synthetic transport responses do not establish live account access.
