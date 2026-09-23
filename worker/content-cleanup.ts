import { retainedContentDeadline } from "./content-retention.ts";
import type { Env } from "./types";
import { json } from "./utils.ts";

interface CleanupState {
  cursor: string | null;
  cycleStartedAt: number;
  lastAttemptAt: number;
  lastCompletedAt: number | null;
  scanned: number;
  deleted: number;
  failed: boolean;
}

export class ContentArchiveCleanupObject implements DurableObject {
  private readonly sql: SqlStorage;
  private readonly archive: R2Bucket;
  private pending: Promise<unknown> = Promise.resolve();

  constructor(state: DurableObjectState, env: Pick<Env, "CONTENT_ARCHIVE">) {
    this.sql = state.storage.sql;
    this.archive = env.CONTENT_ARCHIVE;
    this.sql.exec("CREATE TABLE IF NOT EXISTS content_cleanup (id INTEGER PRIMARY KEY CHECK (id = 1), state_json TEXT NOT NULL)");
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/sweep") return new Response(null, { status: 404 });
    // R2 awaits allow request interleaving; keep list/delete/checkpoint serialized.
    const operation = this.pending.then(() => this.sweep());
    this.pending = operation.catch(() => undefined);
    try { return json(await operation); }
    catch { return json({ error: "content cleanup failed" }, 500); }
  }

  private async sweep() {
    const now = Date.now();
    const row = [...this.sql.exec<{ state_json: string }>("SELECT state_json FROM content_cleanup WHERE id = 1")][0];
    const previous: CleanupState = row ? JSON.parse(row.state_json) : { cursor: null, cycleStartedAt: now, lastAttemptAt: now, lastCompletedAt: null, scanned: 0, deleted: 0, failed: false };
    const state = { ...previous, lastAttemptAt: now };
    try {
      const page = await this.archive.list({ prefix: "v1/", limit: 1000, include: ["customMetadata"], ...(state.cursor ? { cursor: state.cursor } : {}) });
      const cursor = page.truncated ? page.cursor : null;
      if (page.truncated && (!cursor || cursor === state.cursor)) throw new Error("archive cursor did not advance");
      const checkedAt = Date.now();
      const expired = page.objects.filter((object) => retainedContentDeadline(object) <= checkedAt).map((object) => object.key);
      if (expired.length) await this.archive.delete(expired);
      // A crash before this checkpoint repeats idempotent deletes. Short metadata
      // pages still have a cursor; EOF resets it so earlier keys are revisited.
      Object.assign(state, {
        cursor, cycleStartedAt: previous.cursor ? previous.cycleStartedAt : now,
        scanned: (previous.cursor ? previous.scanned : 0) + page.objects.length,
        deleted: (previous.cursor ? previous.deleted : 0) + expired.length,
        lastCompletedAt: cursor ? previous.lastCompletedAt : Date.now(), failed: false,
      });
      this.store(state);
      const { cursor: _, ...status } = state;
      return { ...status, backlog: cursor !== null };
    } catch (error) {
      this.store({ ...previous, lastAttemptAt: now, failed: true });
      throw error;
    }
  }

  private store(state: CleanupState): void {
    this.sql.exec("INSERT OR REPLACE INTO content_cleanup (id, state_json) VALUES (1, ?)", JSON.stringify(state));
  }
}

export async function scheduledContentCleanup(_controller: ScheduledController, env: Env): Promise<void> {
  const owner = env.CONTENT_CLEANUP.get(env.CONTENT_CLEANUP.idFromName("content-archive-v1"));
  const response = await owner.fetch("https://content-cleanup/sweep", { method: "POST" });
  if (!response.ok) throw new Error("content archive cleanup failed");
  console.info("content archive cleanup", await response.json());
}
