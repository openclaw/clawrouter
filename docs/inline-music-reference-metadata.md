# Inline music reference metadata

The optional model-scoped
`nativeCapabilities.endpoints.music_generate.referenceImage` record describes
the two existing OpenRouter Lyria models' reference input. It is support metadata,
not a grant, asset handle, retention permission, price, admission result or route
selector. The native-capabilities envelope still requires provenance and a
checked date.

```ts
interface InlineMusicReferenceImage {
  required: false;
  count: 1;
  encoding: "base64_data_url";
  mimeTypes: ["image/png", "image/jpeg", "image/webp"];
  maxDecodedBytes: 8388608;
  maxJsonBytes: 12582912;
  https: false;
  assetHandles: false;
}
```

`required: false` preserves text-only requests. When an image is present,
`count: 1` requires exactly one inline base64 data URL of a listed MIME type.
The bounds cover decoded image bytes and the complete JSON envelope, respectively.
HTTPS references and reusable asset handles are explicitly unsupported. Every
field is required, its value is closed, and unknown fields are rejected.

The compiler binds the record to `openrouter/google/lyria-3-pro-preview` or
`openrouter/google/lyria-3-clip-preview`, with matching upstream identity and
explicit `music.generate` capability. Only the `music_generate` endpoint at
`https://openrouter.ai/api` plus POST `/v1/chat/completions`, paired
`openai.chat_completions` formats and SSE qualifies. Other models, Chat
capabilities, providers and endpoint IDs cannot inherit this record. Model input
must include both text and image; the profile cannot attach to the global route.

Compilation, the model index and caller-scoped public catalog retain the complete
record, including false values. Consumers must read it alongside `input: image`;
the modality alone does not describe accepted reference transports. Existing
projection filters facts with their model and endpoint and does not turn them
into caller authority. No separate input profile or PixVerse permission is used.

The [borrowed-input codec](openrouter-music-contract.md) and scalar response leaf
are qualified separately. [Common ingress PR823](https://github.com/openclaw/clawrouter/pull/823)
owns bounded intake, credential binding, retention and dispatch. This metadata
prerequisite adds no provider YAML, generated snapshot, route advertisement,
tariff, output bound or actual-client claim. Declaration activation must wait for
qualified common ingress; the existing text-only declaration remains unchanged.

`worker/test/inline-music-reference-compiler.test.mjs` checks exact round trips,
malformed records, foreign applicability, legacy compilation equality and real
Worker native/manifest catalog projection with no upstream calls. Those are
metadata tests, not image generation or memory-capacity proof.
