# Z.AI global standard frozen inventory

This completes the six assigned identities of the existing `zai` standard API
product. Its origin remains `https://api.z.ai/api/paas/v4`, its binding remains
`ZAI_API_KEY`, and native Chat uses `/chat/completions` with the original selected
Bearer credential. The frozen [OpenClaw provider declaration](https://github.com/openclaw/openclaw/blob/31ad71a8addc1d42fbc5478f7e114860f5cbf6c7/extensions/zai/openclaw.plugin.json)
is the provenance for this finite roster and per-model input modalities.

| Native identity | Frozen input | Source disposition |
| --- | --- | --- |
| `glm-5.3` | text | Chat |
| `glm-5.3-flash` | text, image | Chat |
| `glm-5.2` | text | Chat; no Coding Plan alias applied |
| `glm-5-turbo` | text | Chat; no Coding Plan alias applied |
| `glm-5v-turbo` | text, image | Chat |
| `glm-5.1` | text | Global standard Chat explicitly documented; no shutdown or alias inferred |

The frozen catalog marks 5.1 deprecated. The bounded global qualification on
2026-11-04 found its [official model page](https://docs.z.ai/guides/llm/glm-5.1)
still documenting JSON and streaming calls for exactly `glm-5.1` at
`https://api.z.ai/api/paas/v4/chat/completions`. The
[current global model pricing page](https://docs.z.ai/guides/overview/pricing)
also lists GLM-5.1; no tariff is imported by this change. The
[global release notes](https://docs.z.ai/release-notes/new-released) record its
2026-04-07 release. The [migration guide](https://docs.z.ai/guides/overview/migrate-to-glm-new)
recommends a newer model but supplies no GLM-5.1 standard-API shutdown or automatic
alias. These explicit global API/listing facts qualify the native declaration;
the frozen deprecated label alone does not deny execution. No effective retirement
date, new model generation, account entitlement or live success is asserted.
The other five already-qualified cards are unchanged.

Previously qualified primary contracts, checked 2026-11-03, remain the
[native Chat reference](https://docs.z.ai/api-reference/llm/chat-completion),
[thinking guide](https://docs.z.ai/guides/capabilities/thinking-mode) and
[global key classification notice](https://docs.z.ai/devpack/notice/api-key-management).
Caller `tool_stream`, thinking, reasoning and tool-history fields remain intact;
streaming usage, split tool arguments and upstream errors use the existing Chat
transport. No reasoning default, output/context limit or vendor tariff is copied
from the frozen cards.

CN standard and global/CN Coding Plans retain distinct provider IDs, keys and
origins. Their credentials never configure or rescue this global standard route.
A plan's documented alias does not change the same named standard API model.
The issuer must still qualify opaque credential product/region/account ownership;
this provider source does not establish it from Bearer syntax or a key prefix.

`worker/test/zai-global-runtime.test.mjs` compiles the actual manifest and calls
the real Worker with synthetic authority, credential-owner and budget stores.
It covers all six active IDs on native/manifest JSON/SSE routes, replay, original
grant selection, cached usage, one reservation/event, wrong-product isolation,
unknown-price denial, errors, cancellation and selected/observed identity separation. The GLM-5.1 cases preserve its
documented thinking request without copying newer model-specific controls.
Fixtures are prepared, not locally executed: the retained checkout is CODE-ONLY.
Source6 owns the later generated snapshot and exact functional/native consumer
proof. No shared runtime, schema, credential, deployment or live account changes.
