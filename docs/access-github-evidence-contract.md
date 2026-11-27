# Access GitHub evidence admission and retirement

GitHub identity evidence now has its own bounded profile. The evaluator and its retain-versus-revoke rules are unchanged. A matching identity can persist assignments; clean UNKNOWN evidence retains them; a valid empty identity can remove only assignments whose rules revoke on loss. Manual groups remain independent.

## Admission

The evidence deadline is an independent 30 seconds, started before outbound preparation. It honors the original caller signal, including a shorter deadline. The completed JWT deadline is not reused. Before URL construction or outbound header copies, the original request URL is limited to 16,384 UTF-16 units and the original cookie to 32,768 bytes. Oversize is a terminal denial, never truncation or local/admin fallback. These checks precede the **evidence** fetch; JWT verification has already completed.

The only destination is the original request origin plus `/cdn-cgi/access/get-identity`. Redirects are manual. Cookies are not forwarded to a different origin. Supported successful media is `application/json`, with an optional UTF-8 charset. Evidence accepts successful 2xx responses other than 206; this differs from JWKS's exact-200 profile. Redirects, partial responses, range/encoding mismatches and ordinary unusable responses become UNKNOWN only after physical cleanup. Existing JWT/JWKS admission and full-key cryptography are unchanged.

| Evidence resource | Operational limit |
| --- | ---: |
| Wire bytes / decoded text before append | 262,144 / 65,536 UTF-16 units |
| Depth / values / containers | 8 / 4,096 / 256 |
| Members / array entries | 2,048 / 1,024 |
| Aggregate decoded key/string units | 65,536 |
| Key / scalar / email units | 64 / 1,024 / 320 |
| Number-token characters | 64 |
| Root org / team entries, including discarded duplicates | 128 / 256 |
| Response headers / total header bytes | 32 / 4,096 |
| Whole read backing / read attempts, including empty and EOF | 16,384 bytes / 8,192 |

The fixed-state guard counts every occurrence before `JSON.parse`, preserving parsed last-member-wins behavior. The evidence profile does not inherit JWKS key-row, `kid`, RSA modulus or exponent restrictions. JSON-looking metadata with 33 keys, a 257-unit `kid` or a 16-character `e` is ordinary bounded evidence metadata.

The ceilings are independent. The text limit dominates the streamed wire ceiling for valid UTF-8 JSON: a valid 65,536-unit text cannot use 262,144 UTF-8 bytes. A declared oversize Content-Length can reach the wire guard directly. Values are also constrained by the lower member/entry limits. Tests identify the guard actually reached; they do not claim simultaneous admission at unreachable maxima. Duplicate discarded primitive rows allow exact org/team occurrence boundaries while the final parsed identity remains valid.

## Retained representations

This is an operational occurrence inventory, not measured heap usage or a completed common-request memory ledger. It bounds application inputs and reachable intermediates; it does not certify native HTTP buffers, runtime string internals or crypto allocations.

| Representation | Separate bounded occurrences |
| --- | --- |
| Cookie | Original header string and outbound header value, each at most 32,768 byte-string characters; allow two UTF-16 representations of that size |
| URL | Original URL, normalized URL/origin state, fixed destination and serialized destination; each at most the admitted 16,384-unit original plus the fixed 28-character path |
| Request/response headers | One outbound accept/encoding/cookie set; one admitted response set of 32 fields / 4,096 bytes; normalization uses only admitted fields |
| Read and decode | One reused 16 KiB whole backing, one returned view and one pending original read; decoder carry at most three bytes and a decoded feed bounded by 16 KiB plus three UTF-16 units |
| Text | One accumulated rope, one flattened representation and one parse-input representation, each at most 65,536 UTF-16 units (three times 128 KiB); at most 8,192 append operations, with no application chunk or response history |
| Guard | Depth-eight recursive states, fixed counters, one retained decoded key of at most 64 units; no token vector |
| Parsed evidence | At most 4,096 values / 256 containers / 2,048 members / 1,024 entries and 65,536 decoded string/key units, separate from retained source text |
| Reader lifetime | One fetch, one original reader, one pending read, one memoized FIRST cancellation, one terminal retirement and bounded branded failure facts; no retained raw error/cause graph |

The unchanged evaluator has additional intermediates, counted separately from the parsed graph:

- Two filtered record-reference arrays: at most 128 org and 256 team references.
- Org ID/name extraction: at most 128 temporary singleton arrays and 128 two-element tuples, one flattened tuple array, and one map with at most 128 entries. Original, trimmed and lowercase strings are distinct occurrences.
- Org normalization: one mapped array, one filtered array, one set and one spread/sorted result, each with at most 128 elements. Trim/lowercase outputs are additional strings.
- Team extraction: at most 256 singleton arrays and one flattened array; each team retains bounded ID/name conversions, lowercase name and a composed org/name string. Org and name fields each start at at most 1,024 units. Conservatively allowing three output units per input unit for case conversion bounds each initial lowercase field at 3,072 units, each composed team at 6,145, and a subsequent normalization at 18,435.
- Team normalization: mapped and filtered arrays, set and spread/sorted result, each at most 256 elements, plus the separate trimmed/lowercase strings. The returned org/team arrays remain owned until consumed. These conservative independent maxima do not assert that all maxima are jointly reachable.

Existing assignment-rule, user/group, policy, KV/SQL, cache and subsequent authority-transport collections are outside this slice. Their bounds are not inferred from this inventory. No new cache, store, schema, pool charge or generic authentication framework is introduced.

## Physical and authentication outcomes

The actual fetch is registered before the abort race, including late responses. The original reader is acquired before status/header rejection. BYOB is required for reading; a default reader is cancellation-only. Retirement joins the original pending read, memoized FIRST cancellation including rejection, and unlock. Unknown lock ownership retains the facade. No timeout, public error or headers-only receipt certifies cleanup.

After confirmed cleanup, ordinary transport/read failure, malformed or unusable identity, wrong email/provider, non-success/redirect/partial response and the evidence deadline yield UNKNOWN. A separately observed cleanup failure, explicit resource limit or original caller abort is terminal. In particular, timeout plus FIRST-cancel rejection never becomes UNKNOWN. Only privately branded operational denials receive that classification; caller exception properties have no authority.

The original caller is checked after evidence, after awaited assignment reconciliation and immediately before Access-session publication. Local/admin fallback publication is checked after its awaited work as well. Existing reconciliation is neither interruptible nor rolled back.

## Proof boundaries

Focused Node cases and one isolated Workerd fixture are authored coverage until their exact-head hosted runs pass. The Workerd fixture uses public session/admin routes, real SQLite assignment state, signed synthetic RS256 and real local Node HTTP JWKS/evidence responses. It tests persisted match → clean UNKNOWN → valid-empty behavior, ignored streamed 33 MiB metadata, exact/+1 boundaries, metadata independent of JWKS restrictions, manual redirects without foreign cookies, original-context reconciliation abort, real 30-second evidence deadlines and an earlier 10-second original signal.

The pending-native-read witness sends a prefix and withholds the next network bytes. Read-count padding after native EOF is separately labelled controlled-reader evidence. Late-response withholding, cancellation rejection and unknown unlock are fault injections. The unknown-lock case deliberately retains its facade until fixture disposal; disposal is not production retirement. Original-signal injection is not a production client-disconnect claim. No vendor, whole-heap, broad 30 MiB ledger or public-cover qualification follows.
