# Repeated Fusion comparison on LRU-cache tasks

The predeclared repeated-development gate failed. This study uses **three independent historical tasks**, each sampled three times. Nine task-draws do not mean nine independent tasks. No production or routing-default change is qualified.

A subsequent zero-call diagnostic recovered every rejected cheap batch by correcting one wrong line number against a unique exact source match. All recovered edits passed the original public and held-out tests. The observed quality gap therefore does not establish a reasoning advantage for the strong fallback; edit-format rejection caused it on this sample.

## Measured outcome

| Strategy | Full success | Estimated model cost | Workflow time |
| --- | ---: | ---: | ---: |
| Independent cheap-only | 5/9 | $0.005577 | 58.71 s |
| Independent strong-only | 9/9 | $0.087073 | 98.79 s |
| Cheap-first, strong repair | 9/9 | $0.041862 | 95.52 s |

The cascade used 51.92% less estimated model cost than strong-only and took 0.967 times its workflow time. Cache-neutral cost was $0.163199 for strong-only and $0.077687 for the cascade. The complete experiment cost $0.134512. Verification infrastructure is unpriced.

There were 3 fallback rescues, 0 false accepts and 0 lost strong successes. The gate requires quality at least strong-only and strictly above independent cheap-only, zero false accepts or strong losses, at least 20% estimated and cache-neutral savings, and workflow time no greater than strong-only. **The aggregate and every round must pass.**

| Round | Cheap | Strong | Cascade | Estimated savings | Cascade/strong time | Gate |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | 2/3 | 3/3 | 3/3 | 52.21% | 1.118x | Fail |
| 2 | 2/3 | 3/3 | 3/3 | 7.75% | 1.183x | Fail |
| 3 | 1/3 | 3/3 | 3/3 | 89.48% | 0.574x | Pass |

## Posthoc edit-format diagnostic

All four failed cheap-only outputs and all three rejected cascade drafts had one incorrect line number. Their search text matched exactly one location in the frozen original source. A separate diagnostic moved only those invalid anchors, retained already-valid anchors, and required the normal edit and overlap checks plus a line-boundary match.

All seven recovered batches passed both original public and full suites with the expected assertion counts. No search or replacement text changed, no new model call was made, and no tests or snapshots were relaxed. This shows a concrete path to avoiding these failures and fallback calls, not an additional live benchmark result. The original 5/9 cheap-only score, 9/9 cascade score, costs and timings above remain unchanged.

This posthoc result needs a prospective comparison of the improved decoder. It does not qualify new timing, cost or production claims. The [sanitized diagnostic rows](fusion-lru-repeat-study.json) retain every relocation, original journal digest and test outcome.

## Qualification and scope

The ten-task roster was fixed before inference. Every reference passed after the harness received the original TAP snapshot files and dependency-free clock mock. Three parents failed with exactly the reference assertion counts in both public and full suites; seven candidates failed qualification and were not replaced.

| Upstream commit | Full reference/parent assertions | Public reference/parent assertions | Admission |
| --- | ---: | ---: | --- |
| [05942bcc1023](https://github.com/isaacs/node-lru-cache/commit/05942bcc1023c50fcb63a19d1835a474ef5a38ed) | 172/172 | 166/166 | Eligible |
| [8069477499e5](https://github.com/isaacs/node-lru-cache/commit/8069477499e536dc11a0f99c659664786932c7aa) | 163/164 | 101/102 | Parent/reference assertion counts differ |
| [2cbea7e962c5](https://github.com/isaacs/node-lru-cache/commit/2cbea7e962c53db944147a11eddbdcf717c746ab) | 160/158 | 123/122 | Parent/reference assertion counts differ |
| [b571d06fec1e](https://github.com/isaacs/node-lru-cache/commit/b571d06fec1eb5789d4ba8dd6828466614156740) | 105/105 | 89/89 | Eligible |
| [44c5ec96b87b](https://github.com/isaacs/node-lru-cache/commit/44c5ec96b87bf1a4999ee68ddb8f119dc62bc6f7) | 355/355 | 221/221 | Eligible |
| [b66bc6d84d20](https://github.com/isaacs/node-lru-cache/commit/b66bc6d84d20b9a071e2b252e66bfbcae5a8390f) | 99/99 | 84/84 | Parent already passes |
| [787343df2b0a](https://github.com/isaacs/node-lru-cache/commit/787343df2b0aed28453964d12c81e83b797097f8) | 136/123 | 101/88 | Parent/reference assertion counts differ |
| [6c8537ea6f54](https://github.com/isaacs/node-lru-cache/commit/6c8537ea6f54762f1bf7c6e908800c6982d63410) | 349/281 | 208/158 | Parent/reference assertion counts differ |
| [c1ad5da5685b](https://github.com/isaacs/node-lru-cache/commit/c1ad5da5685b3f57922de8c220212aa3de0f9262) | 101/96 | 88/85 | Parent/reference assertion counts differ |
| [212804e69d2e](https://github.com/isaacs/node-lru-cache/commit/212804e69d2e413f20d2fec3ea69f40c032d8d96) | 331/213 | 197/198 | Parent/reference assertion counts differ |

Selected suites comprise the changed JavaScript test files plus the original basic and size-calculation suites. “Full” means all selected suites, not the entire upstream package. Memory/GC benchmarks were excluded before qualification. The reference uses the upstream fix; the parent supplies the model input.

One unchanged top-level group per eligible test file is withheld where possible. Original snapshot statements for withheld groups are removed from the public view; full verification retains them. Dynamic or ambiguous snapshot mappings fail preparation. Snapshots are never regenerated to accept an answer.

## Method and limits

Each task has three independent API draws for each strategy: single GPT-6 Luna, single GPT-6.1 Terra, and Luna followed by at most one Terra repair after public rejection. Repair receives only its own rejected proposal and public failure. Initial requests and model settings match across arms. All requests use medium reasoning and an 8,192-token output limit. Arm order is hash-seeded; no prior-round answers or full outcomes are fed into later requests. Full grading starts after all live arms finish.

Workflow time includes request preparation, admission, durable accounting, decoding, public verification and cleanup; it excludes later held-out grading and replay. Inference uses the existing native provider route; tests use the pinned isolated Node/TAP fixture with networking disabled. Cache-neutral accounting prevents cache-write/read differences from being mistaken for model efficiency.

A complete outcome and cost replay matched every record and preserved the original times. Interrupted timing cannot qualify. [Sanitized records](fusion-lru-repeat-study.json) include all ten candidate outcomes, 27 strategy records and every dispatched call, plus protocol and audit hashes. No raw prompts or answers are published.

The complete replay artifacts remain private; these sanitized records are not a turnkey independent reproduction. This is a small, single-repository development sample. Repeated draws expose run variability but do not establish task-general reliability or training-data independence. Qualification excludes behaviors whose failing parents change the assertion census, so it narrows the kinds of bugs represented.
