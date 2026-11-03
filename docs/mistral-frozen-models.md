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
therefore omit the frozen client's output defaults. Standard cards reject an
unqualified service tier rather than silently charge the standard rate. Missing
served-tier evidence retains conservative settlement instead of guessing a tariff.

Small's canonical `none`/`high` reasoning values follow the
[reasoning contract](https://docs.mistral.ai/studio/conversations/reasoning).
Actual client handling of typed reasoning chunks still needs client-runtime
fixtures. No Agents, Conversations, built-in tool charges, or newer model IDs are
introduced by these Chat rows.
