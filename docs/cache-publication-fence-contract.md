# Cache publication after invalidation

The isolate hot cache now grants each load a finite, opaque publication identity before loader or colo I/O starts. A public set, delete, clear, key-prefix invalidation or replacement leader supersedes earlier rights. Only the current identity can store a positive result or remove a value on a negative result. An old rejection/finally cannot remove a newer leader.

The live identity set is bounded by the cache's existing entry limit. Invalidated identities remain counted until their original loader settles. Overflow runs uncached; it neither removes fencing evidence nor creates per-key tombstones or predicate history. This is logical publication ownership, not a new control-memory or physical-retirement budget.

Key-only invalidation checks stored and pending-only credential versions. Value predicates conservatively revoke all unknown pending publications while retaining unrelated stored values. Predicates are not retained. Followers observe replacement/invalidation using their own request timers and recheck local state after waiting; they never await another request's I/O promise.

Admission misses and stale refreshes use the same identities for local entries, selection hints and colo publication. Snapshot acquisition time is captured before the authority request and carried through both layers. Completion and adoption do not refresh max age. A constant issuance watermark prevents equal or rolled-back clocks from lowering the shared invalidation fence. Already-issued late Cache API writes retain their original timestamp and cannot be adopted behind this isolate's fence. During a clock rollback, shared entries may remain unusable until time advances beyond the fence; authoritative requests still work.

Pending runtime feedback, selection counts, cursors and their coalesced flushes remain writes, not cache entries. Invalidation does not clear them. Wrong-secret isolation, configured expiry/refresh margins, failover and MiniMax Music/image speculative-prefetch exclusions remain unchanged.

## Evidence and limits

Focused Node cases cover old cacheable, uncacheable and rejected completions; newer explicit values/replacement loads; pending-only credential versions; bounded overflow; unrelated keys; stale refresh; hints; held colo reads; late physical puts; equal/rollback clocks; and retained coalesced writes. Existing hot-path positive/deduplication/concurrency tests remain required.

One isolated Workerd fixture exercises actual public inference/admin routes, SQLite authority/credential objects and Cache API publication/adoption across a runtime restart. The revocation case holds a completed enabled-admission reply, performs an authenticated admin revoke, then checks a new request's fresh denial and zero new provider calls. It does not clear caches to manufacture the race.

The 401/403 cases warm model A, hold its genuine provider response, expire only the cache clock, and hold a never-hinted model B's admission before its single foreground materialization. After A's real key-prefix eviction, B and all original background work drain. Only then does the fixture advance wall time beyond the recorded cooldown while keeping cache time fixed. C must materialize the same grant version again before provider egress; D proves the legitimate later cache hit. HTTP barriers belong to the original request contexts; cleanup releases present and future barriers and joins started clients/background work before runtime disposal.

These are authored tests until exact-head hosted execution passes. This slice prevents future stale publication/reuse after same-isolate invalidation. It does not revoke already-running consumers, add cross-isolate immediate revocation, change Cache API storage, or qualify broader cache/SQL/KV byte budgets, physical retirement, whole-heap usage or the common request ledger.
