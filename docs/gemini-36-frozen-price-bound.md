# Frozen Gemini 3.6 Flash card

E01 adds the exact frozen `gemini-3.6-flash` identity to the existing native
GenerateContent and SSE endpoints. No new generation, model alias, hosted-tool
offer, image/audio output route or default-model change is included.

Primary evidence checked 2026-11-04:

- [Model facts](https://ai.google.dev/gemini-api/docs/models/gemini-3.6-flash):
  1,048,576 input tokens, 65,536 output tokens; text/image/video/audio inputs,
  text output. These are vendor facts, not new runtime capability proof.
- [Deprecations](https://ai.google.dev/gemini-api/docs/deprecations): no shutdown
  date announced for this exact model. The separate 3.5 alias is not rewritten.
- [Pricing](https://ai.google.dev/gemini-api/docs/pricing#gemini-3.6-flash):
  promotional rates through 2026-12-31 and higher published rates from 2027-01-01.

| Tier | Current input / cached input / output, USD per million | Published ceiling used by this card |
| --- | --- | --- |
| Standard | 0.75 / 0.075 / 3.75 | 1.50 / 0.15 / 7.50 |
| Flex | 0.375 / 0.0375 / 1.875 | 0.75 / 0.075 / 3.75 |
| Priority | 1.35 / 0.135 / 6.75 | 2.70 / 0.27 / 13.50 |

The existing native discovery tier field is OpenAI-only, so it remains absent.
These tier cards use the already qualified Google pricing path.

Output includes thinking tokens. The higher announced rates form a conservative
ceiling on the documented schedule; they are not presented as today's invoice.
`settlementBasis: published_upper_bound` labels resulting events
`manifest_rate_upper_bound`. The card's effective date is when this bound was
qualified. No scheduling framework or guessed future tariff is introduced.
Rates above this published schedule would require new evidence and qualification.

The existing estimator reserves the full input ceiling for unbounded inline
media and the native output envelope, including multiple candidates. Ordinary
client functions remain priced. Actual hosted tools, opaque stored-cache
references and unknown service tiers stay closed under hard dollar budgets;
per-search fees, cache storage and account/free-tier allowances are not inferred
from token prices. Explicit policy-fixed charges remain separately labeled.

The declaration preserves the original 3.5 default and all existing endpoints.
Focused tests compose model selection, served-tier cached usage, upper-bound
admission and actual Worker native/manifest JSON/SSE settlement with SQLite.
They do not claim live model access, playback, newly qualified media consumers,
account entitlement or invoice accuracy. Source6 owns serialized generated
snapshot integration and actual client proof.

## Serialized integration proof

The integration composes exact source `80d3dcd51406dd17d94b10afb9e86c01560d4b15`
on qualified landed router base `10b6ce3c1e40d5d96e2599523047daf8be883a9a`. Its complete
40-line card and five source tests are preserved. Removing that card restores
the base provider YAML byte-for-byte; existing rows, rates and protocols remain.
All 86 manifests compile; five focused cases, Worker types and 1,051 existing
manifest-driven Chat/consumer-selection cases pass. The Chat matrix is broader
regression coverage, not evidence of a Google native client.
Serial generated snapshot SHA256:
`6be066e04763868e7fa7b983e546623e14ba3939a71cdded2321edfebf5b2bf2`.
The generated snapshot changes only the Google provider from this base.

`test/openclaw-gemini36.test.mjs` selects nine authored actual-client cases from
the shared Google contract fixture. They import the registered plugin, static
catalog, replay policy and native transport from public OpenClaw
`d8bb939408aa4d2be7df0161748edb52ebf3b1fb`. They target real Worker/SQLite with
sanitized fragmented SSE, exact model/credential binding, tool replay, observed
thinking/cache usage, explicit fixed versus upper-bound accounting, zero-egress
denials and post-delivery cancellation. These cases are enrolled in ordinary
hosted CI and remain **AUTHORED/UNRUN** until the exact composed head passes.
The pinned static-catalog return shape and actual GenerateContent registration
are inspected directly; no helper or client implementation is copied. No new
SDK report, local dependency install or live call is performed. The fixture explicitly
configures GenerateContent; default Interactions, live discovery, video, account
entitlement, vendor invoices and physical pre-header cancellation are separate.
