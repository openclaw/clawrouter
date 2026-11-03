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
| `glm-5.1` | historical text | Frozen deprecated; no executable capability |

The frozen deprecated label for 5.1 supplies neither a shutdown date nor current
global account eligibility. Its known closed row prevents passthrough revival;
no fabricated `stopped` disposition or silent replacement is declared. The
other rows describe the assigned protocol contract, not a live entitlement or
fresh vendor inventory observation. No new model generation is added.

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
It covers all five active IDs on native/manifest JSON/SSE routes, replay, original
grant selection, cached usage, one reservation/event, wrong-product isolation,
unknown-price denial, errors, cancellation and the closed deprecated identity.
Fixtures are prepared, not locally executed: the retained checkout is CODE-ONLY.
Source6 owns the later generated snapshot and exact functional/native consumer
proof. No shared runtime, schema, credential, deployment or live account changes.
