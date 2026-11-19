# OpenRouter MP3 speech runtime

The common factory consumes the qualified `prepareNativeOpenRouterSpeech` leaf
before the generic speech validator. Only `hexgrad/kokoro-82m`,
`elevenlabs/eleven-turbo-v2` and `mistralai/voxtral-mini-tts-2603` are in this slice.
The registered capability is `audio.speech`, with `openai.audio_speech` input and
`audio.binary` output. The fixed base `/api` plus `/v1/audio/speech` produces
`https://openrouter.ai/api/v1/audio/speech` exactly once.

Input has an explicit voice and MP3 format. The codec owns its 32768 UTF-16 text
bound and allowed settings; the native/manifest ingress limit is 256 KiB. The
factory precedes the generic 4096-character validator. There is no voice default,
model substitution, query override, Gemini PCM activation or reference asset.

The selected original credential and existing admission/cancellation owner remain
in common dispatch. The unchanged leaf leases 32 MiB (64 MiB charged) before fetch,
checks all 8192 reads including EOF, and quarantines at most 16 MiB of audio until
complete HTTP200, exact length, identity encoding and strict `audio/mpeg` are
validated. It returns the original complete MP3 bytes. Errors, cancellation and
partial responses never replay the POST or return partial audio.

Trusted provider context reaches common reservation and catalog affordability.
OpenRouter speech has no qualified dollar tariff in this slice, even if a model
card carries token or character prices. Hard dollar budgets therefore deny before
egress; an explicitly configured policy fee stays `policy_fixed`. Unmetered or
soft-policy execution, when otherwise admitted, remains `unpriced_usage`; native
speech cannot turn token-shaped diagnostics into a measured invoice. Dispatched
uncertainty retains the reservation; a known-unsent capacity refusal settles zero.
Existing OpenAI character pricing is unchanged.

Tests use the qualified leaf's exact offline decoder-verified MP3 fixture. Real
Worker/SQLite cases cover both native and manifest route forms, original body and
credential, admission, failed-output quarantine, capacity, cancellation and one
settlement. The actual workerd fetch case checks the final URL/body, complete MP3
hash and lease ownership. These are deterministic runtime proofs, not live voice
availability or a vendor invoice. YAML, snapshots and actual-client activation
remain separate owner work.
