# Copilot catalog response codec

`decodeCopilotModelCatalog(text: string): CopilotModelCatalog` in
`worker/provider-copilot-catalog.ts` is an inactive pure decoder. Its result is
`{ data: readonly CopilotModelRow[] }`, a typed projection of reported native
fields. It does not fetch, select credentials, publish a catalog or authorize
inference. Existing account/request/header/format/visibility helpers remain
unchanged.

Operational caps are 2 MiB of actual UTF-8 text before parsing, container depth
at most 64, at most 4096 raw rows before filtering, and trimmed IDs of at most
512 UTF-16 units. A bounded linear scan checks nesting before `JSON.parse` can
allocate a deep graph. These are local admission bounds, not vendor limits.
The native envelope requires an object with a `data` array; it does not require
OpenAI's `object: list` marker. Unknown fields are discarded from the projection.

IDs are trimmed only: no case folding, alias mapping or Unicode normalization.
Empty IDs and duplicate normalized IDs reject the complete response, including
duplicates in excluded rows. Every row's known authority containers and flags
are validated before exclusion. Errors are the fixed content-free
`invalid_copilot_model_catalog`; malformed input never returns a partial result.

Known non-model objects, non-chat capabilities and `accounts/` router IDs are
excluded. The decoder reuses `isCopilotCatalogModelVisible` and
`copilotModelFormats`: hidden, disabled, unconfigured or unadvertised transports
cannot reappear from static seeds or model-name guesses. Empty catalogs remain
empty. Missing/unknown policy facts are not inference entitlement. Original
current-policy filtering through `filterCopilotModels` is still required after
the complete read and fresh owner check.

Context-window, prompt and output token limits remain three separate optional
positive-safe-integer observations. Missing or invalid numeric facts stay absent;
there is no 8192 output guess, synthetic context size, clamping or inferred limit.
Explicit support booleans, including false, and empty or null reasoning-effort
observations survive. Missing support facts stay unknown. Starter selection's
tool/streaming requirements remain separate from picker visibility and inference
authority. No modalities are guessed from model names.

Native compatibility zero costs and premium-request multipliers do not qualify
USD token prices. This projection publishes no price, billing or entitlement
fields. It neither grants an allowance nor changes tariff selection.

The common owner retains fatal UTF-8 decoding, at most 8192 reads including empty
chunks, HTTP/status/redirect checks, cancellation, capacity, deadlines and cache
policy. It must freshly bind the original domain, account, GitHub token, grant
generation and lineage before fetch and after parsing, then intersect current
caller policy before publication. Pure text decoding cannot prove any of those
I/O or authority conditions. Native client selection remains a separate bridge.

Compatibility source: frozen OpenClaw
[`models.ts`](https://github.com/openclaw/openclaw/blob/31ad71a8addc1d42fbc5478f7e114860f5cbf6c7/extensions/github-copilot/models.ts),
especially native row shape, object/router exclusions, reported facts and picker
metadata. Its runtime fallback sizes and zero-cost defaults are intentionally
not provider observations here. The focused test retains the 19 frozen formats:
8 Messages, 4 Chat and 7 Responses. Run
`node --test worker/test/provider-copilot-catalog.test.mjs` for deterministic
decoder fixtures; this is not live account or end-to-end qualification.
