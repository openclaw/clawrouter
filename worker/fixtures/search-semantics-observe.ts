// Optional, temporary instrumentation. The normal fixture entrypoint stays unchanged.
import fixture, { SearchSemanticsObject as FixtureObject } from "./search-semantics";

const HOST = "clawrouter-fakeco.openclaw.ai";
const PREFIX = "/search-semantics/";
const CONTROL = `${PREFIX}_control/observations`;
const OBJECT = "request-observations-v1";
const HANDLER = "observations-v1";
const EVENT = "https://fixture-observations.internal/event";
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const PATHS = ["robots", "robots_variant", "diagnostic", "diagnostic_variant", "health", "matrix", "fixture_other"] as const;
const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "OTHER"] as const;
type Event = { path: typeof PATHS[number]; method: typeof METHODS[number]; query: boolean; status: number };
type Counter = Event & { count: number };
type Observation = { id: string; expiresAt: number; counters: Counter[]; overflow: number; saturated: boolean };
type Env = {
  SEARCH_SEMANTICS_ENVIRONMENT?: string;
  SEARCH_SEMANTICS_CONTROL_SHA256?: string;
  SEARCH_SEMANTICS: DurableObjectNamespace;
  SEARCH_SEMANTICS_ROBOTS_ORIGIN: Fetcher;
};
const identified = (response: Response) => { response.headers.set("x-clawrouter-observation-handler", HANDLER); return response; };
const json = (value: unknown, status = 200) => identified(Response.json(value, { status, headers: { "cache-control": "no-store" } }));
const absent = () => new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
const object = (env: Env) => env.SEARCH_SEMANTICS.get(env.SEARCH_SEMANTICS.idFromName(OBJECT));

async function authorized(request: Request, env: Env): Promise<boolean> {
  const token = request.headers.get("authorization")?.match(/^Bearer ([a-zA-Z0-9_-]{40,128})$/)?.[1];
  const expected = env.SEARCH_SEMANTICS_CONTROL_SHA256;
  if (!token || !expected || !/^[a-f0-9]{64}$/.test(expected)) return false;
  const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)))].map(byte => byte.toString(16).padStart(2, "0")).join("");
  return digest === expected;
}

function category(url: URL): Event["path"] {
  const path = url.pathname;
  if (path === "/robots.txt") return "robots";
  if (path.startsWith("/robots.txt")) return "robots_variant";
  if (path === `${PREFIX}diagnostic`) return "diagnostic";
  if (path.startsWith(`${PREFIX}diagnostic`)) return "diagnostic_variant";
  if (path === `${PREFIX}health`) return "health";
  if (new RegExp(`^${PREFIX}${UUID}/${UUID}$`).test(path)) return "matrix";
  return "fixture_other";
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (env.SEARCH_SEMANTICS_ENVIRONMENT !== "fakeco" || url.hostname !== HOST || url.port) return fixture.fetch(request, env);
    // Controls have the same strict host/scheme/query/auth boundary as the base fixture.
    if (url.pathname === CONTROL || url.pathname.startsWith(`${CONTROL}/`)) {
      if (url.protocol !== "https:" || url.search || !await authorized(request, env)) return absent();
      return object(env).fetch(request);
    }
    const robots = url.protocol === "https:" && url.pathname.startsWith("/robots.txt");
    const observe = (robots || url.pathname.startsWith(PREFIX)) && !url.pathname.startsWith(`${PREFIX}_control/`);
    let response: Response | undefined;
    try {
      // A service binding avoids fetching through our own public robots route.
      response = robots ? await env.SEARCH_SEMANTICS_ROBOTS_ORIGIN.fetch(request) : await fixture.fetch(request, env);
      return response;
    } finally {
      if (observe) {
        const event: Event = { path: category(url), method: METHODS.includes(request.method as Event["method"]) ? request.method as Event["method"] : "OTHER", query: !!url.search, status: response?.status ?? 0 };
        // Measurement failure must not replace the original response/exception.
        // Therefore zero observations never prove that no request arrived.
        try { await object(env).fetch(EVENT, { method: "POST", body: JSON.stringify(event) }); } catch { /* no raw request logging */ }
      }
    }
  },
};

async function smallInput(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new Error("invalid input");
  const decoder = new TextDecoder();
  let size = 0, text = "";
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    size += value.length;
    if (size > 128) { await reader.cancel(); throw new Error("invalid input"); }
    text += decoder.decode(value, { stream: true });
  }
  return JSON.parse(text + decoder.decode());
}

async function active(storage: DurableObjectTransaction): Promise<Observation | undefined> {
  const value = await storage.get<Observation>("observations");
  if (value && value.expiresAt > Date.now()) return value;
  await storage.delete("observations");
  return undefined;
}

// Same class/namespace, separate fixed object name; its alarm cannot affect fixture-v1.
export class SearchSemanticsObject extends FixtureObject {
  private isObserver: boolean;
  constructor(private observationState: DurableObjectState, env: Env) {
    super(observationState);
    this.isObserver = observationState.id.equals(env.SEARCH_SEMANTICS.idFromName(OBJECT));
  }

  async alarm(): Promise<void> {
    if (!this.isObserver) return super.alarm();
    await this.observationState.storage.transaction(async storage => {
      const value = await active(storage);
      if (value) await storage.setAlarm(value.expiresAt); else await storage.deleteAlarm();
    });
  }

  async fetch(request: Request): Promise<Response> {
    if (!this.isObserver) return super.fetch(request);
    const path = new URL(request.url).pathname;
    // No storage read/write or session allocation. A previous class returns 404.
    if (path === `${CONTROL}/ready` && request.method === "GET") return json({ ready: true, protocol: HANDLER });
    const eventRequest = request.url === EVENT && request.method === "POST";
    let input: unknown;
    if (eventRequest || path === CONTROL && request.method === "POST") {
      try { input = await smallInput(request); } catch { return json({ error: "invalid_input" }, 400); }
      if (!input || Array.isArray(input) || typeof input !== "object") return json({ error: "invalid_input" }, 400);
      if (eventRequest) {
        const value = input as Event;
        if (Object.keys(value).sort().join(",") !== "method,path,query,status" || !PATHS.includes(value.path) || !METHODS.includes(value.method) || typeof value.query !== "boolean" || !(Number.isInteger(value.status) && (value.status === 0 || value.status >= 100 && value.status <= 599))) return json({ error: "invalid_input" }, 400);
      } else if (Object.keys(input).some(key => key !== "ttlSeconds") || (input as { ttlSeconds?: number }).ttlSeconds !== 300) return json({ error: "invalid_input" }, 400);
    }
    return this.observationState.storage.transaction(async storage => {
      let value = await active(storage);
      let response = identified(absent());
      const id = path.match(new RegExp(`^${CONTROL}/(${UUID})$`))?.[1];
      if (eventRequest) {
        if (value) {
          const event = input as Event;
          const counter = value.counters.find(c => c.path === event.path && c.method === event.method && c.query === event.query && c.status === event.status);
          if (counter) { if (counter.count < 1_000_000) counter.count++; else value.saturated = true; }
          else if (value.counters.length < 128) value.counters.push({ ...event, count: 1 });
          else if (value.overflow < 1_000_000) value.overflow++; else value.saturated = true;
        }
        response = new Response(null, { status: 204 });
      } else if (path === CONTROL && request.method === "POST") {
        if (value) response = json({ error: "capacity" }, 409);
        else { value = { id: crypto.randomUUID(), expiresAt: Date.now() + 300_000, counters: [], overflow: 0, saturated: false }; response = json(value, 201); }
      } else if ((path === CONTROL || id === value?.id) && request.method === "GET") {
        if (value) response = json(value);
      } else if (value && id === value.id && request.method === "DELETE") {
        value = undefined; response = json({ deleted: true });
      }
      if (value) { await storage.put("observations", value); await storage.setAlarm(value.expiresAt); }
      else { await storage.delete("observations"); await storage.deleteAlarm(); }
      return response;
    });
  }
}
