# Frozen Google unary speech declarations

The existing Google provider declares five frozen speech identities using the
landed codec, wrapper, selector, pricing guard and runtime. No new format,
eligibility field, model alias or shared controller is introduced.

| Exact upstream model | Declared endpoint | Eligible route |
| --- | --- | --- |
| `gemini-3.1-flash-tts-preview` | `speech_generate_content` | Native GenerateContent and explicit manifest |
| `gemini-2.5-flash-preview-tts` | `speech_generate_content` | Native GenerateContent and explicit manifest |
| `gemini-2.5-pro-preview-tts` | `speech_generate_content` | Native GenerateContent and explicit manifest |
| `gemini-3.8-flash-tts` | `speech_interactions` | Explicit manifest only |
| `gemini-3.8-flash-lite-tts` | `speech_interactions` | Explicit manifest only |

Each row has only `audio.speech`, exact `google/<upstream>` identity and dated
text-input provenance. No context, output-token ceiling, voice entitlement or
audio-dollar tariff is inferred. All whole-request prices remain unknown;
hard upstream-dollar admission denies dispatch, while explicit policy-fixed
charges remain separately labeled.

Primary unlocalized [speech documentation](https://ai.google.dev/gemini-api/docs/speech-generation)
and [deprecation schedule](https://ai.google.dev/gemini-api/docs/deprecations),
checked 2026-11-04, retain these identities and list November 17, 2026 for the
three previews. The existing runtime conservatively stops preview eligibility at
`2026-11-17T00:00:00Z`; this is its qualification cutoff, not an assertion of the
vendor's shutdown timezone. The two 3.8 identities have no announced shutdown
date. No replacement is silently selected after expiry.

The original Google key and canonical origin remain unchanged. The paired
formats, native paths and stateless Interactions restrictions follow
[the schema contract](google-speech-schema.md) and
[the actual response wrapper](google-speech-contract.md). Interactions explicitly
sets `nativeProxy: false`; its shared native path cannot identify this operation.

Five declaration cases exercise the actual YAML through compilation, Worker
catalog, all eight qualified native/manifest requests, SQLite settlement,
unknown-price rejection and preview expiry. Existing compiler fixtures reuse
declared rows without duplicating them or removing assertions. Synthetic audio
does not establish intelligibility or live synthesis.

Source-only publication leaves generated snapshots to the existing serialized
integration queue. Until that qualification, new declaration tests and composed
delivery remain pending. Actual OpenClaw speech/Talk consumption, live synthesis
and deployment are separate; none is claimed here.
