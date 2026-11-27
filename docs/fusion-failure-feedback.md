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
