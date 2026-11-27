# First-failure repair context

Tests that stop after a failure can emit a variable tail: more tests may finish
before cancellation reaches them. Callers can select the first complete Node
TAP failure for a repair prompt instead of including that tail:

```js
import { firstTestFailureFeedback } from '../scripts/fusion-failure-feedback.mjs';

const repairFeedback = firstTestFailureFeedback(rawFeedback) ?? rawFeedback;
```

The helper keeps the failure name, error, expected and actual values, location,
stack and other diagnostic fields. It recognizes assertion, uncaught exception,
unhandled rejection and test timeout failures. It skips TODO/SKIP entries and
cancellation or suite-wrapper failures. Unsupported or incomplete output returns
`null`; callers can retain the original text. CRLF is normalized to LF.

This is explicit prompt selection, not an acceptance check or a TAP validator.
Candidate output can contain TAP-shaped text. Keep verdicts and raw output
digests from the original verifier; never derive them from this helper. Different
first failures can still produce different repair prompts. Apply any separate
timing, process-ID or temporary-port normalization explicitly, and freeze the
policy before running a new study. No default runtime behavior changes.

## Compact edit repair context

`compactRepairFeedback({ previousEdits, publicFeedback })` packs optional edit
operations and explicit public verifier diagnostics into a JSON string of at
most 12,000 UTF-8 bytes. Supply compact edits rather than the full previous
source. If the edits do not fit, the helper omits them while preserving the
diagnostics. If the diagnostics alone do not fit, it returns a string excerpt
with `diagnosticsTruncated: true`; the excerpt is not a complete verifier receipt.

This helper builds prompt context only. Keep the original verification result
for acceptance, and never include hidden tests in `publicFeedback`. A decoded
artifact that fails syntax checking is still an artifact: callers can retain
it for a cheap repair while keeping its verification result failed. Reserve
`artifact: null` for a response that supplied no usable edit artifact.
