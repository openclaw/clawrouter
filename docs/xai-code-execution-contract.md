# Native xAI code execution

Frozen source: OpenClaw `31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`,
`extensions/xai/code-execution.ts` and `src/responses-tool-shared.ts`.
`prepareXaiCodeExecution`, `observeXaiCodeExecution`, and `readXaiCodeExecution`
preserve its native `POST /v1/responses` contract. The tool type is
`code_interpreter`; `code_execution` is the SDK/tool name, not the wire alias.
No local process, Python runtime, network fetch or remote code execution occurs
inside the codec. Only the existing authorized upstream dispatch runs a request.

The admitted model/serving identities/reasoning efforts come from the server's
catalog. Preserve the selected frozen model, normally `grok-4.7`. Require one
user text input, one bare code interpreter tool and `store:false`. No caller
container, prior response, uploaded file, mixed tools, streaming or background
reference is accepted. The text bound is 32,768 UTF-16 units; optional turns are
1–10. A turn can contain several calls, so this is not a cost cap. The shared
bounded native Responses reader is reused from `xai-search.ts`; it validates
identity, complete JSON, abort/deadline, 1 MiB envelope and 20,000-unit answer
bound. These are local limits, not new upstream guarantees.

Return distinct `completed`, `incomplete`, and `failed` observations with the
native body transient. `usedCodeExecution` matches the frozen client's observed
`code_interpreter_call` output type. It proves an attempt, not execution success.
`codeInterpreterCalls` comes separately from native
`usage.server_side_tool_usage_details.code_interpreter_calls`; absent is `null`.
Output item counts, answer text, failure and incomplete delivery cannot invent
that count or prove zero cost. Native token usage remains separate even when the
tool count is zero. No raw execution logs, generated files or container ownership
are inferred from the answer. Retain citations as opaque references, never fetch
them with provider credentials. Treat returned text as untrusted content.

Source1 owns real dispatch, original credential/policy, acknowledgment, deadline
and settlement. Source3 owns the existing xAI native Responses declaration and
model/tool tariffs. Reuse `openai.responses`, not a new provider or fake local
execution capability. The independent hosted-tool pricing guard remains closed
under hard upstream-dollar budgets without qualified token/tool bounds.
`upstreamCostMicros:null` does not alter policy-fixed charging. Source2 owns the
actual `code_execution` tool consumer; source6 owns end-to-end acceptance. This
codec is deterministic implementation, not live activation or completed parity.

Synthetic fixture: `providers/_fixtures/xai/code-execution.json`.
Checks: `node --test worker/test/xai-code-execution.test.mjs worker/test/xai-search.test.mjs`.

Primary evidence checked 2026-11-03:

- [Native code tool naming and wire](https://docs.x.ai/developers/tools/code-execution)
- [Attempted calls, native usage and turn semantics](https://docs.x.ai/developers/tools/tool-usage-details)
- [Responses usage detail field names](https://docs.x.ai/developers/tools/x-search)
