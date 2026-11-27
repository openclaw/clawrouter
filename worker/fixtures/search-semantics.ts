// Standalone synthetic fixture. Never imported by the router Worker.
const HOST = "clawrouter-fakeco.openclaw.ai";
const PREFIX = "/search-semantics/";
const DIAGNOSTIC = `${PREFIX}diagnostic`;
const DIAGNOSTIC_CONTROL = `${PREFIX}_control/diagnostic`;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const NAMES = ["cached", "live", "warm", "child"] as const;
type PageName = typeof NAMES[number];
type Page = { id: string; marker: string; revision: number; gets: number; heads: number; revisionGets: number };
type Run = { id: string; expiresAt: number; pages: Record<PageName, Page> };
type Diagnostic = { id: string; marker: string; expiresAt: number; gets: number; heads: number; lastGetAt: number | null; lastHeadAt: number | null };
type Env = { SEARCH_SEMANTICS_ENVIRONMENT?: string; SEARCH_SEMANTICS_CONTROL_SHA256?: string; SEARCH_SEMANTICS: DurableObjectNamespace };
const marker = () => `ClawRouterProbe${crypto.randomUUID().replaceAll("-", "")}`;
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });
const absent = () => new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });

async function saveRegistry(storage: DurableObjectTransaction, runs: Run[], diagnostic?: Diagnostic): Promise<void> {
  await storage.put("runs", runs);
  if (diagnostic) await storage.put("diagnostic", diagnostic);
  else await storage.delete("diagnostic");
  const expiries = [...runs.map(run => run.expiresAt), ...(diagnostic ? [diagnostic.expiresAt] : [])];
  if (expiries.length) await storage.setAlarm(Math.min(...expiries));
  else await storage.deleteAlarm();
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (env.SEARCH_SEMANTICS_ENVIRONMENT !== "fakeco" || url.protocol !== "https:" || url.hostname !== HOST || url.port || url.search || !url.pathname.startsWith(PREFIX)) return absent();
    if (url.pathname === `${PREFIX}health` && request.method === "GET") return json({ ok: true, environment: "fakeco", fixture: "search-semantics-v1" });
    if (url.pathname.startsWith(`${PREFIX}_control/`)) {
      const token = request.headers.get("authorization")?.match(/^Bearer ([a-zA-Z0-9_-]{40,128})$/)?.[1];
      const expected = env.SEARCH_SEMANTICS_CONTROL_SHA256;
      if (!token || !expected || !/^[a-f0-9]{64}$/.test(expected)) return absent();
      const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)))].map(byte => byte.toString(16).padStart(2, "0")).join("");
      if (digest !== expected) return absent();
    } else if (!["GET", "HEAD"].includes(request.method) || (url.pathname !== DIAGNOSTIC && !new RegExp(`^${PREFIX}${UUID}/${UUID}$`).test(url.pathname))) return absent();
    // One bounded registry: unknown public IDs cannot allocate new objects.
    return env.SEARCH_SEMANTICS.get(env.SEARCH_SEMANTICS.idFromName("fixture-v1")).fetch(request);
  },
};

export class SearchSemanticsObject {
  constructor(private state: DurableObjectState) {}

  async alarm(): Promise<void> {
    await this.state.storage.transaction(async storage => {
      const runs = (await storage.get<Run[]>("runs") ?? []).filter(run => run.expiresAt > Date.now());
      const diagnostic = await storage.get<Diagnostic>("diagnostic");
      await saveRegistry(storage, runs, diagnostic && diagnostic.expiresAt > Date.now() ? diagnostic : undefined);
    });
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    let ttl = path === DIAGNOSTIC_CONTROL ? 300 : 3600;
    if ([`${PREFIX}_control/runs`, DIAGNOSTIC_CONTROL].includes(path) && request.method === "POST") {
      // Small fixed input; no arbitrary text, HTML, URLs or markers accepted.
      const reader = request.body?.getReader();
      let bytes = 0, text = "";
      if (reader) {
        const decoder = new TextDecoder();
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          bytes += value.length;
          if (bytes > 128) { await reader.cancel(); return json({ error: "invalid_input" }, 400); }
          text += decoder.decode(value, { stream: true });
        }
        text += decoder.decode();
      }
      let input: { ttlSeconds?: number };
      try { input = JSON.parse(text); } catch { return json({ error: "invalid_input" }, 400); }
      if (!input || Array.isArray(input) || typeof input !== "object" || Object.keys(input).some(key => key !== "ttlSeconds")) return json({ error: "invalid_input" }, 400);
      ttl = input.ttlSeconds ?? ttl;
      if (!Number.isInteger(ttl) || ttl < 60 || ttl > 7200) return json({ error: "invalid_input" }, 400);
    }
    return this.state.storage.transaction(async storage => {
      const runs = (await storage.get<Run[]>("runs") ?? []).filter(run => run.expiresAt > Date.now());
      let diagnostic = await storage.get<Diagnostic>("diagnostic");
      if (diagnostic && diagnostic.expiresAt <= Date.now()) diagnostic = undefined;
      let response: Response = absent();
      const diagnosticControl = path.match(new RegExp(`^${DIAGNOSTIC_CONTROL}/(${UUID})$`));
      if (path === DIAGNOSTIC_CONTROL && request.method === "POST") {
        if (diagnostic) response = json({ error: "capacity" }, 409);
        else {
          diagnostic = { id: crypto.randomUUID(), marker: marker(), expiresAt: Date.now() + ttl * 1000, gets: 0, heads: 0, lastGetAt: null, lastHeadAt: null };
          response = json(diagnostic, 201);
        }
      } else if (path === DIAGNOSTIC_CONTROL && request.method === "GET") {
        response = diagnostic ? json(diagnostic) : absent();
      } else if (diagnostic && diagnosticControl?.[1] === diagnostic.id) {
        if (request.method === "GET") response = json(diagnostic);
        if (request.method === "DELETE") { diagnostic = undefined; response = json({ deleted: true }); }
      } else if (path === DIAGNOSTIC && diagnostic && ["GET", "HEAD"].includes(request.method)) {
        if (request.method === "GET") { diagnostic.gets++; diagnostic.lastGetAt = Date.now(); }
        else { diagnostic.heads++; diagnostic.lastHeadAt = Date.now(); }
        const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>FakeCo retrieval diagnostic</title></head><body><h1>FakeCo retrieval diagnostic</h1><p>Synthetic content for a short-lived retrieval test.</p><p>Marker: ${diagnostic.marker}</p></body></html>`;
        response = new Response(request.method === "HEAD" ? null : html, { headers: {
          "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
          "cloudflare-cdn-cache-control": "no-store", "cdn-cache-control": "no-store",
          "x-content-type-options": "nosniff",
        } });
      } else if (path === `${PREFIX}_control/runs` && request.method === "POST") {
        if (runs.length >= 16) response = json({ error: "capacity" }, 409);
        else {
          const run: Run = { id: crypto.randomUUID(), expiresAt: Date.now() + ttl * 1000, pages: Object.fromEntries(NAMES.map(name => [name, { id: crypto.randomUUID(), marker: marker(), revision: 1, gets: 0, heads: 0, revisionGets: 0 }])) as Run["pages"] };
          runs.push(run); response = json(run, 201);
        }
      } else {
        const control = path.match(new RegExp(`^${PREFIX}_control/runs/(${UUID})(?:/pages/(warm))?$`));
        const publicPage = path.match(new RegExp(`^${PREFIX}(${UUID})/(${UUID})$`));
        const run = runs.find(item => item.id === (control?.[1] ?? publicPage?.[1]));
        if (run && control) {
          if (!control[2] && request.method === "GET") response = json(run);
          if (!control[2] && request.method === "DELETE") { runs.splice(runs.indexOf(run), 1); response = json({ deleted: true }); }
          if (control[2] && request.method === "POST") {
            const page = run.pages.warm;
            page.marker = marker(); page.revision++; page.revisionGets = 0;
            response = json(run);
          }
        } else if (run && publicPage && ["GET", "HEAD"].includes(request.method)) {
          const page = Object.values(run.pages).find(item => item.id === publicPage[2]);
          if (page) {
            if (request.method === "GET") { page.gets++; page.revisionGets++; } else page.heads++;
            const child = `https://${HOST}${PREFIX}${run.id}/${run.pages.child.id}`;
            const html = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Synthetic search fixture</title><h1>Synthetic search fixture</h1><p>Revision ${page.revision}. Marker: ${page.marker}</p><a href="${child}">Controlled child page</a></html>`;
            response = new Response(request.method === "HEAD" ? null : html, { headers: {
              "content-type": "text/html; charset=utf-8",
              // Permit upstream caches, but force each origin request through the DO.
              "cache-control": "public, max-age=3600",
              "cloudflare-cdn-cache-control": "no-store", "cdn-cache-control": "no-store",
              "x-robots-tag": "noindex", "x-content-type-options": "nosniff",
            } });
          }
        }
      }
      await saveRegistry(storage, runs, diagnostic);
      return response;
    });
  }
}
