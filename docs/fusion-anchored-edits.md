# Source-anchored Fusion edits

`scripts/fusion-anchored-edits.mjs` is an opt-in caller-side edit format for
repeated source snippets. Each edit supplies `path`, one-based `startLine`,
nonempty `search`, and `replace`. The search starts at the beginning of that
line, including any indentation, and must match the original text exactly.
No end-line arithmetic or global match selection is needed.

Use `anchoredSources(task, files)` to present numbered originals and SHA-256
digests. Retain those digests in trusted caller state. Use
`createAnchoredEditSchema(task)` for structured output, then pass the original
files, retained digests, and parsed edits to `applyAnchoredEdits`. Never derive
the expected digests from a model response or recompute them from changed files.

All ranges refer to the same frozen originals. The helper rejects stale source,
unknown paths, mismatched anchors, overlapping ranges, and oversized edits before
returning new files. Unedited files remain in the output. Empty searches and
standalone insertions are unsupported; replace a nonempty neighboring span to
insert text. Callers must still run their full acceptance verifier.

When passing reconstructed files through `normalizeReplacements`, the combined
UTF-8 source limit is 65,536 bytes by default. A trusted caller can set
`task.maxReplacementBytes` to a positive integer up to 262,144 bytes before
generating the request. This lets a small edit to a larger original file reach
verification. Include the limit in the frozen task definition; model output
cannot select or raise it. The limit covers all returned files together,
including unchanged files, and does not change test or acceptance requirements.

This helper does not change the existing edit format or Worker routing. It has
unit coverage for ambiguous snippets and edit integrity; it has no model-quality,
cost, latency, or production qualification. Evaluate it in a separately frozen
study instead of changing the format of an in-progress experiment.
