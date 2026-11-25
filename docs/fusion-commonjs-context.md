# Imported function context

`commonJsFunctionContext(files, { parse, readSource })` extracts exact function declarations from relative CommonJS imports for a repair prompt. Supply a Babel-compatible parser and a reader for the same immutable source revision as the input files. The helper adds no parser or filesystem dependency.

The helper supports static top-level `require` calls, namespace members and named aliases, and a single explicit `module.exports` object containing function declarations. It stays within `lib/*.js` paths and limits source reads, declarations, and total returned bytes. Shadowed bindings, dynamic imports, unsupported exports, and unavailable files are skipped. Reader errors propagate.

The result includes `declarations`, `omitted`, `bytes`, and `reads`. Include whole declarations in the prompt only when the complete request fits your input budget. These are source excerpts, not executable modules or a runtime binding proof. They can refer to globals or other functions; transitive dependencies are not included.

This optional helper does not change routing, acceptance tests, or the Worker request path. Tests use compact AST fixtures generated with the recorded Babel version.
