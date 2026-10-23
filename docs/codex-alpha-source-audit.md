# Codex 0.163.0 Alpha source audit

Read-only investigation, 2026-10-23. No client-side fix identified for the fresh
origin failures. The live-mode boolean matches Codex. Native completion events
do not prove successful retrieval. Existing exact-native request replays remain
stronger evidence than differences between native requests and minimal probes.

## Version and scope

Official `openai/codex` tag `rust-v0.163.0` resolves to commit
`83086188ae0614bd882818ff1aa23f3194962012` (2026-10-15).
Annotated tag object: `129b8ec7ee6f4511557a4856279f529025c25af4`.
Installed CLI reports `codex-cli 0.163.0`; package metadata also says 0.163.0.
This pins the public release source by version; binary-to-source build provenance
was not independently verified.

Fetched into isolated ignored cache `.artifacts/codex-source-v0.163.0`.
Existing Codex checkouts untouched. Reviewed request/schema, extension, history,
output, provider authentication, endpoint transport, relevant tests and history.
No build or upstream test execution, credential read, provider API POST,
Cloudflare mutation or public exposure. Local report/receipt only; runtime code
unchanged. Metadata/file-hash receipt:
`.artifacts/fakeco-codex-search-20261022/codex-alpha-source-audit-01630.json`.

## Request contract and comparison

| Surface | Tagged Codex behavior | Relation to our probes |
| --- | --- | --- |
| Endpoint/auth | POST provider-relative `alpha/search`, provider authentication; API-key custom provider uses bearer auth | Same public endpoint/key path. No Alpha-specific bootstrap in traced API-key path |
| Namespace | `id` comes from session-level extension data and remains stable across calls | Minimal single-call probes use a fresh UUID; native reference/resume tests exercise reuse |
| Model | Required model string from current tool invocation | Same selected model; no fixed hidden search-model substitution in this builder |
| Modes | Cached → `false`, live → `true`, indexed → `"indexed"` | Our tested live/cached values match. String `"live"` is not needed for native parity |
| Commands | Typed operations; `open.ref_id` accepts a URL or prior reference; `response_length` belongs inside `commands` | Minimal probe placement matches. Client has no mandatory query-before-open step; backend behavior is unproven |
| Settings | `allowed_callers: ["direct"]`, mode, optional location/context/domain filters | Minimal probes omit caller/context settings; exact-native replay retained original settings |
| Context/bounds | Recent visible conversation input, output-token budget; reasoning omitted | Minimal probes omit input/token bound; exact-native replay retained original fields |
| Headers/transport | Default originator/User-Agent, optional turn metadata/provider headers; ordinary provider retry policy and route-aware transport | Exact-native replay retained forwarded headers except API-auth replacement and Host/Content-Length normalization. Our diagnostic transport deliberately rejects redirects and does not retry |

Request definitions: [search schema][schema], [request builder][tool],
[settings and session ID][extension], [HTTP endpoint][endpoint],
[API-key auth resolution][auth], [provider base URL/retry policy][provider].

The [history builder][history] sends the recent two user text messages and a
bounded assistant-text tail. It does not replay prior search tool outputs as an
Alpha state transcript. The tool reads `output` and optional `results`; it does
not consume or resend `encrypted_output`. No `previous_response_id` or separate
search-session initialization call appears in the traced request path. This is
client evidence, not an upstream reference-lifetime or session contract.

The [earlier native-payload and reduced-payload replays](codex-search-upstream-report.md#minimal-reproduction)
both reproduced HTTP-200 `Internal Error` without fresh content or an origin hit.
Those calls retained the original forwarded namespace; they were not independent
fresh sessions. They weaken the omitted-input/header/settings explanation but
do not identify an upstream restriction. The [Funnel comparison](search-semantics-endpoint-comparison.md#authorized-pair-and-verified-cleanup)
also lacked fresh retrieval through Responses, so it does not isolate Alpha.

## Completion and error semantics

The endpoint client treats successful HTTP plus decodable JSON as a returned
search response. The extension derives the displayed action from **commands in
the request**, emits a completed event, and forwards `output` as model-facing
text. It does not parse that text for `Internal Error` or fetch failures.
[SearchOutput][output] reports logging success unconditionally.

Therefore a native completed search/open event is evidence that the client
processed a response, not that the target page was fetched successfully. This
does not describe the separate hosted Responses service's implementation.
Our fresh-marker-plus-origin-GET criterion remains necessary. Existing query,
reference/navigation and cited-answer results are narrower evidence and do not
qualify arbitrary fresh-origin retrieval.

The optional `results` array is opaque structured JSON, passed through to clients
and history. Its absence and an empty array are supported. At audit time, diagnostic
summaries record text/error/marker flags and encrypted-output presence, but omit
`results`. That is a useful instrumentation gap; source does not establish that
the array contains a diagnostic reason for these failures.

## Tests and relevant history

Reviewed tests, not executed:

- [Endpoint tests][endpoint]: typed serialization, output parsing, absent/empty
  structured results; capturing mock transport.
- [App-server tests][app-tests]: custom-provider route and bearer auth, context,
  caller setting, metadata, output/results round trip; mocked Alpha response.
- [Responses Lite tests][lite-tests]: custom-provider opt-in/default-off/disabled
  and provider eligibility; mocked inference.
- [Code-mode tests][code-tests]: boolean live/string indexed settings, one search
  request, returned text, managed endpoint/redirect denial; mocked service.
- [Proxy tests][proxy-tests]: POST/body/default-header preservation through
  different proxy routes and redirect destinations; mocked services.
- Extension unit tests: mode mapping, header forwarding, request-derived action,
  visible conversation-tail selection and plaintext output conversion.

These tests verify client behavior. The reviewed cases do not test a production
fresh origin, hidden marker, cache-only isolation, entitlement or billing.

| Change | Relevant evidence |
| --- | --- |
| [Indexed mode, June 19][indexed-change] | Adds server-index-gated mode; preserves existing boolean wire values for cached/live. Documents intended distinction, not empirical backend qualification |
| [Mode terminology, June 19][terminology-change] | Renames string enum variants; explicitly keeps existing boolean behavior |
| [Structured results, July 13][results-change] | Adds opaque optional result DTO forwarding, compatible with older responses |
| [Custom-provider opt-in, July 23][custom-change] | Uses custom endpoint and provider auth; no separate Alpha credential flow |
| [Proxy redirects, September 22][proxy-change] | Fixes client-to-API proxy/redirect routing, not the provider's fetch of a requested page |

Compared with the earlier October 7 checkout (`11da6b9`), request schema,
extension settings/tool, output and session transport files are identical.
Relevant changed files add optional message fields for output-token replay;
the endpoint test/history builder initializes those fields to `None`. No new
Alpha mode or session requirement was found in that comparison.

## Disposition

No runtime patch or additional paid test justified by this audit alone. Keep
fresh retrieval, broader cached/live semantics and Alpha billing unqualified.
Do not repeat hosting experiments without a new discriminator.

The subsequent local instrumentation below addresses the summary gap. It does
not identify a backend failure cause or authorize another provider probe.

The [official OpenAI documentation](https://learn.chatgpt.com/docs/web-search#search-with-a-custom-model-provider)
still describes standalone search as under development and requires compatible
provider/model/runtime support. It does not resolve these observed fetch failures.

## Subsequent local results diagnostics

`searchProbeSummary` now adds this fixed metadata projection for Alpha responses:

```json
{
  "results": {
    "state": "array",
    "count": 1,
    "types": { "textResult": 1, "unknown": 0, "malformed": 0 }
  }
}
```

- `state`: `absent` when no own results field, `null` for explicit null, `array`
  for an array, `invalid` for another field value. Non-object top-level values
  have no results field and report `absent`.
- `count`: array length, including zero; `null` for other states. Zero type
  counters outside an array are not evidence that the provider returned no data.
- `textResult`: entries whose own type is exactly `text_result`, the one label
  observed in pinned upstream fixtures. This does not validate other DTO fields.
- `unknown`: entries with an unrecognized nonempty string type. Names are not
  copied to log keys or values, including prototype-related names.
- `malformed`: null/non-object/array entries, or missing, empty or non-string
  own type. No nested field inspection or inferred provider error schema.

For arrays, the three counters partition the array length. The existing 2 MiB
decoder bounds actual provider responses; the projection does not copy URLs,
references, snippets, arbitrary type names, ciphertext or nested fields. Raw
response values retain the existing memory-only return path. This changes the
explicit direct/replay probe summaries, not ordinary native-adapter logging or
Worker/admin behavior. Hosted Responses retains its separate summary and does
not acquire Alpha result classifications.

Diagnostic only: result counts do not affect existing text-error detection,
success assertions or fresh-marker/origin-GET qualification. No live provider
probes, deployment, 1Password read or public exposure in this preparation.
Earlier receipts remain historical; new source digests would be required for any
future run.

Validation: 62 focused synthetic tests passed:

```sh
node --test test/standalone-search-probe.test.mjs test/responses-search-probe.test.mjs test/search-semantics-matrix.test.mjs test/search-semantics-funnel.test.mjs test/search-semantics-endpoint-comparison.test.mjs
```

Coverage includes absent/null/empty/invalid results, unknown and malformed entries,
prototype-related type names, private nested content, unchanged HTTP-200 error
handling, bounded decoding and existing retrieval/cancellation/cleanup behavior.
Autoreview of `5fb72e3` completed `scoped-clean` through P2, using GPT-6.1 Sol
with high reasoning. No actionable findings. Reviewed diff and source context;
the reviewer did not execute tests. Review outputs:
`~/.codex/review-results/alpha-results-diagnostics-20261023/`.
Local preparation receipt:
`.artifacts/fakeco-codex-search-20261022/alpha-results-diagnostics-preparation.json`.

[schema]: https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/codex-api/src/search.rs
[tool]: https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/ext/web-search/src/tool.rs#L97
[extension]: https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/ext/web-search/src/extension.rs#L58
[endpoint]: https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/codex-api/src/endpoint/search.rs
[auth]: https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/model-provider/src/auth.rs#L292
[provider]: https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/model-provider-info/src/lib.rs#L427
[history]: https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/ext/web-search/src/history.rs#L14
[output]: https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/ext/web-search/src/output.rs#L17
[app-tests]: https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/app-server/tests/suite/v2/web_search.rs#L45
[lite-tests]: https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/core/tests/suite/responses_lite.rs#L439
[code-tests]: https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/core/tests/suite/code_mode.rs#L494
[proxy-tests]: https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/core/tests/suite/web_search_system_proxy_tests.rs#L36
[indexed-change]: https://github.com/openai/codex/commit/3a2712ea141a5acb243689f803f26e48ff751771
[terminology-change]: https://github.com/openai/codex/commit/c83618ab2098525d343df2160d98b2449dca6d5d
[results-change]: https://github.com/openai/codex/commit/2ca20d522451adf0340403fc15cd54d4926f14b0
[custom-change]: https://github.com/openai/codex/commit/0f9fb40fa9c4cc4b1ed0d595ce3ba70468a0c87a
[proxy-change]: https://github.com/openai/codex/commit/6ea62c4396a1c0942a3ea271e062bdd9e0d2737f
