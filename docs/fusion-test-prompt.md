# Compact test context

`compactTestContext(files, baseline, parse)` creates a smaller prompt view of caller-owned tests. Pass the current public files, their baseline versions and a Babel-compatible parser callback. The result is a new file array; input files remain unchanged.

The helper omits byte-identical top-level `test`, `it` and `describe` calls already present in the baseline. It counts duplicate occurrences so an added copy remains visible. Changed groups stay intact. If shared fixtures, imports, hooks, environment docblocks or other setup changed, or moved across shared registrations, the entire file stays intact: identical test text can have different behavior under changed setup. Unsupported registration forms remain in the prompt.

Use the returned files only for model context. Execute the original public files for acceptance, and retain original final-test files. Prompt size reduction does not establish model quality or a production performance gain.

The helper performs no model calls, filesystem writes or verification. It validates parser spans and parses the resulting source before returning it. Callers remain responsible for the parser and for preserving the verification inputs.
