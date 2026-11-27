# Google unary speech declarations

This finite compiler contract consumes the actual codec and response wrapper in
[PR668](https://github.com/openclaw/clawrouter/pull/668), landed as
`ac18389ae0252544c1fd2b8d0ce91a39285c2541`. It adds no bundled provider declaration,
snapshot or runtime dispatch. The complete wire and audio bounds remain in
[Google speech](google-speech-contract.md).

| Request and response format | POST path | Native discovery |
| --- | --- | --- |
| `google.speech_generate_content` | `/v1beta/models/${model}:generateContent` | Qualified model path; one `model` segment |
| `google.speech_interactions` | `/v1beta/interactions` | Closed: explicit `nativeProxy: false`; manifest endpoint only |

The paired endpoints each declare only `audio.speech` and POST. The origin is
exactly `https://generativelanguage.googleapis.com`, using the original required
`x-goog-api-key` credential. No origin/path remapping, credential override,
query, passthrough, stream, lifecycle, output-token limit or request tariff is
qualified. Interactions has no path parameters and remains stateless through
the actual wrapper. Its endpoint ID may express the operation on a manifest
route; the shared native Interactions path cannot resolve intent by endpoint
order or capability alone.

Only the five frozen codec identities may carry `audio.speech`: the three
preview GenerateContent models and two Gemini 3.8 Interactions models documented
in the wire contract. Their exact `google/<upstream>` identities remain unchanged,
without aliases, Chat capabilities, borrowed prices or request-parameter claims.
Unknown whole-request audio costs remain unknown. Explicit policy-fixed charges
remain distinct from upstream dollars. Pricing closure is independently covered
by [PR690](https://github.com/openclaw/clawrouter/pull/690).

No new eligibility metadata is introduced. The compiled model's `upstream` and
endpoint's `request_format` feed the actual `nativeModelEligible` and
`modelSupportsEndpoint` contract from
[PR684](https://github.com/openclaw/clawrouter/pull/684), source
`fa5c7c0da838958790636151c9725e0f37f3a7da`, landed as
`53f233c0d5a49ee86d20e4f8685a3a9e9b057194`. That shared implementation owns the
three-preview/two-Interactions transport split and trusted-clock cutoff
`2026-11-17T00:00:00Z`. Compilation retains declarations without persisting a
clock-derived eligibility verdict. Discovery and final dispatch must apply the
shared live check; wrapper validation also preserves the codec cutoff.

Eight composed cases exercise actual compiled declarations, codec/wrapper
preparation, shared catalog eligibility, expiry, endpoint-order independence,
rejected transport/auth/price expansions and stateless-body rejection. They do
not prove deployed speech delivery. Shared dispatch and expiry enforcement,
actual catalog-scoped client behavior and serialized snapshot proof remain
separate activation prerequisites. No provider deployment or live call is made.
