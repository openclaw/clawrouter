# OpenCode frozen native catalog

This source candidate adds the six Console and nine Go models from OpenClaw
`31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`, preserving both existing `glm-5.3`
Chat seeds. It is not a newer vendor catalog or an activation receipt.

The compiler already binds `models.entries[].capabilities` to a provider
capability's endpoint and its request/response formats. The runtime's
`modelSupportsEndpoint` rejects known models on another API, including endpoints
with unknown-model passthrough. There is no new model/API selector.

## Finite routes

Both products use the fixed origin `https://opencode.ai`. Console dispatch starts
with `/inference`; Go dispatch starts with `/inference/go`. Credentials remain
`OPENCODE_API_KEY` and `OPENCODE_GO_API_KEY` respectively, or the original selected
product grant. A shared vendor account does not authorize cross-product fallback.

| Product | Frozen models | Native suffix | Declaration |
| --- | --- | --- | --- |
| Console | `claude-opus-5` | `/anthropic/v1/messages` | Messages only |
| Console | `gpt-5.6-sol` | `/openai/v1/responses` | Responses create only |
| Console | `minimax-m3`, `kimi-k3` | `/openai/v1/chat/completions` | Chat only |
| Console | `gemini-3.6-flash` | `/google/v1beta/models/gemini-3.6-flash:generateContent` | Known, non-executable pending composition/client proof |
| Console | `big-pickle` | `/openai/v1/chat/completions` | Known, non-executable: external-client restriction |
| Go | `deepseek-v4-pro`, `deepseek-v4.1-flash`, `kimi-k3`, `kimi-k2.7-code`, `hy3` | `/openai/v1/chat/completions` | Chat only |
| Go | `gpt-5.6-luna` | `/openai/v1/responses` | Responses create only |
| Go | `qwen3.8-max` | `/anthropic/v1/messages` | Messages only |
| Go | `deepseek-v4-flash`, `kimi-k2.6` | `/openai/v1/chat/completions` | Frozen deprecated; non-executable pending current Go availability qualification |

The deprecated rows use the frozen revision's observation date, not an invented
vendor shutdown date. Their omission from the current Go page proves neither
retirement nor account access. Big Pickle's external-client restriction is not
retirement: the inference documentation says free-tier chat returns 403 outside
OpenCode even with an API key. Do not impersonate OpenCode to bypass it.

Executable cards retain frozen text/image inputs and their native conversation
API. Prices, output/context limits, reasoning-effort defaults and plan allowances
remain unspecified. No lab tariff or zero price is inherited. Fixtures use an
explicit seven-micro policy-fixed charge; that is not the upstream cost. Go can
charge its balance after an allowance is exhausted when Extra Usage is enabled.
Native billing observations and actual entitlements need independent qualification.

## Path and session boundaries

Chat preserves public `/chat/completions`. Messages uses public `/v1/messages`;
Responses create uses `/v1/responses`. Literal `upstreamPath` selects only the
product destination, preserving the caller model, original origin and credential.
Compiler PR705 qualifies Responses create mapping; the shared runtime guard must
also be qualified. No retrieval, cancellation, WebSocket or background lifecycle
is declared for these Responses models.

Gemini uses existing `path`, `pathParams: [model]` and endpoint `query: { alt: sse }`
composition. Its full public/native template includes `/inference/google/v1beta`;
there is no mapped template or generic path engine. Streaming changes the suffix
to `:streamGenerateContent`. Both templates are recorded, but the one frozen
Gemini row has no executable capabilities, so neither manifest nor native calls
can activate it. The remaining proof is actual Worker template/query dispatch
and the actual client's SDK base/path composition before enabling that row.

The source does not inject a User-Agent or accept `x-opencode-session` from the
caller. Activation stays closed pending the shared runtime's authenticated,
original-grant-bound session contract and the actual client bridge. A static
session value, generic passthrough header or renamed client is not a substitute.
Frozen native OpenClaw adds conversation headers only at native OpenCode origins;
a rewritten router URL needs the explicit bridge. Standalone calls need distinct
routing identities without acquiring unrelated conversation/cache ownership.
Go Kimi reasoning wrappers also remain an actual-client boundary; raw protocol
fixtures do not claim that wrapper or a plan entitlement has been proven.

## Verification and integration

`worker/test/opencode-native-runtime.test.mjs` compiles these two source manifests
and replaces their bundled rows in the actual Worker fixture. It covers finite
bindings, original product grants, JSON/SSE replay, usage, errors, cancellation,
catalog offers, wrong-format rejection and closed rows. The Responses cases are
prepared against the required common runtime mapping contract; no skipped test
or helper-only result substitutes for that dependency.

Local checkouts are code-only. CI must validate all manifests and run the actual
Worker fixtures after the serialized snapshot gate. Source6 owns later snapshot
integration; source1 owns runtime mapping/session gates and source2 owns native
client proof. Compilation or a public inventory listing alone proves none of
those activation conditions.

## Sources

- [Frozen Console declaration](https://github.com/openclaw/openclaw/blob/31ad71a8addc1d42fbc5478f7e114860f5cbf6c7/extensions/opencode/openclaw.plugin.json)
- [Frozen Go declaration](https://github.com/openclaw/openclaw/blob/31ad71a8addc1d42fbc5478f7e114860f5cbf6c7/extensions/opencode-go/openclaw.plugin.json)
- [Console model/API table](https://opencode.ai/v2/docs/console/models/)
- [Go model/API and client requirements](https://opencode.ai/v2/docs/console/go/)
- [Inference paths, external-client restrictions and usage](https://opencode.ai/v2/docs/console/api/inference/)
