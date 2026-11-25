# Rejected candidate context

`compactCandidateContext(originalFiles, candidateFiles)` builds optional prompt context for a rejected candidate. It preserves source text by path and leaves both inputs unchanged. Each file supplies a `path` and string `content`; both arrays must contain the same unique paths. A null candidate returns null.

The result is either a copied candidate file array or `{ format: 'original-relative-edits-v1', edits }`, whichever has fewer UTF-8 bytes after JSON serialization. Unchanged files need no edit. Each edit contains `path`, `offsetUtf16`, `search` and `replace`. To reconstruct the candidate source, replace `search` at the given JavaScript string offset in the original file with `replace`. An insertion has an empty `search`; a deletion has an empty `replace`. Unicode characters and line endings are preserved.

Include the original files in the same prompt. Tell the model these edits describe the rejected candidate and are diagnostic context; they are not the requested solution. Continue to verify the actual candidate files. This helper does not apply edits, run code, call a model or change routing.

The compact representation covers source content, not arbitrary file metadata or file-array ordering. Smaller context alone does not establish better model quality, latency or cost.
