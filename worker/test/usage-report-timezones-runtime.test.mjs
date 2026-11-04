import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { startWorkerdFixture } from "../../test/helpers/workerd.mjs";

test("workerd exact IANA dates: quarter-hour offsets, both DST directions, midnight gap, arbitrary range clipping", { timeout: 60000 }, async () => {
  const root = join(process.cwd(), ".openclaw/tmp"); await mkdir(root, { recursive: true });
  const temporary = await mkdtemp(join(root, "report-timezones-")); let worker;
  try {
    worker = await startWorkerdFixture(temporary, `
      export * from "./worker/index.ts";
      import { usageDateTools, parseUsageReportRange } from "./worker/usage-report-range.ts";
      export default { fetch(request) {
        const q = new URL(request.url).searchParams;
        try {
          if (q.has("date")) return Response.json({ start: usageDateTools(q.get("timezone")).midnight(q.get("date")) });
          return Response.json(parseUsageReportRange(q, Date.parse("2026-11-03T12:00:00Z")));
        } catch (e) { return Response.json({ error: e.message }, { status: e.status ?? 500 }); }
      }};
    `, 'export default { fetch() { throw new Error("Unexpected upstream call"); } };');
    const midnight = async (timezone, date) => (await (await worker.dispatchFetch("https://fixture/?" + new URLSearchParams({ timezone, date }))).json()).start;
    for (const [zone, date, iso] of [
      ["Asia/Kolkata", "2026-11-01", "2026-10-31T18:30:00Z"],
      ["Asia/Kathmandu", "2026-11-01", "2026-10-31T18:15:00Z"],
      ["Pacific/Chatham", "2026-11-01", "2026-10-31T10:15:00Z"],
      ["America/Sao_Paulo", "2018-11-04", "2018-11-04T03:00:00Z"],
    ]) assert.equal(await midnight(zone, date), Date.parse(iso), zone);
    for (const [zone, start, end, hours] of [
      ["America/New_York", "2026-03-08", "2026-03-09", 23],
      ["America/New_York", "2026-11-01", "2026-11-02", 25],
      ["Australia/Lord_Howe", "2026-04-05", "2026-04-06", 24.5],
      ["Australia/Lord_Howe", "2026-10-04", "2026-10-05", 23.5],
      ["Pacific/Chatham", "2026-04-05", "2026-04-06", 25],
      ["Pacific/Chatham", "2026-09-27", "2026-09-28", 23],
    ]) assert.equal((await midnight(zone, end) - await midnight(zone, start)) / 3600000, hours, zone + start);
    assert.equal(await midnight("Pacific/Apia", "2011-12-30"), await midnight("Pacific/Apia", "2011-12-31"));
    const from = "2026-11-01T12:34:56.789+05:45", to = "2026-11-02T01:02:03+05:45";
    const range = await (await worker.dispatchFetch("https://fixture/?" + new URLSearchParams({ timezone: "Asia/Kathmandu", from, to }))).json();
    assert.equal(range.from, Date.parse(from)); assert.equal(range.to, Date.parse(to));
    assert.equal(range.buckets[0].start, Date.parse(from)); assert.equal(range.buckets.at(-1).end, Date.parse(to));
    assert.equal(range.buckets[0].end, Date.parse("2026-11-01T18:15:00Z"));
    for (const query of [{ timezone: "Invalid/Zone" }, { from: "2026-11-01T12:00:00", to: "2026-11-02" }, { from: "2026-02-30", to: "2026-03-01" }]) {
      assert.equal((await worker.dispatchFetch("https://fixture/?" + new URLSearchParams(query))).status, 400);
    }
  } finally { await worker?.dispose(); await rm(temporary, { recursive: true, force: true }); }
});
