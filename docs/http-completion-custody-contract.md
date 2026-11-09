# Ordinary HTTP completion custody

This slice changes when an ordinary selected JSON HTTP caller releases its existing
input charge. Public response publication does not wait for terminal accounting,
archive completion or delivery cleanup. No new capacity ceiling is introduced.

## Selected coverage

The selection must have a `JsonAdmission`, an `llm.*` capability and one of these
request formats: `openai.chat_completions`, `openai.responses`,
`openai.responses_compact`, `openai.responses_input_tokens`, or
`anthropic.messages`. This includes matching unified and manifest HTTP routes.
The predicate excludes a specialized intake owner, compound/early-reserved Fusion,
native-response validation, lifecycle/background routes, discovery, and the
MiniMax, Anthropic Vertex and GMI provider owners. Search, Wan, Music, private Cover,
WS/Realtime, durable controls and independent helper callers keep their existing
completion contracts. This is not qualification of every JSON-shaped endpoint.

Four production boundaries implement this slice: `proxy-completion.ts`, `proxy.ts`,
`proxy-accounting.ts` and `content-retention.ts`. Existing `input-retirement.ts` and
`proxy-response.ts` receipts and cancellation behavior remain unchanged.

## Enrollment and handoff

`ProxyCompletion.start(thunk)` enrolls before invoking the thunk. It returns the
original promise and immediately attaches a fulfillment-discarding/rejection
observer. Synchronous throws and rejected `undefined` remain original outcomes.
The owner records only open/pending/started/failed scalars and a terminal receipt;
it does not retain a list of fulfilled graphs or rejection causes.

A fork is an explicit child enrollment scope. Closing a parent stops new roots in
that scope; already-active children may enroll their own children until they close.
Completion requires closure and settlement of every descendant. Repeated closure
is idempotent. Starting work in a closed scope fails before invocation. This is a
logical ownership rule, not an operation-count or memory limit.

The selected runner enrolls before execution. Its completion is registered with
the original request context even when no input bytes are charged. Its top scope
is sealed before the response returns. It does not await encompassing completion. `JsonAdmission.finish`
waits on that receipt separately, then follows its existing input-finish/release
path. Neither input finish nor an encompassing drain is enrolled into the owner.
No preparation, archive, delivery or accounting child waits on caller completion.

The owner joins:

- Actual initial/alternate preparation and raced revalidation/continuation-header
  work, including late preparation after an outward wait stops.
- Original fetch settlement and late original-response disposal. A rejected first
  response discarded for the one alternate retains its original cancellation.
- Deferred archive scheduling and the memoized original `write()` promise, which
  already joins the R2 put and serializer pipe. A known never-started archive is
  explicitly discarded; it creates no fabricated write receipt.
- An independent ORIGINAL-response reader receipt, enrolled before pre-stream
  normalization or price inspection. Its zero-prefetch forwarding stream passes
  the same chunk references and uses unchanged `inputRetirement` for actual reads,
  memoized FIRST cancellation and unlock. Normalizers can replay or discard their
  wrappers without discarding this source receipt. Active pulls are child roots;
  no pull waits on its own retirement or encompassing completion.
- The existing `observed.retired` delivery promise, in addition to that original
  source receipt. `observed.result` remains the prompt usage/accounting trigger
  and is not retirement evidence.
- The actual usage-to-accounting continuation and its actual terminal sink work,
  including ordinary early failure events and soft-budget checks.

The selected accounting factory receives an optional scope. Its terminal/fork
receipt is additive; standalone and specialized consumers do not opt in. A failed
finalization that fulfills `false` is recorded as failure, not truthy success. An
unused early accounting owner closes with `unused: true` and performs no sink call.
Forked events preserve distinct event IDs and the original request ID. Observing a
receipt never replays settlement or creates an extra attempt.

## Compatibility and limits

Public status/abort precedence, private admission-brand escape, ordinary monetary
and pricing failure events, reservation IDs and accounting classifications remain.
The existing accounting implementation still preserves the plan-order original
failure, literal `undefined`, and every ordered cleanup pair, including distinct
roots sharing a reason. No diagnostic history is copied into the completion owner.

Finalization failure remains the existing false result and recovery policy; this
receipt is not a durable ACK or a new guarantee of successful accounting. Existing
reader cleanup semantics also remain: settlement of a rejected cancellation is
not a claim that cancellation succeeded. A pending cleanup keeps the caller charge
held indefinitely. No deadline, timer credit, replay, refund or rollback is added.

Shared-cache references are not cleared. No WeakMap deletion, HTTP EOF, GC or runtime
disposal is counted as retirement. This slice does not establish identity-generation
bounds, grant-copy limits, a combined 32 MiB allowance, 64 MiB response handoff,
whole-heap/native transport retirement or public Music eligibility.

## Authored proof and remaining qualification

Focused Node cases cover original outcomes, synchronous/undefined failures,
shared reasons, sealed roots with late children, duplicate close, unused accounting,
forked IDs, all terminal entry points including finalization false, held original
R2 sink identity, delivery result before FIRST-cancel retirement and ordinary 402
publication before held failure accounting. Public `stream:true` regressions
cover valid first-event SSE replay and both SSE/oversized-JSON rejection
normalizers with held ORIGINAL FIRST cancellation, including rejection with
`undefined`. Node also checks original chunk identity. Existing accounting/reservation-reuse,
alternate-preparation and archive-pipe rejection tests remain regression controls.

One Workerd fixture uses the actual public HTTP route, real SQLite owners, R2 and
original responses. A direct healthy wire control is separate from diagnostic
orchestration. The originating diagnostic request consumes the actual public
Response/first body read before releasing independently held delivery, archive and
accounting roots. Different release orders retain the caller charge until the last
actual receipt; original reservation IDs and one real usage row are checked.
Streaming/rejection cases release archive and actual accounting first, then the
read continuation, and directly assert completion/charge remain held while only
ORIGINAL cancellation is outstanding. Normalized 429 responses retain their
existing zero charge; canceled valid streams retain their original accounting.

The fixture's provider transport stays connected independently of routed abort so
FIRST reader cancellation can be observed. In delivery cases, the second native
read is genuinely pending before abort. Rejection cases instead finish their
bounded error read before the cancellation hold. Read-return/cancel gates and the R2 gate hold application
continuations **after** native settlement; they do not prove native latency. The
cancel-rejection case injects a labelled post-native `undefined` rejection. Original
promises, actual unlock and every finite fixture root are joined in the originating
request, including dynamically registered children. Outer diagnostic EOF/disposal
is not production retirement. An exact-single-match in-memory bundle observer
receives the original private completion promise without changing its identity.

Local dependency qualification was refused: CODE_ONLY_HOSTED. Source/syntax checks
are distinct from semantics. Node, TypeScript and Workerd remain unrun locally;
fresh exact-head native qualification is required before landing.
