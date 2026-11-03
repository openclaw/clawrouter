# Native model and transport eligibility

`shared/native-model-eligibility.ts` exports
`nativeModelEligible(requestFormat, selectedUpstreamModel, now?)`. The inputs
are the compiled endpoint's `request_format` and selected model's `upstream`.
Existing compiled fields are sufficient; capability membership alone does not
qualify a model for every endpoint carrying that capability.

The finite Google speech binding follows `worker/google-speech.ts`:

| Request format | Qualified selected upstream models |
| --- | --- |
| `google.speech_generate_content` | `gemini-3.1-flash-tts-preview`, `gemini-2.5-flash-preview-tts`, `gemini-2.5-pro-preview-tts` |
| `google.speech_interactions` | `gemini-3.8-flash-tts`, `gemini-3.8-flash-lite-tts` |

Preview qualification ends at `2026-11-17T00:00:00Z`, including that instant.
Missing models, unqualified identities and wrong transports fail before budget
reservation or upstream dispatch. A final check before fetch also denies a
request whose qualification expires during admission, settling it as known
unsent. The wrapper still validates stateless
Interactions, native bodies, exact destination and complete audio delivery.
This predicate does not inspect caller content or select a different model.
Other protocols keep their existing eligibility behavior.

`modelSupportsEndpoint` applies the predicate to static manifest catalogs and
request selection. Caller-scoped discovery applies it to models, metadata,
model-less offers and endpoint visibility. `nativeModelEligibilityRevision()`
partitions isolate and colo discovery cache entries at the cutoff, so normal
cache freshness cannot preserve expired preview offers.

This change does not activate speech endpoints, supply a tariff or resolve
multiple capabilities sharing a native URL. Manifest endpoint identity remains
explicit; ambiguous native routes require a separately qualified selector and
actual client proof. No YAML ordering or request-body format inference is an
eligibility contract.

Validation compares all five model bindings and the cutoff with the actual
speech codec. Candidate compiled declarations exercise native/manifest discovery
and zero-egress wrong-transport/expired dispatch through the real Worker, with
environment and original-grant credentials. Cache coverage crosses the cutoff
with warm isolate state and retained colo responses. These candidate fixtures
are not bundled-provider activation proof.
