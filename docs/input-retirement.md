# Input retirement: JSON, delivery and native adapters

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

## Native adapter ownership

Azure, ElevenLabs and Gradium speech, OpenRouter MP3/PCM, xAI speech, Bedrock
ConverseStream and Groq/Mistral audio join the pending read and first cancellation
before returning or rejecting. Header rejection uses the same retirement rule.
OpenRouter and xAI counting adapters retain their original `pipeTo` promise:
the codec cancels the transformed reader first, then the adapter joins the pipe.
Joining before cancellation could deadlock a source that requires cancellation
to retire.

OpenRouter music keeps its BYOB window and quarantine bounds. Native `[DONE]`
cancels and joins the still-open source before replay becomes available. The
response charge remains owned by downstream delivery after quarantine finishes.

Venice preserves incremental, model-validated frames. Gate retirement joins
both source cleanup and an active authority callback. A pull schedules terminal
close/error after that join, without awaiting itself. Public delivery still
returns cancellation promptly through `observeUsage`; its separate retirement
promise retains capacity. A late authority result cannot enqueue new output.

The multipart response forwarding hunk shares the first source cancellation
with the Groq/Mistral reader. This does not qualify the separate multipart
controller's admission/read race.

## Remaining phases

This change does not qualify every NativeResponse factory. The modern MiniMax
music stream module is unchanged. Charged catalog, multipart-controller and
managed-file ownership remain required follow-up work.
Public Cerebras/NVIDIA/Chutes/Venice and private Baseten/Arcee/Novita
prepared catalog branches do not acquire response leases here; cleanup defects
there are not represented as existing response-charge bugs or new charges.

Unit fixtures hold reads, cancellation and source retirement independently.
Actual workerd fixtures exercise real outbound Response input, controlled Worker
cancellation, held cleanup, pool contention and downstream cancellation. They do
not claim physical pre-header client-disconnect coverage or provider entitlement.
