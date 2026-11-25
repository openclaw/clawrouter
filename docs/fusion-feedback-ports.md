# Stable loopback ports in repair feedback

Local HTTP regression tests can report a different temporary port on every run.
That makes an otherwise identical failed assertion produce different repair
requests during replay. Callers can explicitly normalize these ports in their
diagnostic feedback before constructing a repair request:

```js
import { normalizeLoopbackUrlPorts } from '../scripts/fusion-feedback-ports.mjs';

const repairFeedback = normalizeLoopbackUrlPorts(rawFeedback);
```

The helper replaces valid ports in HTTP(S) URLs whose host is `localhost`,
`127.0.0.1`, or `[::1]`. Aliases follow first appearance: repeated ports share an
alias, while different ports retain different aliases, even across hosts. URL
paths, query strings, fragments, host spelling and surrounding assertions remain
unchanged. Existing alias text gets a distinct generated prefix. Unsupported
hosts, bare endpoints, credentials in URLs and malformed ports remain unchanged.

Opt in only when the fixture assigns arbitrary ports and their numeric values
are irrelevant to the repair. This intentionally loses absolute port values and
does not make arbitrary concurrent test output deterministic. Retain raw output
and its digest separately; never use normalized text as acceptance evidence.
Test verdicts, compiler checks and default feedback are unchanged. Freeze the
normalization choice before a new study; it does not validate old mismatched
requests retroactively.
