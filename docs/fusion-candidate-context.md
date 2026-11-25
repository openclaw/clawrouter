# Bounded candidate context for Fusion repair

A rejected candidate can nearly duplicate the original source already present
in a repair prompt. Large files can exceed the request budget before a later
compaction step runs. Compact the candidate **before** serializing and checking
the complete request.

`compactCandidateContext` is an opt-in caller-side helper. It expresses changed
file content as lossless edits against the immutable originals when that JSON
is smaller. Otherwise it returns a copy of the complete candidate files. It
does not change the files submitted to verification or any Worker routing.

```js
import { compactCandidateContext } from '../scripts/fusion-candidate-context.mjs';
import { normalizeReplacements } from '../scripts/fusion-file-artifact.mjs';

const originals = normalizeReplacements(task, originalFiles);
const candidateFiles = normalizeReplacements(task, candidate.files);
const repairContext = {
  original: originals,
  candidate: compactCandidateContext(originals, candidateFiles),
  publicFeedback,
};
// Insert repairContext into the actual provider request before this check.
const request = buildRepairRequest(repairContext);
if (Buffer.byteLength(JSON.stringify(request)) > maxInputBytes) {
  throw new Error('repair_request_too_large');
}
// Verify candidateFiles, never the diagnostic representation.
```

Callers own source-path validation, artifact limits and the complete request
budget. Compaction does not authorize a larger request, remove source or
feedback, or guarantee that every repair fits. Keep the final serialized
request check and its existing failure behavior.

## Representation

The return value is `null`, a copied file array, or:

```json
{
  "format": "original-relative-edits-v1",
  "edits": [
    {
      "path": "worker/example.ts",
      "offsetUtf16": 20,
      "search": "old value",
      "replace": "new value"
    }
  ]
}
```

Offsets are JavaScript UTF-16 string offsets into the original file. Check the
exact search text at that offset before reconstructing diagnostic content.
Each changed path has one edit spanning its first through last difference;
unchanged files need no edit. File bytes are preserved per path, including
Unicode and line endings. File-array ordering is not encoded by the edits.

Explain this representation to the repair model. It describes the rejected
candidate only; the model must still return the selected output format against
the original files. Duplicate or mismatched paths and invalid file records
throw. Inputs remain unchanged, and full-file fallback returns independent data.
