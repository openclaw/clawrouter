# Literal source context

Embedding source inside a JSON string asks a repair model to decode another
layer of quotes and backslashes before it can copy an exact source anchor.
`plainSourceRequest` provides an opt-in presentation for these requests: source
characters appear literally between deterministic section markers. It keeps
the task, source metadata, public tests and read-only context.

The helper changes only the second input message's content. The model, system
message, output schema, token limit and other request settings stay unchanged.
It does not apply edits or relax source-anchor validation. Existing callers
keep their current presentation until they invoke this helper.

```js
import { plainSourceRequest } from '../scripts/fusion-plain-source-context.mjs';

const rendered = plainSourceRequest(request);
```

`request.body.input` must contain two messages; the second must be a user
message whose content is JSON with these fields:

- `task`: nonempty task text.
- `files`: one to four editable originals with `path`, `sha256` and `content`.
- `publicTests`: one to eight files with `path` and `content`.
- `additionalSource`: `instruction` and up to eight read-only `snippets`, each
  with `path` and `content`.

Source content can already contain line numbers. The helper preserves them.
Unknown fields, malformed metadata and payloads beyond the 200,000-byte limits
are rejected. `plainSourceContext` renders the same parsed input directly.

## Selected-case comparison

[The recorded diagnostic](fusion-plain-source-study.json) compared both layouts
on two already-exposed Picomatch repairs, with three repetitions per layout.
Both used compact GPT-6.1 Terra, the same source and tests, cold-cache requests,
and the same exact-anchor output validator. Layout order alternated across
cases and repetitions. All twelve responses completed before grading.

| Layout | Valid edit batches | Final test passes | Total estimated API cost |
| --- | ---: | ---: | ---: |
| JSON-embedded source | 3/6 | 0/6 | $0.094750 |
| Literal source | 6/6 | 3/6 | $0.084195 |

The [POSIX punctuation repair](https://github.com/micromatch/picomatch/commit/15c324a9dae5d5b1e7281a6708d16371a0b14098)
passed in all three literal-source attempts. All three JSON attempts failed
exact-anchor validation. Neither layout passed the
[newline globstar repair](https://github.com/micromatch/picomatch/commit/75c313a9a5de0883afbbd9fa74ae03ef2919bd3e),
although both produced valid edit batches for it.

These cases were selected after observing failures. They establish a useful
local correction, not broad model accuracy, independent task generalization,
or a production Fusion gain. Costs use reported token usage and the experiment's
frozen tariffs, not reconciled invoices. API duration excludes verification;
the diagnostic does not establish end-to-end latency savings.
