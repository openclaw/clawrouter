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

## Required integration and ownership

Central schema3 still needs to publish `baseten.systemone` as matching request
and response formats, `llm.decisions`, `POST /systemone`, no streaming or model
passthrough, and `baseten-systemone` decision metadata for the exact three IDs.
That schema/compiler registration is a dependency, not a claim made by this
codec constant. Source4 retains new-family provider declarations after the
actual runtime/schema contracts are proven; snapshot integration requires a
separate source6 slot.

The accepted, still-held wrapper proposal names only the new
`worker/native-baseten-systemone.ts` and
`worker/test/native-baseten-systemone.test.mjs`. Its proposed export is
`prepareNativeBasetenSystemOne(selection: ProxySelection): NativeResponse | undefined`.
Unrelated formats return `undefined`; qualifying the actual route/model precedes
replacement of only `selection.body`. The wrapper will use `nativeResponseLease`
and this complete reader, with origin `https://inference.baseten.co` and path
`/v1/systemone`. No wrapper file is implemented or transferred by this codec PR.
Root must record the exact published codec/schema handoff and authorize those
files before their edits.

Runtime1 retains credentials, destination checks, capacity, admission/reservation,
cancellation, no-replay behavior, settlement and controller/index/types wiring.
The wrapper will return the codec's native body with its independently validated
usage; absent qualified tariffs remain unknown. Client2 owns actual DecisionV2
consumption and proof6 owns end-to-end acceptance. These helper fixtures do not
replace that transport, client or live-account proof. No credentials, live
inference, provisioning, model deployment or shared runtime edits are required
for this deterministic slice.
