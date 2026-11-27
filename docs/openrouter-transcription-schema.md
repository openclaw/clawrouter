# OpenRouter transcription declaration contract

This compiler slice consumes the codec from
[PR569](https://github.com/openclaw/clawrouter/pull/569), landed as
`0b4dc554641781ecf26bc784ec1db371f44b1209`. The bounded native wrapper is
[PR700](https://github.com/openclaw/clawrouter/pull/700), source
`e7e4d65b00d71db20e83f9e0e698be08fba76ad9`, exporting
`prepareNativeOpenRouterTranscription(selection)`. Wrapper publication is not
authenticated runtime dispatch proof.

The qualified endpoint uses request and response format
`openrouter.audio_transcription`, capability `audio.transcription`, and POST.
The existing provider base is `https://openrouter.ai/api`; the declaration
suffix is `/v1/audio/transcriptions`. Their combined upstream path is
`/api/v1/audio/transcriptions`. The existing native caller route is
`/v1/native/openrouter/v1/audio/transcriptions`. No `upstreamPath` override,
second route, template or SDK prefix rewrite is introduced.

The only upstream model is `openai/whisper-large-v3-turbo`, registered with
only the transcription capability. Its exact selected upstream identity must
match `body.model` in the actual codec. The body is JSON `input_audio`, with
canonical base64 data and an explicit supported format; it is not the OpenAI
multipart format. The [primary STT documentation](https://openrouter.ai/docs/guides/overview/multimodal/stt),
checked 2026-11-04, confirms this JSON endpoint. Other vendor input forms and
options do not expand the frozen consumer.

Compilation requires the original Bearer API-key scheme and canonical base.
Existing `HTTP-Referer: ${site_url}` and `X-Title: ClawRouter` attribution
remain supported. Credential overrides, query injection, request transforms,
streams, passthrough models and lifecycle controls are rejected.

Existing versioned native facts can express `input: [audio]` with provenance.
They have no decoded-audio byte, JSON-request byte, response byte or output
modality field. This slice adds none. The codec enforces 16 MiB decoded audio
and a 1 MiB complete response; PR700 and the separately owned ingress contract
bound request JSON to 24 MiB. These are local memory limits, not model context,
duration or dollar bounds. Token-context/output facts and all unqualified model
or endpoint tariffs are rejected for this route.

Composed tests use the landed prepare/read codec and native/manifest model
selection. Synthetic fixture bytes prove transport identity, not playable audio
or live transcription. Native seconds, token counts and cost remain separate
optional observations; missing usage and silence do not establish free work.
Both caller and provider hard-dollar budgets reject the unpriced model.
Explicit `policy_fixed` is separately labeled.

No bundled YAML or snapshot changes here. Activation still requires qualified
PR700, source1's authenticated exact-format media ingress, original grant/model
binding, admission and settlement, then source3's declaration and source6's
serialized snapshot. Actual client
[PR192202](https://github.com/openclaw/openclaw/pull/192202) and source6's
end-to-end proof remain separate. Compiler tests do not certify those runtime
guarantees.
