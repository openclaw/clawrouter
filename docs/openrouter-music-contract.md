# OpenRouter Lyria streaming music

Frozen source: OpenClaw `31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`,
`extensions/openrouter/music-generation-provider.ts`.
Finite models: `google/lyria-3-pro-preview`, `google/lyria-3-clip-preview`.
No automatic substitution with direct Google credentials, newer Lyria or other
audio models is allowed.

`prepareOpenRouterMusic(model, body)` preserves native JSON
`POST /api/v1/chat/completions`: one user message, `modalities:["text","audio"]`,
`audio:{format:"wav"|"mp3"}`, `stream:true`. Lyrics, instrumental instructions
and target duration are already composed into the frozen client's prompt. They
are instructions, not enforceable duration or fee bounds. Do not invent native
duration fields or imply that one requested track guarantees one billed track.
One optional ordered image follows the text, either bounded inline PNG/JPEG/WebP
or an opaque HTTPS upstream reference. The router never fetches that URL or
sends credentials to it. Upload/file IDs, additional tracks/tools/options and
newer model IDs are closed. Input text is bounded to 32,768 UTF-16 units; inline
image bytes to 8 MiB; request JSON to 12 MiB.

`OpenRouterMusicStream` consumes SSE data payloads. `readOpenRouterMusic`
uses the existing strict `createSseFrames` parser, with 2 MiB frames, 8,192 data
events, 32 MiB wire data, 16 MiB decoded audio and 1 MiB transcript limits.
These are local bounds. The frozen client permits larger configured media;
larger single events need a separately qualified shared parser limit, not silent
truncation or a second parsing framework.

`delta.audio.data` fragments form one base64 stream; decode after assembling
the bounded sequence, preserving split quartets. Transcript fragments concatenate.
Native `[DONE]` is required; socket EOF alone cannot complete the result. A
native finish reason, when supplied, must be `stop`. Audio after stop, conflicting
generation/model identity, provider errors, filtered output, invalid UTF-8,
malformed base64 and post-terminal data invalidate success. On `[DONE]`, cancel
the remaining transport instead of waiting indefinitely for EOF. The original
deadline/caller signal interrupts a stalled body. No reconnect, retry, synthetic
terminal, remote cancel promise or refund is inferred.

Native usage and the bounded generation ID are transient diagnostic evidence;
neither is authority for another request. `upstreamCostMicros` stays null.
Public model pages list $0.08/song for Pro and $0.04/clip for Clip, but those are
evidence for source3 tariff qualification, not an activated fee or preflight
bound. Failed/incomplete delivery does not prove free generation. Keep unknown
upstream-dollar budgets closed; policy-fixed charging is separate. Synthetic
audio verifies byte transport, not sound quality or a live inference.

Source3 owns existing OpenRouter declarations/model pricing. Reuse the actual
`openai.chat_completions` SSE wire for `music.generate` with the focused audio
observation contract; do not count binary audio as ordinary completion text.
Source1 owns original origin/credential selection, dispatch acknowledgment,
admission, body reservation, deadlines and settlement. Source2 owns the actual
music consumer; source6 owns native acceptance. No route activation or completed
parity is claimed by this source codec.

Exports: `openRouterMusicModels`, `prepareOpenRouterMusic`,
`OpenRouterMusicStream`, `readOpenRouterMusic`.
Fixture: `providers/_fixtures/openrouter/music.json`.
Checks: `node --test worker/test/openrouter-music.test.mjs`.

Primary evidence checked 2026-11-03:

- [Native Chat audio output and SSE](https://openrouter.ai/docs/guides/overview/multimodal/audio)
- [Frozen Pro identity and song price](https://openrouter.ai/google/lyria-3-pro-preview)
- [Frozen Clip identity and clip price](https://openrouter.ai/google/lyria-3-clip-preview)
