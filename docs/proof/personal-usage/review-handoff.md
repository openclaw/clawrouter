# Local ClawSweeper review handoff

This candidate is local only. Hannes authorized publication through this existing Team session after tests and the pinned local ClawSweeper review. The previous full review of ffdc0c5 completed with two P2 findings. Full pinned re-review of this replacement is **pending**. Merge, deployment and production migration remain unauthorized.

## Exact runner support

Pinned source: **7af0b3df82e30c661bd041fa09216724b3587658**, openclaw/clawsweeper PR 1756.

Source inspection confirms openclaw/clawrouter is supported by the generic openclaw/* repository profile:

- [config/target-repositories.json](https://github.com/openclaw/clawsweeper/blob/7af0b3df82e30c661bd041fa09216724b3587658/config/target-repositories.json): generic openclaw owner, repository name pattern accepts clawrouter; only clawsweeper-state and .github are denied.
- [src/repository-profiles.ts](https://github.com/openclaw/clawsweeper/blob/7af0b3df82e30c661bd041fa09216724b3587658/src/repository-profiles.ts): repositoryProfileFor accepts that generic fallback.
- [src/clawsweeper-local-composition.ts](https://github.com/openclaw/clawsweeper/blob/7af0b3df82e30c661bd041fa09216724b3587658/src/clawsweeper-local-composition.ts) and [src/clawsweeper-local-command.ts](https://github.com/openclaw/clawsweeper/blob/7af0b3df82e30c661bd041fa09216724b3587658/src/clawsweeper-local-command.ts): local-range uses the full review engine and repoFromArgs. The separate local entrypoint also invokes this engine, not an ordinary model review substitute.

The requested Studio checkout is /Users/hrudolph/Projects/openclaw-tools/clawsweeper-local-review-1756. That filesystem is absent on this Linux host; Studio is not among the connected nodes and no configured Studio SSH target is available. We therefore return a committed source bundle and exact base/head for the operator's local runner. No substituted AutoReview is claimed.

## Review the source bundle on Studio

The final delivery supplies a ZIP containing the compact committed-range bundle, SHA-256, immutable head and exact instructions. The bundle requires the baseline below from the public canonical repository. Prepare a clean target in **~/.openclaw-openclaw/worktrees**, never under ~/Projects. The original scratch probe remains outside commits and is not needed by the runner.

    target="$HOME/.openclaw-openclaw/worktrees/clawrouter-individual-dashboard-review"
    test ! -e "$target" && git clone https://github.com/openclaw/clawrouter.git "$target"
    git -C "$target" cat-file -e 6fceb88d4d165ba66281c931b74c3047772a2ef5^{commit}
    git -C "$target" fetch /absolute/path/to/downloaded-range.bundle HEAD
    git -C "$target" switch --detach FETCH_HEAD
    git -C "$target" status --short
    git -C "$target" rev-parse HEAD
    cd /Users/hrudolph/Projects/openclaw-tools/clawsweeper-local-review-1756
    git rev-parse HEAD
    pnpm run review -- --local-range --target-repo openclaw/clawrouter \
      --target-dir "$target" --base 6fceb88d4d165ba66281c931b74c3047772a2ef5

Before running, verify runner HEAD equals the pinned source and target HEAD equals the delivered head. Use full defaults, not reduced smoke settings. Inspect the resulting artifact for the exact base/head, review_status, findings/blockers and runtime/auth failures. Run no apply/comment/publish/merge commands. Review consumes the configured model service; it is not air-gapped.

A clean test suite, screenshots, source inspection, or this handoff does **not** complete the ClawSweeper gate. Findings require local remediation, tests and review of the final committed range. Publication may proceed through Team's managed publisher only after the passing review of the exact final range is returned. Deployment, merge and production backfill still need Hannes's explicit authorization.
