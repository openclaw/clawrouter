import { responseEventIdentities, type ResponseIdentity } from "./response-identities.ts";

type Frame = Record<string, unknown>;
export type ResponsesCloseCause = "client_disconnect" | "upstream_disconnect" | "client_protocol_error" | "upstream_protocol_error" | "router_limit" | "router_error" | "timeout";
type Outcome = "completed" | "incomplete" | "failed" | "error" | ResponsesCloseCause;
type Ending = { outcome: Outcome; terminal: Frame | null };
type ErrorNotice = { code: string; message: string; status: number; lane?: string };

// Admission can settle before it returns an AdmittedResponse. Carry the owner
// cause through abort so a late rejection cannot invent a preflight failure.
export class ResponsesOperationAborted extends Error {
  readonly cause: ResponsesCloseCause;
  constructor(cause: ResponsesCloseCause) { super("Responses operation stopped"); this.cause = cause; }
}

export interface ResponsesSocket {
  send(message: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (event: any) => void): void;
}

export interface AdmittedResponse {
  /** Route and grant revision; never a credential. Changes require a new socket. */
  pin: string;
  payload: string;
  timeoutMs: number;
  assertDispatch(): void;
  connect(): Promise<ResponsesSocket>;
  publish(identities: readonly ResponseIdentity[], frame: Frame): Promise<void>;
  settle(outcome: Outcome, terminal: Frame | null, sent: boolean, executionStarted: boolean): Promise<void>;
}

interface SessionOptions {
  admit(body: Frame, lane: string | null, requestId: string, pin: string | null, signal: AbortSignal): Promise<AdmittedResponse>;
  waitUntil(promise: Promise<unknown>): void;
  limits?: Partial<typeof DEFAULT_LIMITS>;
}

const DEFAULT_LIMITS = { active: 16, lanes: 32, buffered: 48, frameBytes: 4 * 1024 * 1024, bufferedBytes: 8 * 1024 * 1024, outputBytes: 16 * 1024 * 1024, responseMs: 600_000, connectionMs: 3_600_000 };
const OUTPUT_LIMIT_ERROR: ErrorNotice = { code: "websocket_connection_limit_reached", message: "Router WebSocket output limit reached; open a new connection.", status: 400 };
const encoder = new TextEncoder();
const terminalTypes = new Map<string, Outcome>([["response.completed", "completed"], ["response.incomplete", "incomplete"], ["response.failed", "failed"], ["error", "error"]]);

interface Operation {
  lane: string;
  frame: string | null;
  bytes: number;
  requestId: string;
  started: number;
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
  admitted?: AdmittedResponse;
  responseId?: string;
  executionStarted: boolean;
  publication: Promise<void>;
  sent: boolean;
  ending?: Ending;
  settling?: Promise<void>;
}

/** Owns protocol ordering, bounded buffering, and exactly-once per-create settlement. */
export class ResponsesWebSocketSession {
  private client: ResponsesSocket;
  private options: SessionOptions;
  private limits: typeof DEFAULT_LIMITS;
  private lanes = new Map<string, Array<{ frame: string; bytes: number }>>();
  private active = new Map<string, Operation>();
  private terminalIds = new Map<string, string>();
  private bufferedBytes = 0;
  private bufferedCount = 0;
  private outputBytes = 0;
  private pin: string | null = null;
  private upstream: ResponsesSocket | null = null;
  private connecting: Promise<ResponsesSocket> | null = null;
  private admissions: Promise<void> = Promise.resolve();
  private publication: Promise<void> = Promise.resolve();
  private publishingBytes = 0;
  private publishingCount = 0;
  private ending: ResponsesCloseCause | null = null;
  private connectionTimer: ReturnType<typeof setTimeout>;

  constructor(client: ResponsesSocket, options: SessionOptions) {
    this.client = client;
    this.options = options;
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.connectionTimer = setTimeout(() => {
      this.close("router_limit", 1000, { code: "websocket_connection_limit_reached", message: "Responses WebSocket connection reached its time limit; open a new connection.", status: 400 });
    }, this.limits.connectionMs);
    client.addEventListener("message", (event) => this.receive(event.data));
    client.addEventListener("close", () => this.close("client_disconnect"));
    client.addEventListener("error", () => this.close("client_disconnect"));
  }

  private receive(data: unknown): void {
    if (this.ending) return;
    if (typeof data !== "string") {
      this.close("client_protocol_error", 1003, { code: "unsupported_event", message: "Responses WebSockets accept JSON text response.create events only.", status: 400 });
      return;
    }
    const bytes = encoder.encode(data).byteLength;
    if (bytes > this.limits.frameBytes) {
      this.error("request_too_large", "Response create exceeds the router WebSocket frame limit.", 413);
      return;
    }
    let frame: Frame;
    try {
      const parsed = JSON.parse(data);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      frame = parsed;
    } catch { this.error("invalid_json", "Expected a JSON response.create object.", 400); return; }
    const lane = frame.stream_id === undefined ? "" : frame.stream_id;
    if (typeof lane !== "string" || (frame.stream_id !== undefined && !/^[A-Za-z0-9_.-]{1,256}$/.test(lane))) {
      this.error("invalid_stream_id", "stream_id must contain 1–256 letters, numbers, underscores, hyphens, or periods.", 400);
      return;
    }
    if (frame.type !== "response.create" || frame.background === true) {
      this.error("unsupported_event", "Only response.create without background execution is supported.", 400, lane);
      return;
    }
    if (!this.lanes.has(lane) && lane && [...this.lanes.keys()].filter(Boolean).length >= this.limits.lanes) {
      this.error("websocket_stream_limit_reached", "Named stream limit reached; reuse a stream_id or open a new connection.", 400, lane);
      return;
    }
    if (this.bufferedCount >= this.limits.buffered || this.bufferedBytes + bytes > this.limits.bufferedBytes) {
      this.error("websocket_queue_full", "Router request queue is full; wait for an active response to finish.", 429, lane);
      return;
    }
    const queue = this.lanes.get(lane) ?? [];
    this.lanes.set(lane, queue);
    queue.push({ frame: data, bytes });
    this.bufferedCount++;
    this.bufferedBytes += bytes;
    this.schedule();
  }

  private schedule(): void {
    if (this.ending) return;
    for (const [lane, queue] of this.lanes) {
      if (this.active.size >= this.limits.active) break;
      if (this.active.has(lane) || !queue.length) continue;
      const queued = queue.shift()!;
      const op: Operation = { ...queued, lane, requestId: `ws_${crypto.randomUUID()}`, started: Date.now(), controller: new AbortController(), timer: setTimeout(() => this.timeout(op), this.limits.responseMs), sent: false, executionStarted: false, publication: Promise.resolve() };
      this.active.set(lane, op);
      // Serialize admission so large parsed bodies and the first route selection
      // have one owner. Already-dispatched responses still run concurrently.
      this.admissions = this.admissions.then(() => this.dispatch(op)).catch(() => this.close("router_error"));
      this.options.waitUntil(this.admissions);
    }
  }

  private async dispatch(op: Operation): Promise<void> {
    if (this.ending || op.ending) { this.releaseFrame(op); this.active.delete(op.lane); return; }
    let establishing = false;
    try {
      const body = JSON.parse(op.frame!);
      delete body.type;
      delete body.stream_id;
      // Current Codex serializes HTTP transport fields in response.create.
      // The upstream WebSocket contract owns streaming and cannot run background jobs.
      delete body.stream;
      delete body.background;
      op.admitted = await this.options.admit(body, op.lane || null, op.requestId, this.pin, op.controller.signal);
      if (this.ending || op.ending) { await this.finish(op, this.ending ?? "router_error", null); return; }
      if (this.pin !== null && this.pin !== op.admitted.pin) {
        this.close("router_error", 1000, { code: "provider_unavailable", message: "Responses upstream could not accept this request; open a new connection.", status: 502, lane: op.lane });
        return;
      }
      this.pin = op.admitted.pin;
      const remaining = Math.min(op.admitted.timeoutMs, this.limits.responseMs) - (Date.now() - op.started);
      clearTimeout(op.timer);
      if (remaining <= 0) { this.timeout(op); return; }
      op.timer = setTimeout(() => this.timeout(op), remaining);
      establishing = true;
      if (!this.connecting) this.connecting = op.admitted.connect().then((socket) => {
        this.upstream = socket;
        if (this.ending) { socket.close(1000, "session closed"); return socket; }
        socket.addEventListener("message", (event) => this.upstreamMessage(event.data));
        socket.addEventListener("close", () => this.close("upstream_disconnect"));
        socket.addEventListener("error", () => this.close("upstream_disconnect"));
        return socket;
      });
      const socket = await this.connecting;
      establishing = false;
      if (this.ending || op.ending) { await this.finish(op, this.ending ?? "router_error", null); return; }
      op.admitted.assertDispatch();
      socket.send(op.admitted.payload);
      op.sent = true;
      // Settlement captures only immutable accounting facts, never a request body.
      op.admitted.payload = "";
    } catch (error) {
      const failure = error as { status?: number; code?: string; message?: string };
      const notice = { code: failure.code ?? "provider_unavailable", message: failure.code ? failure.message ?? "Request could not be dispatched." : "Responses upstream could not accept this request; open a new connection.", status: failure.status ?? 502, lane: op.lane };
      // Claim the operation before error delivery can synchronously close the
      // client. A cancellation already owned by the session wins this race.
      const finished = this.finish(op, failure.code ? "error" : "upstream_disconnect", failure.code ? this.errorFrame(notice) : null);
      if (failure.code === "accounting_unavailable") this.close("router_error", 1000, notice);
      else if (establishing || !failure.code) this.close("upstream_disconnect", 1000, notice);
      else this.error(notice.code, notice.message, notice.status, notice.lane);
      await finished;
    } finally {
      this.releaseFrame(op);
      if (!op.admitted) { this.active.delete(op.lane); this.schedule(); }
    }
  }

  private upstreamMessage(data: unknown): void {
    if (this.ending) return;
    if (typeof data !== "string" || encoder.encode(data).byteLength > this.limits.frameBytes * 2) { this.close("upstream_protocol_error", 1009); return; }
    let event: Frame;
    try { event = JSON.parse(data); } catch { this.close("upstream_protocol_error", 1011); return; }
    if (!event || typeof event !== "object" || Array.isArray(event)) { this.close("upstream_protocol_error", 1011); return; }
    const lane = typeof event.stream_id === "string" ? event.stream_id : "";
    const op = this.active.get(lane);
    const response = event.response && typeof event.response === "object" ? event.response as Frame : null;
    const responseId = typeof response?.id === "string" ? response.id : typeof event.response_id === "string" ? event.response_id : undefined;
    const outcome = terminalTypes.get(String(event.type));
    if (responseId && outcome && this.terminalIds.get(lane) === responseId) return;
    // Terminal ownership is synchronous even while publication is pending.
    // Later frames cannot rewrite identity or turn rejected work into execution.
    if (op?.ending) return;
    let identities: ResponseIdentity[];
    try { identities = responseEventIdentities(event); }
    catch { this.close("upstream_protocol_error", 1011); return; }
    if (identities.length && !op?.sent) { this.close("upstream_protocol_error", 1011); return; }
    if (op?.sent && responseId) {
      // A late terminal from the previous turn must never bind the next turn.
      // Metadata can identify the response before execution actually starts.
      const starts = event.type === "response.created" || event.type === "response.in_progress";
      if (!op.responseId && !starts && event.type !== "response.metadata") { this.close("upstream_protocol_error", 1011); return; }
      if (op.responseId && op.responseId !== responseId) { this.close("upstream_protocol_error", 1011); return; }
      op.responseId = responseId;
      if (starts) op.executionStarted = true;
    }
    if (outcome && outcome !== "error" && (!responseId || !op?.responseId)) { this.close("upstream_protocol_error", 1011); return; }
    if (op?.sent && outcome) {
      if (responseId) this.terminalIds.set(lane, responseId);
      this.claim(op, outcome, event);
    }
    if (event.type === "error" && !lane && !op?.sent) { this.close("upstream_disconnect", 1000, data); return; }
    this.publish(data, op?.sent ? op : undefined, identities, event);
    if (op?.ending) this.options.waitUntil(this.finish(op, op.ending.outcome, op.ending.terminal));
  }

  private publish(data: string, op: Operation | undefined, identities: ResponseIdentity[], event: Frame): void {
    const bytes = encoder.encode(data).byteLength;
    if (this.publishingCount >= this.limits.buffered || this.publishingBytes + bytes > this.limits.bufferedBytes || !this.reserveOutput(bytes)) {
      this.close("router_limit", 1009, OUTPUT_LIMIT_ERROR);
      return;
    }
    this.publishingCount++;
    this.publishingBytes += bytes;
    // Capture the admitted operation now, never look it up after the await.
    // One bounded FIFO keeps metadata and every following wire frame ordered.
    const published = this.publication.then(async () => {
      if (this.ending) return;
      if (op) await op.admitted!.publish(identities, event);
      if (!this.ending) this.send(data);
    }).catch(() => {
      this.close("router_error", 1011, { code: "continuation_unavailable", message: "Continuation ownership could not be recorded; restart with full input.", status: 503, lane: op?.lane });
    }).finally(() => { this.publishingCount--; this.publishingBytes -= bytes; });
    this.publication = published;
    if (op) op.publication = published;
    this.options.waitUntil(published);
  }

  private timeout(op: Operation): void {
    if (op.settling) return;
    this.options.waitUntil(this.finish(op, "timeout", null));
    // Without an upstream cancellation acknowledgement, the socket must close:
    // dispatching another same-lane create would overlap an unaccounted response.
    this.close("router_error", 1000, { code: "response_timeout", message: "Response exceeded the router execution deadline; open a new connection.", status: 504, lane: op.lane });
  }

  private finish(op: Operation, outcome: Outcome, terminal: Frame | null): Promise<void> {
    if (op.settling) return op.settling;
    this.claim(op, outcome, terminal);
    if (!op.admitted) return Promise.resolve();
    const ending = op.ending!;
    op.settling = op.publication.then(() => op.admitted!.settle(ending.outcome, ending.terminal, op.sent, op.executionStarted)).catch(() => {
      this.close("router_error", 1000, { code: "accounting_unavailable", message: "Response accounting could not finish; open a new connection.", status: 503, lane: op.lane });
    }).finally(() => {
      this.releaseFrame(op);
      this.active.delete(op.lane);
      this.schedule();
    });
    return op.settling;
  }

  private claim(op: Operation, outcome: Outcome, terminal: Frame | null): void {
    if (op.ending) return;
    clearTimeout(op.timer);
    op.ending = { outcome, terminal };
  }

  private releaseFrame(op: Operation): void {
    if (op.frame === null) return;
    op.frame = null;
    this.bufferedBytes -= op.bytes;
    this.bufferedCount--;
  }

  private error(code: string, message: string, status: number, lane = ""): void {
    if (this.ending) return;
    this.forward(JSON.stringify(this.errorFrame({ code, message, status, lane })));
  }

  private errorFrame({ code, message, status, lane }: ErrorNotice): Frame {
    return { type: "error", status, ...(lane ? { stream_id: lane } : {}), error: { type: "invalid_request_error", code, message } };
  }

  private forward(message: string): void {
    if (this.ending) return;
    if (this.reserveOutput(encoder.encode(message).byteLength)) this.send(message);
  }

  private reserveOutput(bytes: number): boolean {
    this.outputBytes += bytes;
    // Workers WebSocket.send has no drain promise or supported bufferedAmount.
    // A cumulative cap bounds even a peer that never reads; reconnect, never replay here.
    if (this.outputBytes > this.limits.outputBytes) {
      this.close("router_limit", 1009, OUTPUT_LIMIT_ERROR);
      return false;
    }
    return true;
  }

  private send(message: string): void {
    try { this.client.send(message); } catch { this.close("client_disconnect"); }
  }

  close(cause: ResponsesCloseCause = "router_error", code = 1000, notice?: ErrorNotice | string): void {
    if (this.ending) return;
    this.ending = cause;
    clearTimeout(this.connectionTimer);
    for (const queue of this.lanes.values()) {
      for (const item of queue) { this.bufferedBytes -= item.bytes; this.bufferedCount--; }
      queue.length = 0;
    }
    for (const op of this.active.values()) this.options.waitUntil(this.finish(op, cause, null));
    for (const op of this.active.values()) {
      const ownedCause = op.ending!.outcome;
      op.controller.abort(new ResponsesOperationAborted(ownedCause === "timeout" ? "timeout" : cause));
    }
    // Cause ownership precedes abort, error delivery and reciprocal close events.
    if (notice) {
      if (typeof notice === "string" && this.outputBytes + encoder.encode(notice).byteLength > this.limits.outputBytes) { notice = OUTPUT_LIMIT_ERROR; code = 1009; }
      try { this.client.send(typeof notice === "string" ? notice : JSON.stringify(this.errorFrame(notice))); } catch { /* Peer already closed. */ }
    }
    try { this.upstream?.close(code, "session closed"); } catch { /* Socket already closed. */ }
    try { this.client.close(code, "session closed"); } catch { /* Socket already closed. */ }
  }
}
