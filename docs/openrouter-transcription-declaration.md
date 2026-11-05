# OpenRouter transcription declaration

The existing OpenRouter provider declares only the frozen
`openai/whisper-large-v3-turbo` identity for `audio.transcription`, using
`openrouter.audio_transcription` in both directions. The model is transcription-only
and explicitly unpriced. Its native facts declare audio input, not token limits,
a whole-upload duration bound or a billable-dollar ceiling.

The provider base remains `https://openrouter.ai/api`. The endpoint suffix is
`/v1/audio/transcriptions`, so dispatch reaches
`https://openrouter.ai/api/v1/audio/transcriptions` exactly once. Native callers
use `/v1/native/openrouter/v1/audio/transcriptions`; manifest callers use
`/v1/proxy/openrouter/transcription`. This is JSON `input_audio`, not multipart,
a remote URL, a Chat transform or an OpenAI transcription alias.

The wrapper, schema and real Worker dispatch landed atomically in
[PR714](https://github.com/openclaw/clawrouter/pull/714), squash
`2daa3d5cc5e506f0235716fcc7e589e82c31b42a`, after 6,283 Worker cases and all 22
checks. That source owns authenticated bounded ingress, original credential
selection, re-admission, reservation/dispatch acknowledgment, complete JSON
observation and conservative cancellation/no-replay behavior. This declaration
changes no runtime or wrapper file. The runtime fixture already preserves
existing declarations; only the source-owned compiler fixture is adjusted to
avoid injecting this exact row twice.

The [current model page](https://openrouter.ai/openai/whisper-large-v3-turbo)
shows per-second prices that differ by serving provider. Those rates and the
16 MiB decoded/24 MiB JSON/1 MiB response limits do not establish a whole-upload
price. No rate, output-token count or byte-to-duration estimate is installed.
Both upstream-dollar hard budgets remain denied; authorized `policy_fixed`
remains separately labeled. Existing Chat/Responses routes, attribution headers
and the auto default are unchanged.

The [native STT contract](https://openrouter.ai/docs/guides/overview/multimodal/stt)
and model facts were checked 2026-11-04. Four declaration cases compose actual
YAML with existing catalog, selection, wrapper and admission code. Source6 owns
the generated snapshot and composed integration; source2's actual
`transcribeAudioFile` consumer proof is separate. No deployment, live request,
account entitlement or broad parity claim is made.
