# Bounded Access JWT and JWKS verification

This profile bounds application-owned JWT/JWKS work and joins its physical
retirement. It does not qualify total Worker heap or concurrent authentication,
identity-evidence text, user/group/policy storage, or the broader text-request
allocation. GitHub identity evidence retains its separate timeout and fail-open
behavior. No provider or public Music-cover route is activated.

## Admission and authority

Every present assertion starts one original deadline. All three decoded-size
admissions run before malformed encoding can return. Both header and payload
structural/scalar guards run before a missing Access configuration can return to local-session or admin-bearer authentication. Operational profile,
transport and cleanup denials use private WeakSet branding and fixed errors;
caller error properties cannot grant fallback. An already-aborted caller is
terminal even when Access configuration is missing. Ordinary bounded invalid JWTs
remain invalid credentials. Oversized values deny the entire operation.

The original encoded header and payload are signed. RS256 and the first matching
`kid` plus RSA key determine verification. The complete bounded JWK goes to
WebCrypto, including `alg`, `key_ops` and `ext`. Import failure cannot select a
later duplicate or remove restrictions. JSON duplicate members retain ordinary
last-member semantics; all their source occurrences count toward limits first.

| Boundary | Limit |
| --- | --- |
| Present JWT | 16 KiB ASCII, exactly three nonempty segments |
| Decoded header / payload / signature | 2 KiB / 8 KiB / 1 KiB, precomputed before decoding |
| Header JSON | depth 4, 64 values, 8 containers, 32 members, 16 array entries |
| Payload JSON | depth 8, 512 values, 64 containers, 256 members, 128 array entries |
| JWKS | 256 KiB UTF-8, depth 8, 4096 values, 256 containers, 2048 members, 1024 array entries |
| JWKS decoded text | 65,536 aggregate UTF-16 units, generic string 4096 units |
| Key rows | 32, each complete row at most 8 KiB UTF-8 source span |
| Key names / kid | 64 / 256 UTF-16 units |
| Issuer, subject, audience / email | 1024 / 320 units; at most 32 audiences |
| RSA modulus / exponent | 1024 / 8 decoded bytes, every JWK field occurrence before JSON.parse (including overwritten duplicates) |
| Number token | 64 source characters; temporal claims must be finite numbers |
| HTTP headers | 32 fields, 4 KiB combined names and values |
| Original reads | 8192 including empty and EOF; one reused whole backing at most 16 KiB |

A bounded recursive state guard, depth at most eight, counts resources before
`JSON.parse`; there is no token vector. Keys and string escapes are counted after
decoding without retaining unbounded scalar copies. Complete row spans include
internal whitespace and escape bytes. Configured domain/audience strings are
bounded before normalization. Unknown/discarded fields count, too.

## Retained occurrence inventory

These are simultaneous representation bounds, not measured object sizes or a
new pool reservation. No GC timing or phase downshift establishes retirement.

- One original assertion (at most 16 KiB ASCII), three bounded segment views,
  and one original signed-string representation plus its at-most-16-KiB encoding.
  A decode has three bounded normalization intermediates, one `atob` string and
  one byte buffer: each bounded by that segment's encoded or decoded limit.
  Header/payload decoded text, a possible flattened text and parsed graph remain
  bounded by their separate wire/occurrence profiles; signature is at most 1 KiB.
- JWKS has one 16 KiB BYOB window and one at-most-16-KiB decoded feed. Text is at
  most 256 KiB UTF-8: its rope has at most 8192 appended feeds and at most one
  flattened representation. The previous prefix, new prefix and flattening are
  conservatively retained occurrences; no chunk/history array is stored.
  Parsed graph is bounded by the table. Selection references the complete first
  JWK inside this graph rather than creating a permissive projection.
- The JSON guard has at most eight recursive container states and bounded
  counters; active decoded key strings are each at most 64 units. No token
  archive is allocated. Configured strings and normalized destination each have
  the stated 1024-unit input bound.
- Crypto retains one full bounded JWK argument, one imported key, one signature
  buffer, one signed encoding and each actual import/verify promise plus its registered normalized settlement
  observer. Platform
  cryptographic implementation storage is not measured by this inventory.
- One operation, one sanitized abort bridge, one fetch root/late Response, one
  reader, one current read, one memoized FIRST cancellation and one retirement
  root are retained. Cleanup facts are booleans/fixed branded errors. There are
  no raw transport/cancellation cause graphs or per-read observation histories.
  The external signal and native Response/crypto handles are physical handles,
  not claims of bounded platform-owned storage.

## HTTP and retirement

The certs request uses the configured destination, manual redirects and the
existing platform-cache options. JSON media are `application/json` and
`application/jwk-set+json`, optionally `charset=utf-8` (quoted or unquoted).
The request asks for identity encoding; the response encoding must be absent or identity. Redirects, every HTTP 206 (even without range headers), range responses, unsafe lengths,
oversized headers and final Content-Length disagreement deny. The original body
is owned before status/header checks. A default reader can only cancel; it never
reads as a fallback. The byte guard runs before decoding/accumulation.

One 30-second JWT deadline starts before assertion preflight and spans fetch,
reading, physical cleanup, import and
verify; a shorter caller signal still wins. The returned Promise is deliberately
retirement-blocking. Deadline expiry stops useful work, but settlement can wait
beyond it for actual fetch/read/FIRST cancellation/crypto completion. Late bodies
are disposed. `inputRetirement` is reused unchanged; cancellation rejection and
unlock outcome are checked separately from its join. A failed cleanup cannot
authenticate. An unknown/locked body retains its physical root and facade.
No native-pump acknowledgement is invented or required.

Temporal claims and deadline/abort state are checked again after crypto and
physical retirement immediately before returning verified payload. The separate
session/user-assignment work is outside this JWT boundary.

## Proof distinctions

Node cert mocks now use explicit byte producers. Public-entry tests cover limits,
complete first-key imports, no operational-denial fallback, original signatures,
held crypto, cancellation and unknown locks. The isolated Workerd fixture uses
actual network JWKS responses from its local Node HTTP server and WebCrypto
through the public session entry. Valid and ignored-33-MiB cases traverse that
network response, with incremental rejection before key import. Other bounded
metadata/error variants and Cache API behavior are separately labelled fixture
paths. Its Cache API
hit case exercises a platform-produced cached body; it is not a live CDN claim.
Controlled empty/EOF calls establish the owned-reader limit, not 8192 native
transport reads. Held-read gates follow native read settlement. Unknown-unlock
and cleanup failures are explicit fault injection; disposing that test runtime
is not successful production retirement. Source/authored cases require fresh
hosted execution; this document alone supplies no semantic pass.
