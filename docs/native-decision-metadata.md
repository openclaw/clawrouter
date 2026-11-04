# Native decision metadata contracts

`nativeCapabilities.endpoints.<id>.inference.decision` describes a named
model/endpoint contract. It does not grant access, supply a tariff, or make a
client understand the wire format. Unknown model limits stay absent.

The compiler accepts these closed protocol/provider/format pairs:

| Protocol | Provider | Request and response format |
| --- | --- | --- |
| `openai-decisions` | `openai` | `openai.decisions` |
| `levanto-sage` | `levanto` | `levanto.sage` |
| `levanto-sage` | `levanto` | `levanto.sage_batch` |
| `liquid-ai-systemone` | `liquid-ai` | `liquid.systemone` |
| `typesafe-systemone` | `typesafe` | `typesafe.systemone` |
| `subq-decisions` | `subq` | `subq.decisions` |

Every pair requires a nonstreaming POST endpoint and the model's `llm.decisions`
capability, except Sage batch, which requires `llm.decisions.batch`.
Passthrough models, lifecycle links, WebSockets and mismatched wire
formats cannot qualify decision metadata. Existing OpenAI metadata keeps its
original shape.

Sage batch reuses the existing closed `levanto-sage` decision record and the
typed `SageDecisionCapabilities`; the paired wire format identifies the batch
operation. Its finite contract is provider `levanto`, model
`levanto/levanto-sage-2` (upstream `levanto-sage-2`), endpoint `decisions_batch`,
and POST `https://sage.levanto.ai/decide/batch`. Both request and response formats
are `levanto.sage_batch`. The first qualification exposes `input: [text, json]`
for text and list content. It excludes image facts, query/path overrides,
passthrough models and streaming. Singular Sage and SystemOne mappings do not
change.

The existing `prepareSageRequest(body, true)` codec accepts grouped `requests`
and optional `reasoning`. Sage selects the model upstream: native bodies must
not contain a `model` field. Batch question/reasoning facts retain their existing
meaning; no batch discriminator is added to the metadata. Unknown batch and
token limits remain omitted. Router byte, group or deadline caps are operational
safeguards and must not be presented as vendor limits or tariffs. Aggregate usage
comes from the codec's top-level `meta.usage`, not a sum of answer objects.

This foundation adds no provider declaration, price, dispatch or client
implementation. The singular Sage wrapper rejects batch requests. A batch
wrapper, shared admission and actual DecisionV2 consumer proof remain required
before an offer can claim executable batch support.

Hosted protocols require `protocol` and at least one typed `questions` member.
Boolean questions expose boolean probabilities. Option questions require
`probabilities`, `abstention` and `minOptions`; `maxOptions` is optional when no
bound is sourced. Sage supports `choice`, `score`, `sort` and `tags`, with sorting
having no probability semantics and tags having independent probabilities.
Sage boolean/choice/tags support abstention; score/sort do not. Liquid and SubQ
choice/score are categorical. TypeSafe's probabilities remain provider-defined.
SystemOne and SubQ do not inherit Sage sorting, tags or abstention.

Optional reasoning metadata lists supported `modes`; a declared `default` must
belong to that list. Sage can expose `auto`, `off`, `on` and reasoning `metadata`.
The other hosted protocols expose `auto` only. Confidence is provider-specific.

Optional `limits` separates `maxQuestions`, `maxRequestTokens`,
`maxStateAndQuestionTokens` and `image`. Image limits include `maxBytes`,
`mimeTypes`, `remoteUrls: false`, and optional `maxImages`/`maxTotalBytes`.
These do not replace the pricing estimator's authoritative request bounds.
SubQ 1.1 supports at most 128 questions, 255 choice options and 10 score bins;
its image limits are four images, 4 MiB each, 8 MiB total. TypeSafe's qualified
image MIME types are PNG/JPEG. Liquid's unsourced option/batch bounds stay absent.

Contract evidence:

- [Frozen OpenClaw provider metadata](https://github.com/openclaw/openclaw/tree/31ad71a8addc1d42fbc5478f7e114860f5cbf6c7/extensions)
  supplies Sage/SystemOne protocol and codec semantics. This is a pinned consumer
  contract, not a claim that its older model inventory is current.
- [Liquid D1 API](https://docs.liquid.ai/lfm/models/d1) supplies the current native
  SystemOne request/usage contract. Current documented names include `d1.1` and
  `d1-ultra`; a schema change does not add either model.
- [TypeSafe API](https://docs.typesafe.ai/introduction) describes its typed native
  decisions. Pinned-model bounds must not be copied to unqualified moving aliases.
- [SubQ Decisions API](https://docs.subq.ai/endpoints/decisions-api/) supplies the
  current question/image bounds. Older 16-question preview fixtures do not certify
  the current 1.1 endpoint.

Provider manifests must cite their own dated evidence. This schema introduces no
provider rows or prices. Concrete codecs, shared client types and actual
catalog-to-request/usage fixtures must adopt the same discriminator and preserve
the provider's native semantics before advertising runtime support.
