# ElevenLabs shared speech dispatch

The shared selection hook consumes `prepareNativeElevenLabsSpeech` from the
source-owned wrapper. Native and manifest requests use the existing typed query
binding for `output_format=mp3_44100_128` and optional
`optimize_streaming_latency`. The native JSON body and voice path are preserved;
`model_id` is a native input, not a router model selector.

Authentication, policy admission, original environment or grant credential,
strict destination comparison, manual redirects, deadline and dispatch
acknowledgments remain in the existing controller. The original xi-api-key is
selected independently from caller headers. Unknown upstream-dollar costs deny
hard-budget calls before egress; explicit policy-fixed fees stay separately
labeled. Input characters and MP3 bytes do not become fabricated token usage.

The wrapper acquires the existing 32 MiB capacity lease before fetch, collects at
most 16 MiB, and publishes only complete validated audio/mpeg. The lease survives
until delivery completes or is canceled. Interrupted, rejected, redirected or
malformed upstream output yields a sanitized failure and retains the dispatched
fixed reservation. Known-unsent capacity or acknowledgment failures settle zero.
There is no uncertain synthesis replay or assertion of upstream cancellation.

`worker/test/elevenlabs-speech-runtime.test.mjs` uses the actual compiled
source declaration and real Worker, scoped authority, grant selection, SQLite
budget ledgers and usage ledger. It covers native/manifest routes, environment
and pooled credentials, query defaults, exact input/output, capacity before
fetch, dispatch acknowledgments, unknown-price denial, complete-output delivery,
deadline, caller cancellation and conservative settlement. The existing query
factory regression now tests unsupported formats after wrapper integration.

This atomic route carries source5's PR461 contribution at
`4c8fc9d33ade9cac7ff1165d67ff0e6a0c1f4c80` with its commit authorship and source
blobs intact. Source6 owns generated snapshot integration, all-manifest
validation and actual-client proof. No snapshot or production deployment is
performed by this runtime slice. Live entitlement and tariff qualification
remain separate from deterministic transport/accounting proof.
