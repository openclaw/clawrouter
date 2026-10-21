import { REALTIME, audio, cap, effectiveSession, fail, fields, identity, object, sessionPolicy, type Json } from './realtime-protocol';

export interface FundedTurn { settle(terminal: Json | null, sent: boolean, rejected: boolean, responseId: string | null): Promise<void> }
export interface RealtimeSessionOptions {
  waitUntil(promise: Promise<unknown>): void;
  guard(): Promise<void>;
  fund(unitId: string, outputCap: number, signal: AbortSignal): Promise<FundedTurn>;
  expiresAt?: number;
  // Timing injection for deterministic private tests, never an environment knob.
  timing?: { idleMs?: number; durationMs?: number; guardMs?: number };
}
interface Active { unit: string; event: string; outputCap: number; response: string | null; funded?: FundedTurn; sent: boolean; settled: boolean }

// One ordered queue across both directions. Close is synchronous and aborts
// admission immediately; cleanup waits for already-owned reserve/settle work.
export class RealtimeSession {
  private tail = Promise.resolve();
  private count = 0; private queuedBytes = 0; private eventCount = 0;
  private inputBytes = 0; private outputBytes = 0; private bufferBytes = 0;
  private closed = false; private firstCause: string | null = null;
  private active?: Active; private policy?: Json; private pendingPolicy?: Json;
  private commitPending = false; private commitReady = false;
  private turns = 0; private guardPending = false; private conversation: string | null = null;
  private ids = new Set<string>(); private terminals = new Map<string, string>();
  // Cumulative decoded bytes, not fractional milliseconds: chunk boundaries
  // must not round an exact native integer-ms truncation out of range.
  private items = new Map<string, number>(); private deleted = new Set<string>();
  private deletePending = new Set<string>(); private deleteAcknowledged = new Set<string>();
  private abort = new AbortController();
  private idle: ReturnType<typeof setTimeout>;
  private duration: ReturnType<typeof setTimeout>;
  private guardTimer: ReturnType<typeof setInterval>;
  private expiry?: ReturnType<typeof setTimeout>;

  private client: WebSocket; private upstream: WebSocket; private options: RealtimeSessionOptions;
  constructor(client: WebSocket, upstream: WebSocket, options: RealtimeSessionOptions) {
    this.client = client; this.upstream = upstream; this.options = options;
    client.addEventListener('message', e => this.enqueue(e.data, false));
    upstream.addEventListener('message', e => this.enqueue(e.data, true));
    client.addEventListener('close', () => this.close('client_disconnect'));
    client.addEventListener('error', () => this.close('client_disconnect'));
    upstream.addEventListener('close', () => this.close('upstream_disconnect'));
    upstream.addEventListener('error', () => this.close('upstream_disconnect'));
    this.idle = setTimeout(() => this.close('idle_limit'), options.timing?.idleMs ?? REALTIME.idleMs);
    this.duration = setTimeout(() => this.close('duration_limit'), options.timing?.durationMs ?? REALTIME.durationMs);
    this.guardTimer = setInterval(() => {
      if (this.closed || this.guardPending) return;
      this.guardPending = true;
      // Deadline does not depend on the serial queue or a stuck authority call.
      const timer = setTimeout(() => this.close('authority_timeout'), options.timing?.guardMs ?? REALTIME.guardMs);
      options.waitUntil(options.guard().catch(() => this.close('authority_revoked')).finally(() => { clearTimeout(timer); this.guardPending = false; }));
    }, options.timing?.guardMs ?? REALTIME.guardMs);
    if (options.expiresAt !== undefined) this.expiry = setTimeout(() => this.close('credential_expired'), Math.max(0, options.expiresAt - Date.now()));
  }

  private enqueue(data: unknown, server: boolean): void {
    if (this.closed) return;
    if (typeof data !== 'string' || data.length > REALTIME.frame) { this.close('frame_limit'); return; }
    const bytes = new TextEncoder().encode(data).length;
    if (bytes > REALTIME.frame || ++this.eventCount > REALTIME.events || ++this.count > REALTIME.queue || (this.queuedBytes += bytes) > REALTIME.queueBytes) { this.close('queue_limit'); return; }
    if (server && (this.outputBytes += bytes) > REALTIME.outputBytes || !server && (this.inputBytes += bytes) > REALTIME.inputBytes) { this.close('aggregate_limit'); return; }
    clearTimeout(this.idle); this.idle = setTimeout(() => this.close('idle_limit'), this.options.timing?.idleMs ?? REALTIME.idleMs);
    const work = this.tail.then(async () => {
      if (this.closed) return;
      const event = object(JSON.parse(data));
      if (typeof event.type !== 'string') fail('event_type');
      if (server) await this.server(event, data); else await this.ingress(event);
    }).catch(error => this.close(typeof error?.code === 'string' ? error.code : 'protocol_error')).finally(() => { this.count--; this.queuedBytes -= bytes; });
    this.tail = work; this.options.waitUntil(work);
  }

  private send(socket: WebSocket, value: Json): void {
    if (this.closed) return;
    socket.send(JSON.stringify(value));
  }
  private own(id: string): void {
    if (this.ids.has(id) || this.ids.size >= REALTIME.identities) fail('identity_limit');
    this.ids.add(id);
  }
  private item(id: unknown, server = false): string {
    const key = identity(id);
    if (this.deleted.has(key) || !server && this.deletePending.has(key) || !this.items.has(key)) fail('unknown_item');
    return key;
  }

  private async ingress(e: Json): Promise<void> {
    const allowed: Record<string, string[]> = {
      'session.update': ['session'], 'input_audio_buffer.append': ['audio'],
      'input_audio_buffer.commit': [], 'input_audio_buffer.clear': [],
      'conversation.item.create': ['item'], 'response.create': ['response'],
      'response.cancel': ['response_id'], 'conversation.item.truncate': ['item_id', 'content_index', 'audio_end_ms'],
      'conversation.item.delete': ['item_id'],
    };
    if (!Object.hasOwn(allowed, e.type)) fail('event_unsupported');
    fields(e, ['type', 'event_id', ...allowed[e.type]]);
    const eventId = e.event_id === undefined ? crypto.randomUUID() : identity(e.event_id); this.own(eventId);
    if (e.type === 'session.update') {
      if (this.pendingPolicy || this.active || this.bufferBytes || this.commitPending || this.commitReady) fail('session_busy');
      const policy = sessionPolicy(e.session);
      if (this.policy && (JSON.stringify(policy.audio) !== JSON.stringify(this.policy.audio))) fail('session_pinned');
      await this.options.guard(); if (this.closed) return;
      this.pendingPolicy = policy; this.send(this.upstream, { type: e.type, event_id: eventId, session: policy }); return;
    }
    if (!this.policy || this.pendingPolicy) fail('session_not_ready');
    switch (e.type) {
      case 'input_audio_buffer.append': {
        if (this.active || this.commitPending || this.commitReady) fail('turn_busy');
        this.bufferBytes += audio(e.audio, this.policy.audio.input.format);
        if (this.bufferBytes > 960_000) fail('audio_buffer_limit');
        this.send(this.upstream, { type: e.type, event_id: eventId, audio: e.audio }); return;
      }
      case 'input_audio_buffer.commit':
        if (this.active || this.commitPending || this.commitReady || this.bufferBytes < (this.policy.audio.input.format.type === 'audio/pcm' ? 4800 : 800)) fail('commit');
        this.commitPending = true; this.send(this.upstream, { type: e.type, event_id: eventId }); return;
      case 'input_audio_buffer.clear':
        if (this.commitPending || this.commitReady) fail('commit_pending');
        this.bufferBytes = 0; this.send(this.upstream, { type: e.type, event_id: eventId }); return;
      case 'conversation.item.create': {
        if (this.active) fail('turn_busy');
        const item = object(e.item); fields(item, ['id', 'type', 'role', 'content']);
        if (item.type !== 'message' || item.role !== 'user' || !Array.isArray(item.content) || item.content.length !== 1) fail('item');
        const c = object(item.content[0]); fields(c, ['type', 'text']);
        if (c.type !== 'input_text' || typeof c.text !== 'string' || !c.text.length || c.text.length > 8192) fail('item');
        const id = item.id === undefined ? crypto.randomUUID() : identity(item.id); this.own(id);
        this.send(this.upstream, { type: e.type, event_id: eventId, item: { ...item, id } }); return;
      }
      case 'response.create': {
        if (this.active || this.commitPending || this.bufferBytes) fail('turn_busy');
        if (++this.turns > REALTIME.turns) fail('turn_limit');
        const r = e.response === undefined ? {} : object(e.response); fields(r, ['max_output_tokens', 'output_modalities']);
        if (r.output_modalities !== undefined && JSON.stringify(r.output_modalities) !== '["audio"]') fail('modality');
        const outputCap = cap(r.max_output_tokens ?? this.policy.max_output_tokens);
        if (outputCap > this.policy.max_output_tokens) fail('output_limit');
        const a: Active = { unit: crypto.randomUUID(), event: eventId, outputCap, response: null, sent: false, settled: false }; this.active = a;
        a.funded = await this.options.fund(a.unit, outputCap, this.abort.signal);
        if (this.closed) { await this.settle(a, null, false); return; }
        // A throwing send is delivery-uncertain, not proof of free execution.
        a.sent = true;
        this.send(this.upstream, { type: e.type, event_id: eventId, response: { output_modalities: ['audio'], max_output_tokens: outputCap, metadata: { clawrouter_unit: a.unit } } });
        this.commitReady = false; return;
      }
      case 'response.cancel':
        if (!this.active?.sent || e.response_id !== undefined && e.response_id !== this.active.response) fail('unknown_response');
        this.send(this.upstream, { type: e.type, event_id: eventId, ...(this.active.response ? { response_id: this.active.response } : {}) }); return;
      case 'conversation.item.truncate': {
        const id = this.item(e.item_id), maxBytes = this.items.get(id)!;
        const bytesPerMs = this.policy.audio.output.format.type === 'audio/pcm' ? 48 : 8;
        if (e.content_index !== 0 || !Number.isSafeInteger(e.audio_end_ms) || e.audio_end_ms < 0 || e.audio_end_ms * bytesPerMs > maxBytes) fail('truncate');
        this.send(this.upstream, { type: e.type, event_id: eventId, item_id: id, content_index: 0, audio_end_ms: e.audio_end_ms }); return;
      }
      case 'conversation.item.delete': {
        const id = this.item(e.item_id); this.deletePending.add(id);
        this.send(this.upstream, { type: e.type, event_id: eventId, item_id: id }); return;
      }
      default: fail('event_unsupported');
    }
  }

  private async server(e: Json, raw: string): Promise<void> {
    if (e.type === 'session.created') {
      // The initial vendor defaults are not effective permission to send media.
      this.send(this.client, e); return;
    }
    if (e.type === 'conversation.created') {
      const id = identity(object(e.conversation).id);
      if (this.conversation !== null) fail('duplicate_conversation');
      this.conversation = id; this.send(this.client, e); return;
    }
    if (e.type === 'session.updated') {
      if (!this.pendingPolicy || !effectiveSession(e.session, this.pendingPolicy)) fail('unsafe_ack');
      this.policy = this.pendingPolicy; this.pendingPolicy = undefined; this.send(this.client, e); return;
    }
    if (e.type === 'input_audio_buffer.committed') {
      if (!this.commitPending) fail('unsolicited_commit');
      this.commitPending = false; this.commitReady = true; this.bufferBytes = 0;
      this.addItem(e.item_id); this.send(this.client, e); return;
    }
    if (e.type === 'input_audio_buffer.cleared') { this.send(this.client, e); return; }
    if (e.type === 'error') {
      // Only a correlated invalid create rejected before response.created proves
      // nonexecution. Never attach a global error to an arbitrary funded turn.
      const a = this.active, err = object(e.error);
      if (a?.sent && !a.response && err.event_id === a.event && err.type === 'invalid_request_error' && ['invalid_value', 'invalid_type', 'unknown_parameter', 'missing_required_parameter'].includes(err.code)) {
        await this.settle(a, null, true); this.active = undefined; this.retireDeleted(); this.send(this.client, e); return;
      }
      this.close('upstream_error'); return;
    }
    if (e.type === 'response.done') {
      const response = object(e.response), id = identity(response.id);
      const fingerprint = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
      const hash = [...new Uint8Array(fingerprint)].map(x => x.toString(16).padStart(2, '0')).join('');
      if (this.terminals.has(id)) { if (this.terminals.get(id) !== hash) fail('conflicting_terminal'); return; }
      const a = this.active; if (!a || a.response !== id) fail('unknown_terminal');
      if (!['completed', 'cancelled', 'failed', 'incomplete'].includes(response.status)) fail('terminal_status');
      if (this.terminals.size >= REALTIME.turns) fail('terminal_limit');
      // Keep only bounded identity + hash, never terminal transcripts in history.
      this.terminals.set(id, hash);
      await this.settle(a, e, false); this.active = undefined; this.retireDeleted(); this.send(this.client, e); return;
    }
    if (e.type === 'response.created') {
      const a = this.active, r = object(e.response);
      if (!a?.sent || a.response || r.metadata?.clawrouter_unit !== a.unit) fail('unsolicited_response');
      const id = identity(r.id); if (this.terminals.has(id)) fail('reused_response'); a.response = id; this.send(this.client, e); return;
    }
    if (e.type.startsWith('response.')) {
      const a = this.active; if (!a?.response || e.response_id !== a.response) fail('unknown_response');
      const allowed = ['response.output_item.added', 'response.output_item.done', 'response.content_part.added', 'response.content_part.done', 'response.output_audio.delta', 'response.output_audio.done', 'response.output_audio_transcript.delta', 'response.output_audio_transcript.done'];
      if (!allowed.includes(e.type)) fail('upstream_event_unsupported');
      if (e.item) { if (e.item.type !== 'message' || e.item.role !== 'assistant') fail('upstream_item'); this.addItem(e.item.id); }
      if (e.type === 'response.output_audio.delta') {
        const id = this.item(e.item_id, true);
        const n = audio(e.delta, this.policy!.audio.output.format);
        this.items.set(id, this.items.get(id)! + n);
      }
      this.send(this.client, e); return;
    }
    if (['conversation.item.created', 'conversation.item.added', 'conversation.item.done'].includes(e.type)) {
      if (!['message'].includes(e.item?.type)) fail('upstream_item'); this.addItem(e.item.id); this.send(this.client, e); return;
    }
    if (e.type === 'conversation.item.deleted') {
      const id = identity(e.item_id); if (!this.deletePending.has(id)) fail('unsolicited_delete');
      this.deleteAcknowledged.add(id); if (!this.active) this.retireDeleted();
      this.send(this.client, e); return;
    }
    if (e.type === 'conversation.item.truncated') { this.item(e.item_id, true); this.send(this.client, e); return; }
    if (e.type === 'rate_limits.updated') { this.send(this.client, e); return; }
    fail('upstream_event_unsupported');
  }

  private retireDeleted(): void {
    // The delete ACK can race already-generated audio/item.done. Keep the
    // tombstone pending until response.done so terminal usage still settles.
    for (const id of this.deleteAcknowledged) { this.deleted.add(id); this.deletePending.delete(id); }
    this.deleteAcknowledged.clear();
  }
  private addItem(value: unknown): void {
    const id = identity(value); if (this.deleted.has(id)) fail('deleted_item');
    if (!this.items.has(id)) { if (this.items.size >= REALTIME.identities) fail('item_limit'); this.items.set(id, 0); }
  }
  private async settle(a: Active, terminal: Json | null, rejected: boolean): Promise<void> {
    if (!a.funded || a.settled) return; a.settled = true;
    await a.funded.settle(terminal, a.sent, rejected, a.response);
  }
  close(cause: string): void {
    if (this.closed) return; this.closed = true; this.firstCause = cause;
    this.abort.abort(); clearTimeout(this.idle); clearTimeout(this.duration); clearInterval(this.guardTimer); if (this.expiry) clearTimeout(this.expiry);
    try { this.client.send(JSON.stringify({ type: 'error', error: { type: 'clawrouter_error', code: this.firstCause, message: 'Realtime session closed; open a fresh session. No replay was attempted.' } })); } catch { /* Peer already closed. */ }
    for (const socket of [this.client, this.upstream]) { try { socket.close(1008, 'Realtime session closed'); } catch { /* Once-only retirement. */ } }
    const finish = this.tail.then(async () => { if (this.active) await this.settle(this.active, null, false); }).catch(() => undefined);
    this.options.waitUntil(finish);
  }
}
