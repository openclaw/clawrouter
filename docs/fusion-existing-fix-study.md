# Fresh controls on an existing-module repair

All three arms passed the full 10-test suite, but the cheap-first cascade cost
8.77% more and took 70.37% longer than strong-only. Cheap-only also passed, at
90.32% lower model cost than strong-only. This one-task development comparison
does not support promoting the cascade.

| Arm | Calls | Full tests passed | Model cost, USD | Workflow time |
| --- | ---: | ---: | ---: | ---: |
| Cheap-only | 1 | 10/10 | 0.000960 | 8.775 s |
| Strong-only | 1 | 10/10 | 0.009922 | 8.896 s |
| Cheap draft, fresh strong fallback | 2 | 10/10 | 0.010792 | 15.156 s |

The cascade's Luna draft failed public tests, and its fresh Terra fallback
passed. The independently generated cheap-only draw passed both public and
full tests. A fallback rescue therefore does not establish improvement over
an independent cheap-only control. No model outputs were reused across arms.

## Method

The task is the historical [nested-scope inventory fix](https://github.com/openclaw/clawrouter/commit/2ebd72d94325bc61109b96d9dcd2ac600e4eb741).
A fixed cached-history screen selected six fixes to existing modules and test
files, one per source, excluding the prior cohort and two known paid tasks.
Four cases lacked supported public/hidden partitions. Another failed exact
native counts. One qualified; no replacement cases were added.

Before inference, the reference passed full/public/hidden views of 10/9/1 tests.
The parent failed all three with matching counts. Each request received the
same original source and public tests. The cascade made one cheap call and,
only after public rejection, one fresh strong call. It had no extra cheap
repair. The separate cheap-only and strong-only arms each made one fresh call.
Order was fixed as cheap-only, strong-only, cascade. Full grading followed all
generation and public routing decisions.

The frozen development gate required preserved strong-model quality,
improvement over cheap-only, at least 20% savings in both actual and
cache-neutral model cost, and no more than 20% additional workflow time.
Only quality preservation passed. The four calls cost $0.021674 in total.

Workflow time includes generation, public verification and caller overhead;
it excludes final hidden grading. Fixed order, one task and one draw per arm
leave timing and model variance unresolved. The task is historical development
data, not independent population confirmation. These results change neither
Worker defaults nor production qualification.

The [sanitized records](fusion-existing-fix-study.json) retain separate arm and
call costs, test counts, gates and private receipt hashes. Costs use frozen
tariffs and recorded usage, not invoice reconciliation. Hashes identify private
evidence; they do not independently certify its contents.
