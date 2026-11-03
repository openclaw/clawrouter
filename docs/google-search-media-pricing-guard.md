# Google grounded-search and input-media cost guards

The landed native wrappers use these exact request formats:

| Format | Frozen upstream | Missing whole-request cost qualification |
| --- | --- | --- |
| `google.grounded_search` | `gemini-3.6-flash` | Inference plus hosted grounding queries |
| `google.audio_understanding` | `gemini-3-flash-preview` | Complete native input-media/token bounds |
| `google.video_understanding` | `gemini-3-flash-preview` | Complete native input-media/token bounds |

Sources are [search669](https://github.com/openclaw/clawrouter/pull/669), landed
`a373d25fba14791cfc362d0dd48493ad608f5893`, and
[understanding671](https://github.com/openclaw/clawrouter/pull/671), landed
`61f279c9f850e7cf64b3ed27807925ab1aaa90ea`. Their actual codecs and fixtures own
the native shapes; this slice copies neither codecs nor classifiers.

The existing exported pricing interfaces remain unchanged:

- `requestPricingGap` returns `hosted_tool_fee` for the explicit grounded-search
  format and `opaque_input_bound` for either explicit understanding format.
- `estimateModelCost` returns unavailable pricing and null token estimates before
  text, zero-rate or foreign image cards can qualify the request.
- `actualModelCost` returns unknown before token counters or a nonbillable flag
  can fabricate an invoice. Actual native wrappers already return null normalized
  tokens; their preserved native usage remains transient diagnostic data.

Both caller and provider upstream-dollar hard budgets remain denied. Explicit
`policy_fixed`, including authorized zero, stays separately labeled. Empty
citations, observed query counts, byte/container bounds and complete responses
prove neither billable query counts nor free execution. Generic GenerateContent
retains its existing actual-tool classifier; an ordinary client function named
`google_search` or prompt JSON cannot imply hosted execution.

Seven focused cases use the actual published codec fixtures and pricing/accounting
interfaces. The pure input-media fixture deliberately contains synthetic bytes,
not playable-container or duration evidence. These tests establish pricing
closure, not media delivery. Source1 retains generic intent/selected-model
matching, original credentials, final admission and accounting; source2/source6
retain actual-client/snapshot proof. Explicit manifest operation selection may
resolve overlapping paths; ambiguous native offers remain closed until runtime
qualification. No YAML, route activation, tariff or shared runtime edit is made.
