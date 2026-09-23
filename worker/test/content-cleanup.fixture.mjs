import handler, { ContentArchiveCleanupObject as CleanupOwner } from "../index.ts";
export { BudgetLedgerObject, GrantCredentialObject, PolicyBindingIndexObject, UsageLedgerObject } from "../index.ts";

const wallTime = Date.now;

export class ContentArchiveCleanupObject extends CleanupOwner {
  constructor(state, env) {
    super(state, { CONTENT_ARCHIVE: {
      list: (options) => env.CONTENT_ARCHIVE.list(options),
      async delete(keys) {
        if (await env.CONTENT_ARCHIVE.head("fixture/fail-delete")) throw new Error("synthetic delete failure");
        await env.CONTENT_ARCHIVE.delete(keys);
        if (await env.CONTENT_ARCHIVE.head("fixture/pause")) {
          await env.CONTENT_ARCHIVE.put("fixture/paused", "paused before checkpoint");
          await new Promise((resolve) => setTimeout(resolve, 60_000));
        }
      },
    } });
    this.fixtureSql = state.storage.sql;
  }
  fetch(request) {
    if (new URL(request.url).pathname === "/fixture/status") {
      const row = [...this.fixtureSql.exec("SELECT state_json FROM content_cleanup WHERE id = 1")][0];
      return Response.json(row ? JSON.parse(row.state_json) : null);
    }
    return super.fetch(request);
  }
}

export default {
  ...handler,
  async fetch(request, env, context) {
    // Test-only clock advancement exercises old persisted uploads without waiting
    // 30 days or modifying Miniflare storage. No production clock/config seam.
    Date.now = () => wallTime() + Number(env.FIXTURE_AGE_DAYS ?? 0) * 86_400_000;
    const url = new URL(request.url);
    if (url.pathname === "/fixture/seed" && request.method === "POST") {
      const records = await request.json();
      for (const record of records) await env.CONTENT_ARCHIVE.put(record.key, record.body ?? "fixture-marker", { customMetadata: record.expiry === undefined ? {} : { expiresAt: record.expiry } });
      return Response.json({ seeded: records.length });
    }
    if (url.pathname === "/fixture/keys") {
      const keys = []; let cursor;
      do {
        const page = await env.CONTENT_ARCHIVE.list({ cursor });
        keys.push(...page.objects.map((object) => object.key));
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
      return Response.json(keys);
    }
    if (url.pathname === "/fixture/object") {
      const key = url.searchParams.get("key");
      if (request.method === "DELETE") { await env.CONTENT_ARCHIVE.delete(key); return new Response(null, { status: 204 }); }
      const object = await env.CONTENT_ARCHIVE.get(key);
      return object ? new Response(object.body) : new Response(null, { status: 404 });
    }
    if (url.pathname === "/fixture/status") return env.CONTENT_CLEANUP.get(env.CONTENT_CLEANUP.idFromName("content-archive-v1")).fetch("https://cleanup/fixture/status");
    return handler.fetch(request, env, context);
  },
};
