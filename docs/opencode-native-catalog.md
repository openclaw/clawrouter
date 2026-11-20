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

The Worker does not forward a caller's native session header or inject a vendor
User-Agent. Its existing session owner derives an opaque `crs_` value from the
actual authenticated principal, selected product/grant and conversation scope.
The OpenClaw client bridge translates its conversation identity into the Router
header; a raw/static vendor session never becomes the upstream session.

## Verification and client boundary

`worker/test/opencode-native-runtime.test.mjs` compiles both manifests and exercises
the actual Worker: all 17 identities, 13 executable bindings, four closed rows,
native and manifest requests, JSON/SSE replay, selected grants, unknown-price
budget denial, HTTP rejection, cancellation and one settlement. The shared
`opencode-session` tests preserve principal/product/grant isolation.

The integration harness `test/openclaw-opencode.test.mjs` pins OpenClaw
`0bc78154386d7df5d07feefca13441cd582ab3d6`. It calls the registered ClawRouter
catalog and both real stream hooks, through Worker and SQLite. Native offers are
selected normally. Unified Chat/Responses cases remove native offers from the
actual credential-scoped catalog; they do not invent positive offers or change
production discovery. No SDK manifest-route execution is claimed.

The harness requires fragmented protocol events, actual tool/signed-thinking
replay through the captured provider registry, selected Router/upstream keys,
same-credential/same-conversation session continuity, changed-conversation and
changed-credential separation, strict denial/accounting and original guard, reader,
closed, release, source and handler retirement. Policy-fixed seven-micro charges
are synthetic transport controls, not vendor tariffs or subscription entitlement.
Responses replay preserves the actual ciphertext while checking SDK canonicalization
(removal of reasoning item IDs and clear summaries); it does not require whole-item
byte identity. Shared-credential requests retain distinct original request owners
and match SQLite events to the request IDs returned by those original handlers.
Console Claude 5 cancellation starts after nonempty bytes from the bound original
transport while public output remains quarantined; it is not public post-delta
cancellation. Other cases cancel after public content. Neither qualifies physical
pre-response propagation. The pinned Go Messages simple client adds its high-thinking
budget to the requested output allowance; that wire budget is not a vendor limit.

Client hook composition is a separate acceptance boundary. This pin composes
Console Responses dynamic-record/tool-alias restoration and Go Chat DeepSeek V4 Pro
thinking through the ClawRouter hooks. The fixture still asserts the actual
wire/results for Kimi replay, Go Messages, error identity and both stream hooks;
HTTP success alone cannot establish parity. Runtime proof remains pending until
this exact candidate's native workflow completes. No client source is patched
here, and this explicit pin is not a claim about the OpenClaw default branch.

The snapshot is regenerated from all bundled manifests. Existing defaults,
pricing uncertainty, persistent credential owners, accounting and pending-work
contracts remain unchanged. This is not a deployment; normal scheduled/manual
main deployment remains separate from PR qualification.

## Sources

- [Frozen Console declaration](https://github.com/openclaw/openclaw/blob/31ad71a8addc1d42fbc5478f7e114860f5cbf6c7/extensions/opencode/openclaw.plugin.json)
- [Frozen Go declaration](https://github.com/openclaw/openclaw/blob/31ad71a8addc1d42fbc5478f7e114860f5cbf6c7/extensions/opencode-go/openclaw.plugin.json)
- [Console model/API table](https://opencode.ai/v2/docs/console/models/)
- [Go model/API and client requirements](https://opencode.ai/v2/docs/console/go/)
- [Inference paths, external-client restrictions and usage](https://opencode.ai/v2/docs/console/api/inference/)
