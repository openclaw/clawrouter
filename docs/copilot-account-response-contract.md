# Inactive Copilot account response transport

`readCopilotAccountResponse(response, { operation, expectedUrl })` consumes an
already fetched Response and returns the frozen `CopilotAccountProjection` only
after complete EOF, syntax validation and input retirement. It does not fetch,
canonicalize URLs, authorize an account, install tokens or acquire capacity.
The returned identity projection remains **unqualified**.

## Admission and byte ownership

The account profile accepts 2xx statuses, matching the frozen Response.ok
contract, with an independent Content-Range veto. It requires the exact actual,
nonempty response URL, no redirect, an unused/unlocked body, identity encoding,
the existing application/json UTF-8 MIME grammar and a safe decimal declared
length. A declared length must be at most 16 MiB and equal cumulative bytes at
EOF. Unknown or malformed envelopes fail with the content-free
`invalid_copilot_response_body` error.

`consumeCopilotResponse` is internal Copilot transport plumbing. After admission
and BYOB acquisition it opens a synchronous sink and allocates one initial
window: 16 KiB for account/catalog, 8 KiB for device. Every returned view must
have an ArrayBuffer backing no larger than that window and fit the remaining
wire allowance. It feeds borrowed bytes synchronously before reusing the
returned backing. Empty results also reuse their valid backing. Missing or
zero backing before EOF fails; it never replenishes a detached window with a
new backing allocation. No relay, default-reader fallback or chunk archive is
introduced.

All reads, including empty results and EOF, count toward 8,192. Account bytes
feed the landed incremental projector directly: no complete wire/text copy,
TextDecoder, JSON.parse or AST. The projector validates fatal UTF-8 and complete
JSON, including a malformed tail after an earlier valid API field. Its explicit
local shape/string limits and missing/null/empty distinctions are unchanged.

## Retirement and publication

The actual physical read is registered with the shared `inputRetirement` before
`HttpOperation.wait` races the original deadline. The shared owner alone
memoizes FIRST cancellation and joins pending reads before releasing the lock.
The Copilot adapter only records cancellation or unlock failure, because the
shared helper's settled retirement promise does not itself prove successful
cancellation. It does not implement a second cancellation owner.

Header rejection and pre-read abort retire the unowned body through the same
owner. Used or locked bodies belonging to another consumer remain untouched.
All exits join retirement and remove the pump's abort listener before the
returned promise settles. Cleanup failure, abort during finish, or abort during
the final retirement continuation denies publication. The caller's operation
and deadline remain active; this helper never calls stop or retireDeadline.

## Per-operation allocation ledger, not a capacity charge

- Account projection retains its fixed 384-byte stack, 8,192-byte URL buffer,
  scalar state and bounded final URL/projection objects.
- The pump explicitly allocates one initial window backing. It may construct
  up to 8,192 replacement views over returned backing, plus the initial view;
  native reads may return up to 8,192 additional views/result objects. They are
  not archived. This does not assert that transferred runtime backing wrappers
  or internal copies have already been reclaimed.
- At most one physical read is pending. Each of at most 8,192 read groups has a
  native read promise, the shared owner's read/finally promises and the
  operation's wait/then promises. Promise assimilation/reaction objects and
  engine allocation sizes remain unqualified; settled does not mean collected.
- One pump abort listener remains installed during consumption. Each wait adds
  and removes its own listener, at most 8,192 cumulatively. The caller's original
  signal/deadline ownership is unchanged. One shared retirement sequence joins
  the read, FIRST cancellation and lock retirement, including rejected cleanup.

The catalog/device text wrapper retains its existing fixed 2 MiB/8 KiB buffer,
fatal final UTF-8 decoding, status grammar, public signature and errors. All
38 existing actual Node/workerd regression cases are preserved unchanged.

New actual Node and workerd fetch tests cover account 201/202 responses, range
and header rejection, fragmented UTF-8, cumulative/read/backing limits, EOF
syntax, returned-backing reuse and borrowed-byte mutation. Held cleanup fixtures
use real I/O barriers in the original Worker request context, not cross-request
resolvers. Fault injection supplements real bodies and does not replace them.

No heap/concurrency charge or activation follows from these bounds. Source1
still owns URL canonicalization allocation, original domain/account/token and
generation authority, fresh policy checks, identity retention through final
publication, and the complete resource ledger/capacity decision.
