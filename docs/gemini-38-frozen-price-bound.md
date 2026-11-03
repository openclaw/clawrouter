# Frozen Gemini 3.8 Flash card

E01 adds the exact frozen `gemini-3.8-flash` identity to the existing native
GenerateContent and SSE endpoints. No new generation, model alias, hosted-tool
offer, image/audio output route or default-model change is included.

Primary evidence checked 2026-11-04:

- [Model facts](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash):
  1,048,576 input tokens, 65,536 output tokens; text/image/video/audio inputs,
  text output. These are vendor facts, not new runtime capability proof.
- [Deprecations](https://ai.google.dev/gemini-api/docs/deprecations): no shutdown
  date announced for this exact model. The separate 3.7 upstream alias is not activated here.
- [Pricing](https://ai.google.dev/gemini-api/docs/pricing#gemini-3.8-flash):
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

The frozen `gemini-3.7-flash` identity is a separate upstream-alias disposition.
Google documents automatic routing to 3.8, but the 3.7 row is not added using
replacement facts or prices by inference. Its continuation needs qualified
returned-model validation and serving-model billing evidence while preserving
the user-selected wire identity. No runtime alias rewrite is introduced.
