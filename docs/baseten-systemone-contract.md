# Baseten SystemOne frozen contract

This codec qualifies the three frozen Baseten decision models independently of
Chat, Liquid AI and TypeSafe. It does not register a route or provider card.
The six frozen Baseten Chat cards and existing Chat seed remain separate H03
work; none of the decision models may be advertised as Chat.

## Sources and finite scope

Frozen OpenClaw `31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`:
`extensions/baseten/{openclaw.plugin.json,decision-codec.ts,decision-provider.runtime.ts}`
and `src/decisions/{systemone-codec.ts,result-validation.ts}`.
Primary contracts checked 2026-11-03:
[System One](https://docs.baseten.co/reference/inference-api/system-one) and
[decision models](https://docs.baseten.co/inference/model-apis/decision-models).

The exact supported IDs are:

- `decision-models/baseten-elephant-9b-latest`
- `decision-models/baseten-mammoth-27b-latest`
- `decision-models/baseten-joey-2b-latest`

Native transport is `POST https://inference.baseten.co/v1/systemone` with the
original selected Baseten Bearer credential. All three primary cards document
16,384 tokens per encoded question. State plus question, criteria and formatting
must fit that limit; the native API rejects an oversized request rather than
truncating it. Byte guards are not token-count or context-limit proof.

Frozen DecisionV2 supports text/JSON state, boolean/choice/score questions and
`auto` reasoning. Its client codec serializes JSON state and structured criteria
as text, converts boolean to `noul`, and folds true/false criteria into instruction
text. This Worker codec consumes that **already encoded native wire**. It does
not silently stringify unencoded caller structures, support current image
extensions, add `max_len`, or create a second DecisionV2 API. Client2 retains the
actual frozen DecisionV2 bridge.

## Published codec exports

`worker/provider-baseten-systemone.ts` exports:

- `BASETEN_SYSTEMONE_FORMAT = "baseten.systemone"` and the immutable
  `BASETEN_SYSTEMONE_MODELS` tuple above.
- `prepareBasetenSystemOneRequest(value, upstreamModel)` validates the encoded
  request and binds the selected upstream model. It accepts only text state,
  optional text instructions, native `noul`, 2–255 string choice criteria or
  2–10 string score criteria. Total options cannot exceed 512, with Noul counting
  as two. Finite JSON and a 4 MiB encoded request bound apply before dispatch.
- `decodeBasetenSystemOneResponse(value, request)` returns
  `{body: BasetenSystemOneResponse, usage: UsageInspection}` or `null`. It keeps
  native answer names and values, requires exact question/probability keys,
  validates fractional scores and exact encoded score legends, and does not
  derive booleans, normalize distributions or treat confidence as the chosen
  option's probability. The backend model may differ from the selected slug.
- `readBasetenSystemOneResponse(response, request, signal)` applies the decoder
  only after complete JSON EOF within 1 MiB using `readNativeJson`. HTTP 200,
  MIME, UTF-8, content length, byte limits, redirects and cancellation must pass.
  Invalid or incomplete output cannot become a synthetic answer or usage.

Observed usage must contain nonnegative safe integer input/output counters,
with output **equal to the number of questions**. Missing or mismatched output
is rejected, not synthesized. Shared input usage is counted once. Extra native
cost, units and cache observations are discarded, matching the frozen bridge;
no vendor tariff, Liquid zero-output rule or TypeSafe accounting is borrowed.

The typed fixture is `worker/test/baseten-systemone-fixtures.ts`. Focused tests
also check the native import path without the test-only resolver hook.

## Integration and ownership

The landed compiler/schema and `worker/native-baseten-systemone.ts` bind this
codec to matching `baseten.systemone` request/response formats, `llm.decisions`
and finite `POST /systemone` metadata. Unrelated formats return `undefined`;
route/model qualification precedes replacement of only `selection.body`.
The shared runtime owns credentials, destination checks, capacity, admission,
reservation, cancellation, no-replay behavior and settlement. The wrapper
returns the decoded native body and independently validated usage.

The bundled declaration now activates those three rows. See the
[runtime and registered-client contract](baseten-systemone-runtime.md) for the
explicit client pin, actual Worker/SQLite harness and remaining physical
pre-response cancellation limitation. The codec alone does not establish
client, live-account, vendor-price or deployment qualification.
