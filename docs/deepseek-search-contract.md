# DeepSeek native Search

Frozen consumer: OpenClaw `31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`,
`extensions/deepseek/web-search-provider.runtime.ts`. This slice implements
Search only. Fetch, Responses and Anthropic transports remain excluded.

`worker/deepseek-search.ts` exports `prepareDeepSeekSearch`,
`observeDeepSeekSearch`, `readDeepSeekSearch` and the separate native
`deepSeekSearchTariff` witness. Synthetic request/result/empty/filtered fixtures
are in `providers/_fixtures/deepseek/search.json`.

## Wire and consumer contract

POST `https://api.deepseek.com/v1/tools/search`, native Bearer authentication,
JSON `{ query, count, need_content: false }`. The query is 1–128 Unicode
characters and cannot be whitespace; lone surrogates are rejected. The frozen
count range is 1–10, default 5. The current vendor accepts a wider count range,
but this does not expand the frozen request surface. Filters remain operators
inside the query. Extra localization, content, model, callback and credential
fields are rejected.

Responses must be HTTP 200, JSON, at most 1 MiB and complete valid UTF-8 EOF.
The native result count is retained separately from bounded consumer results.
The consumer uses model-oriented `summary`, falling back to `snippet`, with
title, publication date and site name. Unsafe/non-HTTP(S) destinations are
omitted; URLs and icons are never fetched. Provider prose is untrusted content.
The actual client bridge must retain its shared external-content wrapping and
credential-scoped cache isolation. Do not cache results across a grant switch.

The adapter does not accept a client upstream key. Runtime must use the selected
DeepSeek Search grant and qualified public origin, never borrow another
provider's Chat credentials or select an origin from response data.

## Billing evidence

Checked 2026-11-03 against the primary Search guide: USD 0.75 per 1,000
successful nonempty Search requests, or **750 micro-USD per request**. Count
does not change that fee. The published billing start is November 1, 2026 at
00:00 Beijing time. This is a native Search request card, not a model token
price, hosted-tool surcharge or an account-wide assumption.

An observed full HTTP-200 native response with an empty results array has
zero billable Search requests; a nonempty native array has one. Filtering every
result URL out of the consumer output cannot change that one into zero.
Malformed envelopes, unfinished delivery, abort and unknown outcomes do not
produce a zero-cost observation. The published no-charge treatment for errors
does not justify classifying a transport interruption as a verified error.
No token usage is fabricated from result count, text length or relevance scores.

The codec exposes billing evidence, not settlement authority. Runtime/schema
owners must pin the qualified native Search card and supported credential/route
at admission, reserve the conservative one-request upper bound, then settle
using the native full-response condition. Existing hard-budget guards remain
closed until that explicit integration is qualified. `policy_fixed` remains
a separate charging basis.

## Owner handoff

- Existing manifest owner: `providers/deepseek.provider.yaml`, capability
  `search.web`, POST `/v1/tools/search`, proposed request/response format
  `deepseek.search`. Keep Chat/model pricing separate; no duplicate provider.
- Shared runtime owner: existing authenticated JSON dispatch, deadline, scoped
  credentials, native response observation and request-pricing admission.
  Never retry an uncertain charged POST as if replay were known free.
- Client owner: frozen actual Search consumer, result wrapping, Unicode bounds,
  native summary precedence and credential-isolated cache behavior.
- Integration owner: real Worker/client traffic and SQL accounting for nonempty,
  empty, filtered, interrupted and provider-error cases before activation.

No existing provider YAML, common runtime or snapshot is changed here. These
codecs alone do not register a route or complete provider parity.

## Primary sources

- [Search API reference](https://api-docs.deepseek.com/api/search/):
  native request/response fields and result semantics.
- [Search guide and billing](https://api-docs.deepseek.com/guides/search/):
  authentication, successful-request billing and effective date.
