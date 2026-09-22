type Frame = Record<string, unknown>;
type Outcome = "completed" | "incomplete" | "failed" | "error" | "disconnect" | "timeout" | "not_sent";

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
  connect(): Promise<ResponsesSocket>;
  settle(outcome: Outcome, terminal: Frame | null, executionStarted: boolean): Promise<void>;
}

interface SessionOptions {
  admit(body: Frame, lane: string | null, requestId: string, pin: string | null, signal: AbortSignal): Promise<AdmittedResponse>;
  waitUntil(promise: Promise<unknown>): void;
  limits?: Partial<typeof DEFAULT_LIMITS>;
}

const DEFAULT_LIMITS = { active: 16, lanes: 32, buffered: 48, frameBytes: 4 * 1024 * 1024, bufferedBytes: 8 * 1024 * 1024, outputBytes: 16 * 1024 * 1024, responseMs: 600_000, connectionMs: 3_600_000 };
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
  sent: boolean;
  ending?: Outcome;
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
  private closed = false;
  private connectionTimer: ReturnType<typeof setTimeout>;

  constructor(client: ResponsesSocket, options: SessionOptions) {
    this.client = client;
    this.options = options;
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.connectionTimer = setTimeout(() => {
      this.error("websocket_connection_limit_reached", "Responses WebSocket connection reached its time limit; open a new connection.", 400);
      this.close("disconnect");
    }, this.limits.connectionMs);
    client.addEventListener("message", (event) => this.receive(event.data));
    client.addEventListener("close", () => this.close("disconnect"));
    client.addEventListener("error", () => this.close("disconnect"));
  }

  private receive(data: unknown): void {
    if (this.closed) return;
    if (typeof data !== "string") {
      this.error("unsupported_event", "Responses WebSockets accept JSON text response.create events only.", 400);
      this.close("disconnect", 1003);
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
    if (this.closed) return;
    for (const [lane, queue] of this.lanes) {
      if (this.active.size >= this.limits.active) break;
      if (this.active.has(lane) || !queue.length) continue;
      const queued = queue.shift()!;
      const op: Operation = { ...queued, lane, requestId: `ws_${crypto.randomUUID()}`, started: Date.now(), controller: new AbortController(), timer: setTimeout(() => this.timeout(op), this.limits.responseMs), sent: false };
      this.active.set(lane, op);
      // Serialize admission so large parsed bodies and the first route selection
      // have one owner. Already-dispatched responses still run concurrently.
      this.admissions = this.admissions.then(() => this.dispatch(op)).catch(() => this.close("disconnect"));
      this.options.waitUntil(this.admissions);
    }
  }

  private async dispatch(op: Operation): Promise<void> {
    if (this.closed || op.ending) { this.releaseFrame(op); this.active.delete(op.lane); return; }
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
      if (this.closed || op.ending) { await this.finish(op, "not_sent", null); return; }
      if (this.pin !== null && this.pin !== op.admitted.pin) throw new Error("route_changed");
      this.pin = op.admitted.pin;
      const remaining = Math.min(op.admitted.timeoutMs, this.limits.responseMs) - (Date.now() - op.started);
      clearTimeout(op.timer);
      if (remaining <= 0) { this.timeout(op); return; }
      op.timer = setTimeout(() => this.timeout(op), remaining);
      establishing = true;
      if (!this.connecting) this.connecting = op.admitted.connect().then((socket) => {
        this.upstream = socket;
        if (this.closed) { socket.close(1000, "session closed"); return socket; }
        socket.addEventListener("message", (event) => this.upstreamMessage(event.data));
        socket.addEventListener("close", () => this.close("disconnect"));
        socket.addEventListener("error", () => this.close("disconnect"));
        return socket;
      });
      const socket = await this.connecting;
      establishing = false;
      if (this.closed || op.ending) { await this.finish(op, "not_sent", null); return; }
      socket.send(op.admitted.payload);
      op.sent = true;
      // Settlement captures only immutable accounting facts, never a request body.
      op.admitted.payload = "";
    } catch (error) {
      const failure = error as { status?: number; code?: string; message?: string };
      this.error(failure.code ?? "provider_unavailable", failure.code ? failure.message ?? "Request could not be dispatched." : "Responses upstream could not accept this request; open a new connection.", failure.status ?? 502, op.lane);
      if (failure.code === "accounting_unavailable") this.close("disconnect");
      await this.finish(op, op.sent ? "disconnect" : "not_sent", null);
      if (establishing || !failure.code) this.close("disconnect");
    } finally {
      this.releaseFrame(op);
      if (!op.admitted) { this.active.delete(op.lane); this.schedule(); }
    }
  }

  private upstreamMessage(data: unknown): void {
    if (this.closed) return;
    if (typeof data !== "string" || encoder.encode(data).byteLength > this.limits.frameBytes * 2) { this.close("disconnect", 1009); return; }
    let event: Frame;
    try { event = JSON.parse(data); } catch { this.close("disconnect", 1011); return; }
    if (!event || typeof event !== "object" || Array.isArray(event)) { this.close("disconnect", 1011); return; }
    const lane = typeof event.stream_id === "string" ? event.stream_id : "";
    const op = this.active.get(lane);
    const response = event.response && typeof event.response === "object" ? event.response as Frame : null;
    const responseId = typeof response?.id === "string" ? response.id : typeof event.response_id === "string" ? event.response_id : undefined;
    const outcome = terminalTypes.get(String(event.type));
    if (responseId && outcome && this.terminalIds.get(lane) === responseId) return;
    if (op?.sent && responseId) {
      // A late terminal from the previous turn must never bind the next turn.
      // Response ownership is established by the upstream start event only.
      const starts = event.type === "response.created" || event.type === "response.in_progress";
      if (!op.responseId && !starts) { this.close("disconnect", 1011); return; }
      if (op.responseId && op.responseId !== responseId) { this.close("disconnect", 1011); return; }
      op.responseId = responseId;
    }
    if (outcome && outcome !== "error" && (!responseId || !op?.responseId)) { this.close("disconnect", 1011); return; }
    if (op?.sent && outcome) {
      if (responseId) this.terminalIds.set(lane, responseId);
      this.options.waitUntil(this.finish(op, outcome, event));
    }
    this.forward(data);
    if (event.type === "error" && !lane && !op?.sent) this.close("disconnect");
  }

  private timeout(op: Operation): void {
    if (op.settling) return;
    op.controller.abort();
    this.error("response_timeout", "Response exceeded the router execution deadline; open a new connection.", 504, op.lane);
    // Without an upstream cancellation acknowledgement, the socket must close:
    // dispatching another same-lane create would overlap an unaccounted response.
    this.options.waitUntil(this.finish(op, op.sent ? "timeout" : "not_sent", null));
    this.close("disconnect");
  }

  private finish(op: Operation, outcome: Outcome, terminal: Frame | null): Promise<void> {
    if (op.settling) return op.settling;
    clearTimeout(op.timer);
    op.ending = outcome;
    if (!op.admitted) return Promise.resolve();
    op.settling = op.admitted.settle(outcome, terminal, op.responseId !== undefined).catch(() => {
      this.error("accounting_unavailable", "Response accounting could not finish; open a new connection.", 503, op.lane);
      this.close("disconnect");
    }).finally(() => {
      this.releaseFrame(op);
      this.active.delete(op.lane);
      this.schedule();
    });
    return op.settling;
  }

  private releaseFrame(op: Operation): void {
    if (op.frame === null) return;
    op.frame = null;
    this.bufferedBytes -= op.bytes;
    this.bufferedCount--;
  }

  private error(code: string, message: string, status: number, lane = ""): void {
    if (this.closed) return;
    this.forward(JSON.stringify({ type: "error", status, ...(lane ? { stream_id: lane } : {}), error: { type: "invalid_request_error", code, message } }));
  }

  private forward(message: string): void {
    if (this.closed) return;
    this.outputBytes += encoder.encode(message).byteLength;
    // Workers WebSocket.send has no drain promise or supported bufferedAmount.
    // A cumulative cap bounds even a peer that never reads; reconnect, never replay here.
    if (this.outputBytes > this.limits.outputBytes) {
      try { this.client.send(JSON.stringify({ type: "error", status: 400, error: { type: "invalid_request_error", code: "websocket_connection_limit_reached", message: "Router WebSocket output limit reached; open a new connection." } })); } catch { /* Peer already closed. */ }
      this.close("disconnect", 1009);
      return;
    }
    try { this.client.send(message); } catch { this.close("disconnect"); }
  }

  close(outcome: "disconnect" | "timeout" = "disconnect", code = 1000): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.connectionTimer);
    for (const queue of this.lanes.values()) {
      for (const item of queue) { this.bufferedBytes -= item.bytes; this.bufferedCount--; }
      queue.length = 0;
    }
    for (const op of this.active.values()) {
      op.controller.abort();
      this.options.waitUntil(this.finish(op, op.sent ? outcome : "not_sent", null));
    }
    try { this.upstream?.close(code, "session closed"); } catch { /* Socket already closed. */ }
    try { this.client.close(code, "session closed"); } catch { /* Socket already closed. */ }
  }
}
