# Bedrock Converse codec integration

The focused codecs follow OpenClaw `31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`,
`extensions/amazon-bedrock/stream.runtime.ts` and
`stream.runtime.tool-replay.test.ts`. This is the frozen E02 transport contract,
not a new model catalog. AWS documents the native [Converse](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_Converse.html)
and [ConverseStream](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ConverseStream.html)
wire shapes. No SDK dependency, credential lookup or network call is introduced.

## Exports and owner contracts

- `prepareBedrockConverseRequest(value, selectedModel, stream)` returns the encoded
  model/ARN path and JSON body. The runtime owns the trusted endpoint, region,
  bearer/SigV4 credential materialization and request signing. Caller aliases
  cannot replace the selected path model.
- `prepareBedrockReplay(context, model, options, volatileUserIndexes)` converts
  repaired Pi transcript content to native REST JSON, grouping tool results,
  replaying tool-free turns as text and preserving compatible signed reasoning.
  Images and redacted bytes are base64 JSON strings, not SDK `Uint8Array` objects.
- The native client owns shared transcript repair before replay conversion:
  failed assistant turns, missing/delayed tool results, non-vision placeholders,
  canonical model identity and runtime-context classification. The codec uses
  explicit qualified Claude/cache/adaptive flags; it does not guess capabilities
  from an inference-profile ARN or parse model display names.
- `buildBedrockSystemPrompt` separates the stable cache prefix. Replay places up
  to two user checkpoints before volatile runtime context; the qualified
  thinking-prefix flag preserves models whose signed prefix cannot move.
- `decodeBedrockConverseResponse` validates unary text, reasoning and tool content.
- `createBedrockConverseDecoder().accept(event)` takes complete decoded AWS
  EventStream event unions, including base64 JSON redacted chunks. Framing,
  CRC checks, exception headers, cancellation and upstream delivery belong to the
  shared runtime. Call `unavailable()` on framing/transport failure and
  `result(false)` on cancellation. EOF alone never completes a response.
- `extractBedrockConverseUsage` converts native uncached input plus read/write
  counters to router input, retaining cache TTL buckets. Missing required
  input/output counts remain unknown; absent optional cache counts mean zero.
  Reported total is floored at the constituent sum, matching the frozen source.
  No token prices or free usage are inferred.

## Validation and boundaries

The decoder returns content only after terminal validation. All tool argument
siblings must be complete objects before any executable input is returned.
Refusals and modeled exceptions discard buffered content and expose only a
content-free error category. Raw `stop_details` prose is never an error string.
The shared runtime must preserve Claude 5 output quarantine when delivering
bytes; an accounting observer alone does not enforce that delivery requirement.

The aggregate decoder and replay JSON envelope are bounded at 2 MiB, nesting at
64 and stream block indexes at 4096. Oversize or malformed stream evidence becomes
unavailable. A production adapter must integrate this bound with its memory
admission and delivery policy; this codec is not an unbounded byte observer.
Integer tool arguments outside the safe JSON number range are rejected instead
of silently rounding. Historical malformed arguments replay as empty objects,
matching the frozen transport; stored history is never changed.

Native model-specific thinking budgets, request fields, cache-policy selection,
region/profile precedence and credential refresh remain with the common runtime
and native client owners. Unknown response block kinds fail explicitly. Tests
cover the frozen text/reasoning/tool surface; no video/document route, live AWS
entitlement, streaming latency or deployed end-to-end proof is claimed here.
