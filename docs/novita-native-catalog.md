# Novita frozen Chat inventory

Frozen source: OpenClaw `31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`,
`extensions/novita/{openclaw.plugin.json,index.ts}`. Preserve the existing
`stepfun/step-3.7-flash` seed and add exactly the seven frozen Chat identities.
The frozen plugin uses strict refreshable discovery, configured-catalog
augmentation, OpenAI tool compatibility and reasoning-preserving replay.
Its separate video provider remains with the media owner.

## Qualified finite facts

Checked 2026-11-03 against each primary model page. Exact context and output
integers also appear in those pages' public `contextSizeValue` and
`maxOutputTokensValue` payloads; rounded labels such as 977K are not used as
integer bounds. All seven pages explicitly qualify function calling. Inputs
below stay within the frozen surface; newly documented video input is excluded.

| Exact native ID and primary page | Context | Maximum output | Input |
| --- | ---: | ---: | --- |
| [moonshotai/kimi-k3](https://novita.ai/models/model-detail/moonshotai-kimi-k3) | 1048576 | 1048576 | text, image |
| [moonshotai/kimi-k2.7-code](https://novita.ai/models/model-detail/moonshotai-kimi-k2.7-code) | 262144 | 262144 | text, image |
| [minimax/minimax-m3](https://novita.ai/models/model-detail/minimax-minimax-m3) | 1000000 | 131072 | text, image |
| [zai-org/glm-5.2](https://novita.ai/models/model-detail/zai-org-glm-5.2) | 1048576 | 131072 | text |
| [deepseek/deepseek-v4-pro](https://novita.ai/models/model-detail/deepseek-deepseek-v4-pro) | 1048576 | 393216 | text |
| [qwen/qwen3.7-max](https://novita.ai/models/model-detail/qwen-qwen3.7-max) | 1000000 | 65536 | text |
| [minimax/minimax-m2.7](https://novita.ai/models/model-detail/minimax-minimax-m2.7) | 204800 | 131072 | text |

The [Kimi K3 quick start](https://blogs.novita.ai/kimi-k3-api-quick-start/)
independently confirms both exact 1048576 limits and the versioned HTTP base.
Frozen M2.7 has a deprecated/replacedBy hint, but its current primary page still
offers it. No dated cutoff or upstream alias was qualified; do not fabricate
one, rewrite it to M3 or copy a retirement from another provider. Public model
pages establish documented contracts, not eligibility for a particular account.

## Wire contract

The [Chat reference](https://docs.novita.ai/api-reference/model-apis-llm-create-chat-completion)
specifies POST `https://api.novita.ai/openai/v1/chat/completions`, JSON and Bearer
authentication. Preserve `NOVITA_API_KEY`/the original selected direct grant.
`novita-ai` and `novitaai` remain routing aliases for this same provider; they
are not alternate services or credentials. SDK examples omitting `/v1` do not
override the explicit current HTTP path. No foreign provider-key fallback.

Preserve native `tools`, `tool_choice`, response schema fields, exact selected
model, `reasoning_content` and fragmented SSE. `separate_reasoning` and
`enable_thinking` are independent native controls, not evidence for an effort
menu or an injected default. The
[interleaved-thinking contract](https://docs.novita.ai/guides/llm-interleaved-thinking)
requires retaining M3's entire assistant message, including `reasoning_details`,
`tool_calls` and `content`, across tool results. Its `reasoning_split` request
flag and structured reasoning segments remain opaque on both Worker routes.

Native terminal usage reports prompt, completion and total tokens. The
[prompt-cache guide](https://docs.novita.ai/guides/llm-prompt-cache) qualifies
`prompt_tokens_details.cached_tokens`; this is a subset of input, not an extra
charge. Missing usage stays unknown, including interrupted delivery. Synthetic
policy-fixed charges in tests are independent of all vendor price observations.

## Price and interruption boundaries

Primary model pages publish USD-per-million rates. M3 has separate input-length
tiers: input/output/cache-read 0.3/1.2/0.06 below 524288 tokens and
0.6/2.4/0.12 from 524288 to below 1000000. A frozen flat rate cannot represent
both tiers. This source slice adds no executable tariff, zero cache-write price
or effort guesses; model pricing remains absent and reserve admission requires
an explicit policy tariff. Source3's pricing schema and source1's accounting
must qualify native tier/admission/settlement facts before vendor-rate activation.
The catalog leaf's raw integer price observations have a separately unqualified
currency scale; these are not interchangeable with model-page USD values.

The [billing contract](https://docs.novita.ai/guides/llm-billing) says HTTP 499
and client disconnections can remain billable after inference starts. Native
400/401/403/429 and listed platform failures are separately nonbillable. Local
stream cancellation and a late stream error retain the policy reservation in
the focused fixtures. HTTP 499 needs a distinct common-runtime qualification:
at this slice's base, `proxy-accounting.ts` treats ordinary non-OK Chat responses
as nonbillable. Source1 owns that correction and its real Worker regression;
these fixtures do not claim that gap is closed or that an interrupted request
was refunded. Preserve no-replay and original credential ownership throughout.

## Integration and proof

`worker/test/novita-native-runtime.test.mjs` compiles this actual manifest and
exercises the real Worker, authority, original grant credentials and SQLite
reserve accounting through both native and manifest routes. Cases cover all
seven literal IDs, eligible catalog filtering, tools/reasoning replay, split
streams, observed/absent usage, errors, cancellation, images, explicit controls,
structured request transport and existing provider aliases. Test data contains
no real prompt, completion or credential.

[The catalog leaf](novita-model-catalog.md) is landed separately. Native discovery
declaration remains unactivated until owners1/3 publish actual `novita.models`
dispatch and paired canonical GET `/models` validation. A strict data-only
Novita response must not weaken the OpenAI decoder or borrow Synthetic's format.
Source2 owns actual strict discovery/configured augmentation and reasoning/tool
replay through its real client. Source6 owns the later serialized snapshot and
composed acceptance, including the named HTTP-499 boundary. Helper tests and
source fixtures alone do not establish account access or end-to-end parity.

Local sources remain code-only; hosted exact-head results are the execution
proof. No live inference, login, provisioning or manual deployment occurred.
