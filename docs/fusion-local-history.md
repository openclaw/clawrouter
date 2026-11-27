# Local-history task briefs

Offline repair studies can use `localHistoryTaskBrief` from
`scripts/fusion-task-brief.mjs` when a PR body is unavailable. Install the
workspace dependencies with `pnpm install --frozen-lockfile` before running
the helper offline. Supply the fixing commit SHA, title, and exact parent and
commit versions of `CHANGELOG.md`.
The inserted text must span one complete paragraph in a top-level `-` bullet.
The helper checks its line range in the full changelog. Wrapped text and inline
links are valid. A fenced example or a new bullet that absorbs an existing
continuation line is ambiguous and fails validation.

The result contains the title and changelog narrative as the task instruction.
Provenance records the commit and hashes of both changelog versions, the title,
the narrative, and the instruction. Preserve it with the frozen task. This is
local commit provenance, not an original issue or PR body.

Keep source edits and hidden tests outside the model request. Qualify the
reference and parent against full, public, and held-out tests before inference.
These retrospective tasks support development experiments; successful repairs
do not establish prospective or production quality.
