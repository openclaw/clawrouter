# Suite test holdouts

A test file wrapped in one `describe` call can contain both new regression tests and unchanged baseline tests. Holding out the whole file can hide requirements the model needs to implement the repair.

`splitUnchangedSuiteTest(id, file, parse)` selects one unchanged test statement inside a `describe` suite, including nested suites. Supply `{ path, content, before }` and a Babel-compatible parser callback. The helper matches complete parsed test statements within the same suite ancestry against the baseline, selects by a stable hash, and returns the public source plus content and holdout hashes. It does not edit files or call a model.

The helper supports direct `test` and `it` calls inside direct `describe` callbacks. It does not infer registrations from aliases, loops, member calls, or test callbacks. Ambiguous duplicate occurrences are ineligible. Missing unchanged tests, a sole test, malformed syntax, and invalid source spans fail closed. Callers must handle unsupported test structures explicitly.

Keep the original full test source for final grading. Before model calls, execute both the original and public suites against the reference and baseline: the reference must pass, the baseline must fail, and the public suite must contain fewer tests. Matching source text alone does not establish a valid or sufficient benchmark. A partition changed after observing a model result is development tuning, not fresh confirmation.

## Finite registration groups

The separate `splitRegressionTests` helper accepts `{ staticForOfGroups: true }`
for regression suites that register tests inside finite `for…of` loops. Each
outer loop stays intact as one selection group. The returned counts include
all its generated tests; a held-out group can therefore contain more than one
test. Use `qualifyRegressionHoldout` with the returned counts and exact digests.

Supported loops bind one `const` identifier over a nonempty literal array of
primitive values. Bodies can contain direct `test` or `it` registrations,
blocks, and nested finite loops. Test names can be literals or templates that
reference loop bindings. A group can register at most 256 tests and nest fewer
than nine loops. Awaited iteration, computed iterables, conditionals, arbitrary
registration-time code, member calls, and dynamic names are rejected.

This option does not execute source during partitioning or certify that all
possible registrations were discovered. Complete native runs must still match
the full, public, and hidden counts. The reference must pass all three views;
the baseline must fail each. Existing callers retain their default behavior.
