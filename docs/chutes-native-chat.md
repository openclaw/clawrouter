# Frozen Chutes Chat cards

Scope is OpenClaw `31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`,
`extensions/chutes/openclaw.plugin.json`, `models.ts` and `provider-catalog.ts`.
Primary checked 2026-11-03. The existing
`deepseek-ai/DeepSeek-V4-Flash-0731-TEE` seed stays unchanged. Exactly five frozen
cards are added under the `chutes/` router prefix; no later generation is added.

| Native selected ID | Frozen input qualified here | Declared context | Declared output |
| --- | --- | --- | --- |
| `deepseek-ai/DeepSeek-V3.2-TEE` | text | 131072 | 65536 |
| `moonshotai/Kimi-K2.6-TEE` | text, image | 262144 | 65535 |
| `zai-org/GLM-5.2-TEE` | text | 1048576 | 65535 |
| `Qwen/Qwen3.6-27B-TEE` | text, image | 262144 | 65536 |
| `Qwen/Qwen3.5-397B-A17B-TEE` | text, image | 262144 | 65536 |

These independent integer limits and tool flags were observed in the primary
[public model catalog](https://llm.chutes.ai/v1/models), rather than inferred
from upstream weight configuration or rounded K/M descriptions. Model-specific
primary guides corroborate the served identities and modalities:
[DeepSeek](https://chutes.ai/docs/models/chutes-deepseek-ai-deepseek-v3-2-tee),
[Kimi](https://chutes.ai/docs/models/chutes-moonshotai-kimi-k2-6-tee),
[GLM](https://chutes.ai/docs/models/chutes-zai-org-glm-5-2-tee),
[Qwen3.6](https://chutes.ai/docs/models/chutes-qwen-qwen3-6-27b-tee) and
[Qwen3.5](https://chutes.ai/docs/models/chutes-qwen-qwen3-5-397b-a17b-tee).
Native capability metadata describes declared support, not a reservation bound,
live account entitlement or an independently measured enforcement guarantee.
Kimi/Qwen documentation mentions additional video behavior; this slice qualifies
the frozen text/image surface only. No TEE badge is inferred from an ID suffix.

## Transport and original credentials

The fixed inference base remains `https://llm.chutes.ai/v1`, POST
`/chat/completions`, OpenAI Chat JSON/SSE and the original selected Chutes Bearer
credential. Model IDs remain exact, including capitalization and `-TEE`.
Configured environment auth reads only `CHUTES_API_KEY`; unrelated provider keys
and `CHUTES_OAUTH_TOKEN` are not environment fallbacks. Public catalog visibility
does not authorize inference. Existing grant selection, revocation, destination
guards, budget preflight and settlement remain with the shared runtime owner.

Actual Worker fixtures compile this source manifest and replace only its existing
bundled row in isolation. Every frozen ID exercises native and manifest JSON/SSE
routes, tool-call/result replay and unchanged native body/selected credentials.
Synthetic split reasoning fields and opaque thinking-tag content prove transport
preservation; they do not promise that every model always emits the same field.
The Kimi primary guide specifically documents `chat_template_kwargs.thinking`
and `preserve_thinking`; the fixture preserves these booleans without converting
them to generic effort names. No unsupported/default effort is advertised.

Frozen `models.ts` sets `supportsUsageInStreaming: false`. The main SSE matrix
therefore omits `stream_options` and terminal counters; input/output/cache usage
remains unknown. A separate observed-usage case proves accounting when counters
are actually supplied. Fragmented tools/reasoning, `[DONE]`, stream errors and
client disconnect retain existing conservative settlement. Disconnect cancels
the local upstream body, not a claimed provider generation-control endpoint.
HTTP failures never trigger a replacement model, product or credential retry.

## Availability and pricing

Frozen Qwen3.5 metadata says deprecated and names Qwen3.6 as a replacement. The
current public catalog and primary Qwen3.5 guide still list the selected ID.
That establishes neither an upstream alias nor shutdown. No dated primary vendor
deprecation cutoff was qualified, so no `availability.effectiveAt` is fabricated.
The native selected ID remains executable only under its own current grant and
policy; the router never rewrites it to the replacement or copies its tariff.
Other absent availability fields likewise do not assert live entitlement.

All cards remain unpriced. Current [Agent Hub](https://chutes.ai/agents) prose
and its table differ on per-token/per-million wording, and model-page exports
can lag the live numeric catalog. The codec preserves observations; this manifest
does not convert them, copy frozen costs or fill unknown cache prices with zero.
Declared context/output facts never create a tariff. Hard upstream-dollar budgets
still reject unknown costs; the synthetic seven-micro fixture policy is explicitly
`policy_fixed` and does not represent a vendor rate.

## Source and integration proof

`worker/test/chutes-native-chat.test.mjs` contains 46 prepared actual Worker cases:
finite source/catalog metadata, twenty native/manifest JSON/SSE combinations,
six image transports, original-policy/model isolation, missing/revoked credentials,
unknown costs, seven HTTP failures, six incomplete/error streams, Kimi controls,
observed SSE usage and the unchanged seed. Hosted execution is required; source
preparation and syntax checks alone do not count as passing those cases.

The paired discovery contract is separate: explicit GET `/models`, canonical
base and paired `chutes.models`; retain provider Bearer configuration for original
grant selection and add no endpoint auth override. Source1 must call the actual
credential-free `chutesCatalogRequest(base, signal)` from landed
[PR654](https://github.com/openclaw/clawrouter/pull/654), with private caller auth
and original-grant filtering. Source3 owns paired compiler validation. Both
published dependencies and actual Worker proof are required before a discovery
endpoint is activated; this manifest adds no such route.

Source2 owns actual native client replay and streaming options. Chutes OAuth
PKCE/token/refresh and common account binding remain separate required work;
this API-key slice does not claim OAuth parity or perform consent/login. Source6
owns a later explicitly assigned snapshot slot and actual client/Worker proof.
No snapshot, shared runtime/compiler/client, host, account or deployment changes.
