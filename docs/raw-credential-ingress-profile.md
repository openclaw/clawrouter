# Raw proxy credential ingress profile

Proxy-key selection examines header names in this order:
`authorization`, `x-api-key`, `x-goog-api-key`, `api-key`.
Each `Headers.get` result must contain at most 4096 UTF-16 units. The guard runs
immediately after the get, before Bearer replacement, proxy-key parsing, marker
inspection, secret encoding, hashing, admission lookup or provider dispatch.
There is no eager array of candidate values.

Selection stops at the first syntactically valid key. Authentication failure for
that selected key never tries a lower header. Lower headers are not read after
selection, even if their values exceed the limit. An examined 4097-unit value is
a terminal private `identityFailure("limit")`: HTTP 503 with router classification
`identity_admission_unavailable`. This also applies to an invalid earlier value
before a valid lower key. Missing or malformed values within the limit retain
ordinary HTTP 401 behavior on proxy-key routes.

The existing case-insensitive `^Bearer\s+` replacement applies only to
`authorization`. Its spelling and whitespace count in the raw limit, before
replacement. Current `clawrouter-live-` / `clawrouter-test-` and legacy
`ocpk_live_` / `ocpk_test_` grammar is unchanged. The generic parser and SHA-256
helper are unchanged. The selected parser result contains an ASCII secret;
its length therefore equals its encoded byte count. A separate 4096-byte check
runs before the existing hash helper encodes it.

This is an intentional compatibility restriction: formerly accepted legacy
keys whose examined raw header exceeds 4096 units now receive 503. Platform
normalization has already occurred before `Headers.get`; the profile does not
measure original HTTP wire whitespace or claim to prevent platform allocation.

## Selection passes and ownership

The maximum examined aggregate is **16384 UTF-16 units per selection pass**:
four names, each at most 4096 units. Discovery and pool first run a bounded
selection/intent pass, then may run a second bounded authentication pass. They
do not claim a cumulative 16384-unit operation bound. Revalidation may likewise
perform another pass. Inspection performs one selection and passes the result
to a private authentication helper; callers cannot supply a trusted parsed key.

Discovery and pool preserve their Access/session precedence. Ordinary missing
or non-proxy headers can fall back to Access. A malformed value containing an
existing proxy marker still chooses proxy authentication and returns 401 rather
than rescuing through a session. Both adapters use the same bounded sequential
logic and stop at the first syntactically valid candidate. Oversize denial
precedes Access lookup. No raw header or parsed secret is placed in a cache or
verification map; existing verification retains the digest, not the secret.
Local parsed values can remain reachable while authentication/inspection awaits
its original work. This profile bounds those values, not their physical lifetime.

## Caller and error disposition

The source audit covers every production call of `authenticateProxyKey` and
`inspectKey` at the frozen parent. Existing request cancellation, protocol
formatting and specialized owner precedence are retained.

| Caller | Disposition |
| --- | --- |
| `index.ts`: model lookup, usage, key inspection | Rejections reach the outer `HttpError` handler. Inspection uses the private already-selected flow. |
| `discovery.ts`: key identity and catalog/models | The intent adapter guards before marker inspection or Access fallback. Authentication precedes discovery caches. Session-first `/me` keeps its existing Access precedence. |
| `pool.ts` | The same bounded intent adapter precedes Access fallback; selected-key failure does not fall back. |
| `proxy.ts`: ordinary/native/manifest, Wan, MiniMax Video/Search, fresh admission | The central guard precedes secret hashing and admission. Existing terminal identity predicates preserve capacity errors through alternate preparation and final handling; existing abort/error precedence remains. |
| `transcription.ts` | Initial and selected admission use the guard; authentication precedes body intake. Errors are not rescued with another key. |
| `responses-websocket.ts` | Initial handshake and per-create revalidation use the guard. Existing `HttpError`/frame error and caller-abort precedence remain. |
| `realtime-websocket.ts` | Initial admission and control revalidation use the guard. Existing close/rethrow behavior remains. |
| `response-controls.ts` | Key mode uses the guard unless already authenticated. Existing catch preserves `HttpError`; Access mode remains independent. |
| `published-music.ts` | Initial and fresh key admission use the guard. The unrelated asset-serving 404 catch does not enclose key authentication. |
| `copilot-public-proxy.ts` | Both public operation and catalog admission use the guard. Existing specialized catch preserves terminal 503 status, with its existing bounded public error representation; it does not retry authentication or rescue from cache. |
| `minimax-music-cover-authority.ts` | Both inactive/private preparation calls use the guard. Existing stricter control-header admission and owner finalization remain unchanged; no public activation is added. |

The private brand is not reconstructed from an error string or public code.
Ordinary native HTTP handling retains OpenAI `error.code`; native Anthropic
handling uses outer `type: error`, `error.type: api_error` for 503, and the separate
`x-clawrouter-error-code` header. This change does not alter those formatters.

## Verification and limits

Focused authored witnesses exercise all four header positions, all four key
prefixes at exactly 4096 units, +1 rejection before normalization/parser entry,
zero hash/lookup/provider effects, Bearer whitespace, UTF-16 versus UTF-8 raw
measurement, the full four-candidate bound, first-valid precedence, wrong-secret
no-fallback and single-pass inspection. Actual Worker handler tests exercise
native public 401/503 and catalog/models/pool Access precedence with real fixture
identity ownership. These are Node handler witnesses, not claims of standalone
Workerd execution.

Run `node --test worker/test/raw-credential-ingress.test.mjs` and the normal
Worker checks in a qualified dependency environment. Validate bundled manifests
with `pnpm provider:compile` through the native qualification route. In
CODE_ONLY_HOSTED mode, authored semantics, TypeScript, manifest compilation and
Workerd remain unrun locally; syntax/format/privacy checks do not substitute for
fresh hosted gates.

Claims cover subsequent JavaScript copies, regex/parser input and selected
secret encoding/hash bounds only. Native header storage, whole heap, generation
indexes, arenas, copy counts, Music/Images transfer budgets and physical
retirement are outside this profile.
