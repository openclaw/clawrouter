# Input retirement: JSON and delivery phase

An operation result, an abort notification or native protocol terminal does not
prove that a response reader has retired. `inputRetirement(reader, sourceRetired?)`
tracks one actual read at a time without adding buffers or wrapping the stream.
It therefore preserves the caller's default-reader or BYOB ownership rules.

- `read(start)` reserves ownership before invoking `start`, including synchronous
  cancellation from a source pull. Concurrent and retired reads fail
  before `start` runs.
- `retire("cancel", reason)` captures the first cancellation promise before calling
  cancellation code. Repeated or reentrant calls return the same promise.
- `retire("eof")` is valid only after an actual reader `done: true`. A native
  `[DONE]` marker on an open source requires cancellation instead.
- `retired` joins the pending read, first cancellation and optional source/pipe
  retirement before releasing the reader lock. Cancellation rejection does not
  skip any join or replace the original read/accounting result. Failure to retire
  a source or release a lock cannot certify retirement or release capacity.

The optional `sourceRetired` represents source ownership retirement, not an
arbitrary operation result. A transform adapter must join its actual pipe and
source cleanup; calling a second cancel after discarding the first is not proof.

`readNativeJson` and `readGoogleJson` retain their existing signatures and limits.
Their header, size, parse, observation and abort paths now join owned cleanup.
`observeUsage.result` remains prompt usage/accounting evidence, while its separate
`retired` promise joins reader retirement and the active delivery pull, including
its actual inspection/publication callback. Downstream cancellation returns
promptly while that retirement remains pending. The pull never awaits its own
retirement. The proxy retains failed native reads,
late fetched/validated responses and delivery charges with `waitUntil`; release
runs once after the corresponding retirement. This does not change budgets,
prices, deadlines, replay policy or the 96 MiB pool.

## Qualified boundary and remaining phases

This phase covers these JSON helpers and generic delivery where cleanup is
actually joined. It does not qualify every NativeResponse factory. Wrapper
header guards that cancel before entering a helper, unjoined counting transforms,
first cancellation promises in binary/audio, ConverseStream, Venice, OpenRouter
music and Groq/Mistral adapters remain separate required adapter work. The modern
MiniMax music stream module is outside this change.

Charged catalog, multipart-controller and managed-file ownership follow that
adapter phase. Public Cerebras/NVIDIA/Chutes/Venice and private Baseten/Arcee/Novita
prepared catalog branches do not acquire response leases here; cleanup defects
there are not represented as existing response-charge bugs or new charges.

Unit fixtures hold reads, cancellation and source retirement independently.
Actual workerd fixtures exercise real outbound Response input, controlled Worker
cancellation, held cleanup, pool contention and downstream cancellation. They do
not claim physical pre-header client-disconnect coverage or provider entitlement.
