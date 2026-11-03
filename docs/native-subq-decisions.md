# SubQ native decisions

The experimental SubQ manifest exposes `POST /v1/native/subq/v1/systemone`
with native `state`, `questions`, optional `images`, and `model: subq-snap-1.1`.
The manifest route also accepts the router ID `subq/subq-snap-1.1` and translates
it to the upstream ID. It does not expose Chat, Responses, files or conversations.

The [current native contract](https://docs.subq.ai/endpoints/decisions-api/)
returns noul probabilities, choice distributions and score distributions. Those
objects pass through unchanged. The portable synthetic request/result fixture
is `providers/_fixtures/subq/decisions.json`; a consumer bridge must map noul to
its own boolean representation explicitly and validate all typed results.

[Current model documentation](https://docs.subq.ai/using-the-api/models/),
checked 2026-11-03, names `subq-snap-1.1` and prices input at $0.04 per million
tokens with free output. Admission conservatively reserves the full 393,216-token
context, including images and server formatting, and settlement uses native
`usage.input_tokens` and `usage.output_tokens`. The synthetic 500-token fixture
therefore settles 20 micro-units. Missing usage retains the admitted bound.
This price is not the separate early-access conversational model's price.

The frozen OpenClaw plugin still names `subq-snap-preview` and limits batches to
16 questions. Current SubQ documentation names `subq-snap-1.1` and permits 128.
Do not alias the old ID or claim client parity without updating and testing the
consumer. The compiler currently permits typed `inference.decision` metadata
only for `openai.decisions`; this native manifest deliberately omits that badge
instead of falsely labelling SubQ's wire format as OpenAI. The schema owner must
qualify native typed metadata and the client owner must consume it before full
decision capability advertising.

The Worker retains its existing request body bound, which is smaller than the
provider's documented 13 MiB image envelope. Large native image requests need
shared-runtime admission work. No streaming, hosted tools or server-side history
is declared. Live entitlement, upstream invoice reconciliation and client E2E
remain qualification gates. Integration owns generated snapshot regeneration.
