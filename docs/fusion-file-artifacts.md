# Multi-file source artifacts

`scripts/fusion-file-artifact.mjs` validates complete source replacements for caller-side Fusion workflows. It makes no provider calls and writes no files. It does not enable a Worker route or change a default policy.

Declare one to four editable source paths in `task.editPaths`. Use `fileArtifactSchema(task)` for the provider response schema, then pass the parsed response to `parseFileArtifact(task, value)`. The caller must first confirm that the provider response completed successfully. A schema alone does not enforce unique paths.

The parser requires exactly one `{ path, content }` entry for every declared path. It rejects extra fields, duplicate or missing paths, paths outside `worker`, `shared`, or `scripts`, traversal, and common test-file names. Combined content is limited to 65,536 UTF-8 bytes. Entries are returned in declared path order as new objects.

Supply the resulting `{ files }` artifact to `runVerifiedWorkflow`. The caller's verifier must check every file together in its isolated workspace, including compilation and executable tests. Malformed output can produce a null artifact, but its provider cost still belongs in the invocation receipt. Parsing establishes the replacement boundary; it does not establish correctness, isolation, or permission to write those files.

The artifact supports empty file content but does not represent file deletion. Use a trusted task declaration and retain the workflow's existing budget, cancellation, and verification limits.
