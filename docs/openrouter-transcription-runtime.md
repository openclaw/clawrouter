# Native OpenRouter transcription runtime

The runtime consumes `prepareNativeOpenRouterTranscription` from PR700 and the
finite declaration contract from PR703. Only `openrouter.audio_transcription`
receives a 24 MiB JSON ingress envelope. Existing `JsonAdmission` authenticates
before leasing large uploads and parses expanded JSON through the bounded
streaming reader; the route authenticates again after upload before selecting
its original credential. The existing media serializer avoids an additional
whole-document copy of large base64 audio. Other formats retain their limits.

Native callers use `/v1/native/openrouter/v1/audio/transcriptions`; manifest
callers use their declared endpoint ID. The selected provider base `/api` and
endpoint suffix `/v1/audio/transcriptions` produce exactly
`https://openrouter.ai/api/v1/audio/transcriptions`. The request must be UTF-8
JSON, without multipart, remote audio, caller query or stream substitutions.
The wrapper validates the registered `openai/whisper-large-v3-turbo` model,
canonical base64 and separate 16 MiB decoded-audio bound. Original environment
or grant credentials own dispatch; caller keys never become upstream keys.

Existing reservation and dispatch acknowledgment run before fetch. The
published wrapper reserves 16 MiB of response capacity; the maximum ingress
lease is 48 MiB, for a combined bound of 64 MiB. Complete bounded JSON, identity
encoding, exact length and EOF validation precede delivery. Upstream redirects,
errors, partial reads and caller cancellation retain conservative dispatched
settlement and never trigger replay. Capacity or dispatch-acknowledgment failure
is known-unsent. Successful silence is delivered once and is not treated as a
failed or free request.

Only independently reported native token fields become token observations.
Native seconds, diagnostic cost and generation ID do not establish a tariff,
invoice or lifecycle authority. Unknown upstream prices remain closed under
hard-dollar budgets; explicit `policy_fixed` remains separately labeled.

Worker fixtures use the public consumer's playable WAV, assert actual egress
and original credentials on native and manifest routes, and exercise expanded
uploads, revoked callers, zero-egress denials, full-response handling and
settlement. This change does not activate provider YAML or regenerate a
snapshot. Declaration activation and the actual OpenClaw consumer composition
remain separately owned integration steps.
