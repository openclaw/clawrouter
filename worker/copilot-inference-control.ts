import { HttpError } from "./utils.ts";

export const copilotControlHeaders = {
  phase: "x-clawrouter-copilot-control-phase", id: "x-clawrouter-copilot-control-id",
  key: "x-clawrouter-copilot-control-key", source: "x-clawrouter-copilot-control-source",
} as const;
export type CopilotControlScope = Readonly<{ key: string; generation: number; lineage: string; actor: string }>;
const unavailable = () => new HttpError(503, "body_capacity_exhausted", "Original Copilot control capacity unavailable");
const conflict = () => new HttpError(409, "copilot_account_conflict", "Original Copilot account owner changed");

// One instance belongs to ONE credential owner. No module-global rendezvous,
// transferable allocation, durable permit or authority is created here.
export class CopilotInferenceControl {
  private registration?: { scope: CopilotControlScope; closed: boolean };
  private slot?: CopilotControlSlot;
  register(scope: CopilotControlScope): void {
    if (this.registration || this.slot) throw unavailable();
    this.registration = { scope: Object.freeze({ ...scope }), closed: false };
  }
  claim(id: string, key: string, remote: boolean): CopilotControlSlot {
    const registration = this.registration;
    if (!registration || registration.closed || this.slot || key !== registration.scope.key || !/^[a-f0-9]{32}$/.test(id)) throw unavailable();
    const slot = new CopilotControlSlot(id, registration.scope, remote);
    this.slot = slot;
    void slot.retired.then(() => { if (this.slot === slot) this.slot = undefined; });
    return slot;
  }
  join(id: string, key: string): CopilotControlSlot {
    const slot = this.slot;
    if (!slot || slot.id !== id || slot.scope.key !== key) throw conflict();
    slot.begin(); return slot;
  }
  claimLocal(): CopilotControlSlot {
    const slot = this.claim(crypto.randomUUID().replaceAll("-", ""), this.registration?.scope.key ?? "", false);
    slot.begin(); return slot;
  }
  retireRemote(id: string, key: string): void {
    const slot = this.slot;
    if (!slot || slot.id !== id || slot.scope.key !== key) throw conflict();
    slot.frontDone();
  }
  async close(): Promise<void> {
    const registration = this.registration;
    if (!registration) return;
    registration.closed = true; // No admission can race the retirement join.
    await this.slot?.retired;
    if (this.registration === registration) this.registration = undefined;
  }
}

export class CopilotControlSlot {
  private front: boolean;
  private readonly remote: boolean;
  private owner = false;
  private started = false;
  private reserving: boolean;
  private recordHeld = false;
  private serializing = false;
  private resolve!: () => void;
  readonly retired: Promise<void>;
  readonly id: string;
  readonly scope: CopilotControlScope;
  constructor(id: string, scope: CopilotControlScope, remote: boolean) {
    this.id = id; this.scope = scope;
    this.remote = remote; this.front = !remote; this.reserving = remote;
    this.retired = new Promise(resolve => { this.resolve = resolve; });
  }
  begin(): void { if (this.reserving || this.started || this.remote && this.front || this.owner) throw conflict(); this.started = true; }
  reserved(accepted: boolean): void {
    if (!this.reserving) throw conflict();
    this.reserving = false;
    if (!accepted || this.front && !this.started) this.owner = true;
    this.complete();
  }
  assert(scope: CopilotControlScope): void {
    if (scope.key !== this.scope.key || scope.generation !== this.scope.generation || scope.lineage !== this.scope.lineage || scope.actor !== this.scope.actor) throw conflict();
  }
  // At most one current row and its one pending storage representation, in
  // addition to the original bounded predecessor covered by the registration.
  async record<T>(run: () => Promise<T>): Promise<T> {
    if (this.recordHeld) throw unavailable();
    this.recordHeld = true;
    try { return await run(); } finally { this.recordHeld = false; this.complete(); }
  }
  async save(run: () => Promise<void>): Promise<void> {
    if (!this.recordHeld || this.serializing) throw unavailable();
    this.serializing = true;
    try { await run(); } finally { this.serializing = false; this.complete(); }
  }
  ownerDone(): void { this.owner = true; this.complete(); }
  frontDone(): void { this.front = true; if (!this.reserving && !this.started) this.owner = true; this.complete(); }
  private complete(): void { if (!this.reserving && this.front && this.owner && !this.recordHeld && !this.serializing) this.resolve(); }
}

// Validate ALL headers before constructing a copy. Only Access/CSRF and body
// framing required by this exact control protocol are forwarded.
export function assertCopilotControlHeaders(source: Headers, extra: Readonly<Record<string, string>> = {}): void {
  let count = 0, bytes = 0;
  const inspect = (name: string, value: string) => {
    if (++count > 32 || value.length > 16 * 1024) throw conflict();
    for (const text of [name, value]) for (let i = 0; i < text.length; i++) {
      const unit = text.charCodeAt(i);
      bytes += unit < 128 ? 1 : unit < 2048 ? 2 : unit >= 0xd800 && unit <= 0xdbff && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff ? (i++, 4) : 3;
      if (bytes > 32 * 1024) throw conflict();
    }
  };
  for (const [name, value] of source) inspect(name, value);
  for (const [name, value] of Object.entries(extra)) {
    if (!(Object.values(copilotControlHeaders) as string[]).includes(name)) throw conflict();
    inspect(name, value);
  }
}

export function qualifiedCopilotControlHeaders(source: Headers, extra: Readonly<Record<string, string>> = {}): Headers {
  assertCopilotControlHeaders(source, extra);
  const headers = new Headers();
  for (const name of ["cf-access-jwt-assertion", "origin", "sec-fetch-site", "x-forwarded-host", "x-forwarded-proto", "content-type", "content-length", "content-encoding"]) {
    const value = source.get(name); if (value !== null) headers.set(name, value);
  }
  for (const [name, value] of Object.entries(extra)) headers.set(name, value);
  return headers;
}

// This acknowledgment waits only for its OWN participants, never for inference
// allocation retirement (which itself joins this reply). No dependency cycle.
export function copilotControlReply(value: unknown, status: number, release: () => Promise<void>): Response {
  let bytes: Uint8Array | undefined = new TextEncoder().encode(JSON.stringify(value));
  if (bytes.length > 2048) throw conflict();
  let ending: Promise<void> | undefined;
  const finish = () => ending ??= release();
  return new Response(new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (bytes) { const part = bytes; bytes = undefined; controller.enqueue(part); }
      else { controller.close(); await finish(); }
    },
    async cancel() { bytes = undefined; await finish(); },
  }, { highWaterMark: 0 }), { status, headers: { "content-type": "application/json", "cache-control": "private, no-store" } });
}
