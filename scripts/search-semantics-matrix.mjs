import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const requests = run => Object.values(run.pages).reduce((sum, page) => sum + page.gets + page.heads, 0);
const successful = result => result.summary.status === 200 && result.summary.outputChars > 0 && !result.summary.internalError && !result.summary.fetchError && !result.summary.referenceError;

// Fresh hidden markers never enter a command. Output and markers remain in memory.
// A failed live control cannot establish cache-only semantics by absence of hits.
export async function searchSemanticsMatrix({ fixture, probe, model, settle = () => new Promise(resolve => setTimeout(resolve, 2000)) }) {
  const rows = [];
  async function call(kind, mode, pageName, id = randomUUID(), commands) {
    const before = await fixture.snapshot();
    const page = before.pages[pageName];
    const result = await probe({ body: { id, model, commands: { ...(commands ?? { open: [{ ref_id: fixture.url(pageName) }] }), response_length: "short" }, settings: { external_web_access: mode === "live" } }, marker: page.marker });
    await settle();
    const after = await fixture.snapshot();
    const delta = requests(after) - requests(before);
    const gets = after.pages[pageName].revisionGets - page.revisionGets;
    assert.ok(delta >= 0 && gets >= 0 && after.pages[pageName].revision === page.revision, "fixture counters remain monotonic at the same revision");
    const row = { kind, mode, ...result.summary, originRequests: delta, currentRevisionGets: gets };
    rows.push(row);
    return { row, result, ok: successful(result), id };
  }
  const cached = await call("fresh", "cached", "cached");
  const live = await call("fresh", "live", "live");
  const freshSnapshot = await fixture.snapshot();
  const liveControl = live.ok && live.row.markerReturned && live.row.currentRevisionGets > 0;
  const cachedViolation = cached.row.originRequests > 0 || cached.row.markerReturned || freshSnapshot.pages.cached.gets + freshSnapshot.pages.cached.heads > 0;
  // Stop before spending on warm/navigation tests when fresh retrieval is unavailable.
  if (!liveControl || cachedViolation) return { status: cachedViolation ? "violation" : "inconclusive", liveControl, cacheOnlyObserved: false, rows };

  const warm = await call("warm", "live", "warm");
  if (!warm.ok || !warm.row.markerReturned || warm.row.currentRevisionGets === 0) return { status: "inconclusive", liveControl, cacheOnlyObserved: true, rows };
  const previousMarker = fixture.initial.pages.warm.marker;
  await fixture.rotate();
  const warmCached = await call("rotated", "cached", "warm");
  const warmViolation = warmCached.row.originRequests > 0 || warmCached.row.markerReturned;
  // Seeing A after rotation is stronger evidence than a cache miss. Neither proves
  // provider-wide isolation; cached mode may legitimately miss an unindexed URL.
  warmCached.row.previousRevisionReturned = warmCached.result.value.output?.includes(previousMarker) === true;
  const changed = await call("rotated", "live", "warm");
  const ref = changed.result.value.output?.match(/turn\d+(?:view|search)\d+/)?.[0];
  let navigation = false;
  if (changed.ok && ref) {
    // The synthetic page has exactly one link; use its provider-assigned link ID.
    const link = changed.result.value.output?.match(/【(\d+)†[^】]*Controlled child page[^】]*】/)?.[1];
    if (link) {
      const clicked = await call("click", "live", "child", changed.id, { click: [{ ref_id: ref, id: Number(link) }] });
      const childRef = clicked.result.value.output?.match(/turn\d+(?:view|search)\d+/)?.[0];
      if (clicked.ok && clicked.row.markerReturned && childRef) {
        const found = await call("find", "live", "child", changed.id, { find: [{ ref_id: childRef, pattern: "ClawRouterProbe" }] });
        navigation = found.ok && found.row.markerReturned;
      }
    }
  }
  await settle();
  const final = await fixture.snapshot();
  const lateCachedFetch = final.pages.cached.gets + final.pages.cached.heads > 0;
  return { status: warmViolation || lateCachedFetch ? "violation" : "observed", liveControl, cacheOnlyObserved: !warmViolation && !lateCachedFetch,
    warmCacheObserved: !warmViolation && warmCached.row.previousRevisionReturned,
    liveRefreshObserved: changed.ok && changed.row.markerReturned && changed.row.currentRevisionGets > 0,
    navigationObserved: navigation, rows };
}
