# Native xAI STT pricing boundary

The exact model-less `xai.stt` format joins the existing unpriced native
transcription set in `worker/pricing.ts`. `requestPricingGap` returns
`opaque_input_bound`; `estimateModelCost` returns unknown input/output tokens
and unavailable pricing before token or image estimates. `actualModelCost`
returns null even for zero usage or a nonbillable token flag, because those
observations do not establish this native operation's whole charge.

The landed [STT codec](xai-transcription-contract.md) preserves native duration,
word timing and valid silence. None supplies a qualified billable-duration
upper bound, rounding contract or interruption debit. No published hourly rate
is activated, and no model card is fabricated for the service default.

Both hard-dollar budgets remain closed; explicit `policy_fixed`, including
authorized zero, is separately labeled. Existing accounting records unqualified
cost as `unpriced_usage`, not an upstream invoice. The classifier uses only the
trusted request format and never infers STT from user text, JSON or a client
function name. Ordinary Chat and the separate OpenAI upload classification are
unchanged.

Five composed cases cover actual native model-less shape, unknown-price
admission, silence/duration observations, accounting events and plain Chat.
There are no common runtime, YAML, snapshot, credential or live-call changes.
Activation still needs the source-owned compiler/catalog contract, authenticated
bounded multipart dispatch and actual client proof.
