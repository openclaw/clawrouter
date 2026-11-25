# Nested test prompt context

`compactNestedTestContext(files, baseline, parse)` creates smaller prompt copies of JavaScript test files. Supply a parser that returns Babel-compatible AST nodes with character offsets. The helper adds no runtime parser dependency.

The helper omits exact unchanged, uniquely named static `test` and `it` registrations within matching suite wrappers. It retains suite wrappers, setup, hooks, changed registration text, dynamic or duplicate names, and test bodies that contain references to test-registration APIs. Changed wrapper headers or trailing arguments retain their children. It does not resolve delegated helper behavior or prove that omitted tests are semantically redundant.

This is optional prompt preparation. Keep the original `files` for every verification run. Never execute the compacted prompt copy or treat it as a reduced acceptance suite. File inputs are not mutated, and the generated source is parsed before return.

The test fixtures contain compact ASTs from the recorded parser version. Tests use those trees for input discovery and Node syntax checks for generated output.
