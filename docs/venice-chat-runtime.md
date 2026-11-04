# Venice Chat model binding

The shared runtime consumes the request and returned-model validators from
[PR785](https://github.com/openclaw/clawrouter/pull/785). The source contract is
the immutable Venice OpenAPI Git blob
`37c318af208e3c2e9e46330e7cdde7ab4abfd4c0`: Chat fallbacks at lines 1545–1557
and the used-model response field at lines 8182–8184. No Responses or beta
fallback implementation is included.

Every caller `fallbacks` field is rejected before egress, including an empty
array. Native Chat requires its literal selected upstream model. Manifest and
unified routes retain their explicit router-model selection. Existing unpriced
passthrough remains subject to model policy and the same literal response check;
this does not add model cards or pricing. The final destination is only
`https://api.venice.ai/api/v1/chat/completions`, with no query or transport override.

JSON delivery is quarantined through bounded UTF-8 parsing, complete EOF and
exact length checks. The response must explicitly name the selected model before
any bytes are released. SSE remains incremental: each complete frame is validated
before its original bytes are emitted. Every data payload must name that same
model, including usage-only payloads. A different model is rejected even when the
caller may use it in a separate request. Comments and native `[DONE]` have separate
framing rules. Later invalid frames are withheld and upstream is canceled; prior
selected-model frames remain authorized. Missing identity or unqualified SSE
behavior fails closed, without a vendor-default or beta-success claim.

The original owner generation, lineage, account and caller/model policy are
revalidated after reservation awaits and before dispatch, then before JSON or
the first SSE data publication. There is no DO call per frame. Subsequent frames
reuse that request authorization and synchronously check caller and original
credential expiry. This is fresh authorization at those boundaries, not an
instantaneous revocation guarantee throughout an already authorized stream.
An originally selected environment credential is tied to the canonical
`VENICE_API_KEY` source and cannot rotate during delivery. An original owner
cannot borrow environment qualification or change credentials.

JSON has a 2 MiB wire bound and 8,192-read bound. Its existing 32 MiB response
lease charges 64 MiB. SSE holds one upstream window of at most 2 MiB, one 128 KiB
frame and one bounded output copy; no stream archive is retained. It uses an
8 MiB lease charged as 16 MiB, covering framing, decoded strings, the existing
bounded JSON parser and usage observation. Its cursor scans fragmented input
incrementally, including split CRLF. Both leases are acquired before dispatch
and remain held through delivery or cancellation. Caller ingress retains its
separate existing lease within the 96 MiB pool.

The native-response result explicitly requests the existing delivery usage
observer for gated SSE. No completion or token usage is fabricated before EOF.
Normal token normalization remains intact. USD and DIEM diagnostics are neither
converted nor treated as invoices. Unknown upstream-dollar admission stays
closed; explicit `policy_fixed` remains separate. Dispatched malformed, foreign,
interrupted and rejected responses retain conservative cost without replay;
proven unsent denial remains zero.

Deterministic real Worker cases cover native/manifest/unified JSON, fragmented
SSE, incremental selected output before future bytes, late foreign-model denial,
warm-cache revocation after reservation, policy tightening, original key/expiry,
capacity, cancellation and accounting. A real workerd fetch fixture checks
incremental delivery and withholding through the actual response path. These
tests use synthetic upstream responses; no live vendor call, grant mutation,
provider declaration or snapshot activation is performed.
