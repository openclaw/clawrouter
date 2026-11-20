# OpenRouter opaque PCM runtime

The common native response factory selects the qualified PCM leaf before the
MP3 leaf for the registered `google/gemini-3.1-flash-tts-preview` model on
`openai.audio_speech` → `audio.binary`. Both native and manifest requests retain
the exact selected model, explicit voice and `response_format: pcm`. Speed,
query overrides and alternative destinations remain unsupported. This wiring
adds no provider declaration or generated snapshot.

The caller must have an eligible original, owner-backed OpenRouter API-key
grant. An environment key, Google credential, OAuth token, subscription or an
arbitrary credential-bundle value cannot substitute for that key. The catalog
assesses this PCM model separately from MP3 models on the same endpoint, so
existing MP3 environment configuration remains available.

After reservation and retention waits, dispatch rechecks the original verified
caller, policy model permission, grant routing, enabled state, expiry, owner
generation, lineage and account. Owner failure or changed authority denies
egress; it never refreshes into another key. The original key is bound to
`https://openrouter.ai/api/v1/audio/speech`. This is freshness at the final
authoritative check, not instantaneous revocation after that check returns.

The existing authenticated 256 KiB JSON ingress bound and shared 96 MiB pool
remain unchanged. The leaf acquires a 32 MiB lease charged as 64 MiB before
fetch. Its 16 MiB complete-response limit, backing-buffer bound and 8,192-read
limit remain intact. Common accounting holds the response lease through
producer EOF, cancellation or failure; unread client transport buffers alone
do not imply the producer still holds it. The native read stays under the
original operation deadline and cancellation signal, without a paid retry.

Unknown upstream-dollar admission stays closed even if a text or character
tariff appears on the model. Explicit `policy_fixed` admission remains distinct:
known-unsent failures settle zero; dispatched failures retain that fixed charge.
No character count, token field or generation identifier becomes an invoice.

Output is opaque `audio/pcm` with complete nonempty, even aggregate byte length.
Odd network chunks may split a sample. This does not qualify signedness, byte
order, WAV conversion, playback or Talk support. Actual client activation is a
separate consumer proof.

Focused Worker tests cover native/manifest transport, original-key eligibility,
warm-cache authority changes after budget dispatch acknowledgment, unknown-dollar
denial, malformed output, capacity exhaustion and cancellation. The workerd
fixture exercises actual upstream fetch with a full 16 MiB payload, manifest
delivery, EOF release, odd-length refusal, capacity refusal and cancellation of
real pending upstream I/O by the operation deadline. Its bytes are transport
fixtures, not a playability assertion.
