# Public repair cascade: repeated sampling

The frozen three-repeat study passes its preregistered repeatability screen.
Across 18 paired samples, the cascade and strong control each solved 18;
cheap-only solved 16. Cascade model cost was **20.97% lower** than strong, with
**15.01% more workflow time**. These are three samples on the same six historical
tasks, not 18 independent tasks or production qualification.

The [machine-readable evidence](fusion-public-repair-repeats.json) retains all
54 outcomes and each repeat's protocol, result and terminal-audit digests.
The [initial fresh six-task pilot](fusion-public-repair-pilot.md) is a separate
study and is excluded from these totals.

| Sample | Strong solved | Cascade solved | Cheap solved | Cascade cost / strong | Cascade time / strong | Efficiency gates |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Repeat 1 | 6/6 | 6/6 | 4/6 | 0.8978 | 1.2128 | Fail |
| Repeat 2 | 6/6 | 6/6 | 6/6 | 0.7469 | 1.0941 | Pass |
| Repeat 3 | 6/6 | 6/6 | 6/6 | 0.7251 | 1.1428 | Pass |
| Aggregate | 18/18 | 18/18 | 16/18 | 0.7903 | 1.1501 | Pass |

The first repeat fails both efficiency gates. It remains in the aggregate.
Every repeat had zero cascade false accepts and zero losses of strong-control
successes. One admitted cheap workflow exhausted its attempts and succeeded
through strong fallback in repeat 1. No other admitted workflow escalated.
This demonstrates one recovery within the cascade; it does not show a quality
advantage over the strong control.

## Frozen method

The study reused the exact public controller from
[the opt-in cheap-repair change](https://github.com/openclaw/clawrouter/pull/1324),
the six pilot tasks, model request bodies, context, public verifier, full tests,
admission decisions and model settings. Three tasks admit the cheap path and
three bypass it. The cheap path allows two attempts, then up to two fresh strong
attempts. Cheap-only and strong-only controls each allow two attempts. Models
are `openai/gpt-6-luna` and `openai/gpt-6.1-terra`.

The master protocol was frozen before new inference. Repeat identifiers are
accounting labels; the model sees the original task input. Three separately
frozen child plans preserve the existing request cap. Each child completed its
saved-call and runtime replay before the next child started. No weights,
datasets or new compute resources were downloaded or allocated for this study.
The recorded calls passed the uncached-input qualification.

The predeclared screen requires zero false accepts or strong losses in every
repeat, aggregate quality at least strong and above cheap, aggregate cost ratio
at most 0.8 and time ratio at most 1.2, and both efficiency gates in at least two
of three repeats. The report validator derives this verdict from all outcomes;
it rejects missing or duplicate samples. Invalid artifacts remain failures with
unavailable full-test counts, rather than fabricated completed test runs.

## Accounting and limits

All 66 calls, including rejected drafts and repairs, cost **$0.297666** under the
frozen token tariffs. Strong calls total $0.152865; cascade calls $0.120816;
cheap controls $0.023985. The maximum reservation was $13.657473, not a charge.
Cumulative experimental spend is **$318.158869** of $400, leaving $81.841131.
These are usage-derived tariff estimates, not independently reconciled invoices.

Workflow time includes inference and public verification, but excludes the
later full-test grading and replay. Ratios use sums of complete paired arms,
not averages of per-task ratios. This was a serial local experiment, not a
service latency or throughput benchmark.

Six related, previously exposed tasks provide limited evidence. The cost margin
over the 20% target is small, one repeat misses the targets, and cheap-only
quality varies between repeats. The results support this opt-in verified
workflow as a candidate for broader testing. They do not establish general
coding gains, reliable model complementarity, statistical independence,
pretraining novelty, or savings on unverified chat tasks. Production defaults
remain unchanged and no deployment is included.
