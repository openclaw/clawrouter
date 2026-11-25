# Rejected candidate context

`compactCandidateContext(originalFiles, candidateFiles)` builds optional prompt context for a rejected candidate. It preserves source text by path and leaves both inputs unchanged. Each file supplies a `path` and string `content`; both arrays must contain the same unique paths. A null candidate returns null.

The result is either a copied candidate file array or `{ format: 'original-relative-edits-v1', edits }`, whichever has fewer UTF-8 bytes after JSON serialization. Unchanged files need no edit. Each edit contains `path`, `offsetUtf16`, `search` and `replace`. To reconstruct the candidate source, replace `search` at the given JavaScript string offset in the original file with `replace`. An insertion has an empty `search`; a deletion has an empty `replace`. Unicode characters and line endings are preserved.

Include the original files in the same prompt. Tell the model these edits describe the rejected candidate and are diagnostic context; they are not the requested solution. Continue to verify the actual candidate files. This helper does not apply edits, run code, call a model or change routing.

The compact representation covers source content, not arbitrary file metadata or file-array ordering. Smaller context alone does not establish better model quality, latency or cost.

## Apply the request limit after compaction

Compact before serializing and checking the complete repair request. Otherwise,
a rejected candidate can duplicate enough original source to exceed the limit
before compaction has a chance to reduce it.

```js
const context = compactCandidateContext(originalFiles, candidateFiles);
const request = buildRepairRequest({ originalFiles, candidate: context, publicFeedback });
if (Buffer.byteLength(JSON.stringify(request)) > maxInputBytes) {
  throw new Error('repair_request_too_large');
}
// Verify candidateFiles, not the diagnostic context.
```

Validate source paths and artifact limits before building context. Compaction
does not increase those limits or guarantee that the final request fits. Keep
the complete serialized request check; do not truncate source or diagnostics
to force admission.
