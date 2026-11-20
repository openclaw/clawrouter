## Summary

<!--
Start with the problem, task, or value for callers, operators, or maintainers.
Then explain the implementation. Keep it specific to this change.

Illustrative pairs (not claims about this PR):
- Implementation-first: "Update grant selection."
  Reader-first: "Requests can fail when a spent grant is selected despite another
  eligible grant. Select an eligible grant so callers can continue."
- Implementation-first: "Extract provider quota helpers."
  Reader-first: "Provider quota declarations are duplicated across compiler paths.
  Share the helpers so maintainers can update the contract in one place."
-->

## Verification

<!--
Lead with what was checked and the observed outcome, then supporting commands or
logs. State gaps or checks not run; do not present planned checks as results.

Illustrative pair:
- Command-only: "Ran pnpm worker:check."
- Outcome-first: "The grant-selection regression passes: a spent grant no longer
  prevents selection of another eligible grant. Worker checks pass
  (`pnpm worker:check`)."
-->

## Deployment status

<!-- State whether this is deployed, pending deployment, or needs no deployment. -->

## Remaining risk

<!-- Describe remaining risk or limitations, or explain why there is no runtime impact. -->

<!-- If deployment/state/callback/credential/accounting contracts change: describe
     the automatic transition, existing-state and pending-work proof, and recovery.
     See docs/deployment-compatibility.md. No per-release operator preparation. -->
