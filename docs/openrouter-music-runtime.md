# OpenRouter music dispatch

The common selector registers `prepareNativeOpenRouterMusic` before generic
Chat validation. Only explicitly declared `music.generate` models use this
native `openai.chat_completions` SSE route. The selected original credential and
fixed `https://openrouter.ai/api/v1/chat/completions` destination remain under
the normal Worker admission and dispatch controls.

When Chat operations share a native path and wire format, the exact registered
upstream `body.model` and its declared capability select the endpoint after
authenticated JSON intake. Declaration order does not choose it. Multiple
eligible endpoints deny as ambiguous; a router alias cannot substitute for the
native upstream identity. Manifest endpoint selection remains explicit.

This is partial frozen music support: prompt-only MP3/WAV requests, at most
2 MiB decoded audio and 4 MiB original SSE wire. The leaf quarantines complete
output and requires native `[DONE]` before any delivery. Reference images stay
closed. These bounds do not establish default-duration or full 16 MiB audio /
32 MiB wire compatibility; that original-scope continuation needs the separately
owned output inspector and actual capacity/lifetime proof.

Music transported over Chat SSE has no qualified token tariff. Hard-dollar
admission stays closed, including when a model accidentally carries a text
price. An explicit policy-fixed charge remains distinct. Native token/cost
fields do not become an invoice or a token meter. Dispatched failures, paid
error frames, incomplete output and cancellation retain conservative settlement;
known-unsent capacity failures do not create a charge. No request is replayed.

The real Worker tests cover native and manifest model selection, original
credentials, dispatch reservations, strict delivery, unknown prices, bypass
denial and SQLite settlement. The workerd fixture instruments the actual
network response body at the native reader boundary to establish whether BYOB
survives the common path, without adding a production hook or modifying the
leaf. Full-output work must also prove its larger buffers, cancellation and
delivery lifetimes on this path before raising limits.
