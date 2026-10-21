import { HttpError } from './utils';
import type { FundedInput } from './realtime-accounting';
import { REALTIME, audio, cap, effectiveSession, fail, fields, identity, object, sessionPolicy, toolChoice, vadPolicy, wireSession, type Json } from './realtime-protocol';

export interface FundedTurn { settle(terminal: Json | null, sent: boolean, rejected: boolean, responseId: string | null): Promise<void> }
export interface RealtimeSessionOptions {
  waitUntil(promise: Promise<unknown>): void;
  guard(): Promise<void>;
  fund(unitId: string, outputCap: number, signal: AbortSignal): Promise<FundedTurn>;
  allowTranscription?: boolean;
  guardInput?(observeBudget?: boolean): Promise<void>;
  guardMedia?(input: boolean, continuing: boolean): Promise<void>;
  fundInput?(unitId: string, signal: AbortSignal): Promise<FundedInput>;
  expiresAt?: number;
  // Timing injection for deterministic private tests, never an environment knob.
  timing?: { idleMs?: number; durationMs?: number; guardMs?: number };
}
interface Active { unit: string; event: string; outputCap: number; response: string | null; funded?: FundedTurn; sent: boolean; settled: boolean; cancelSent?: boolean }

// One ordered queue across both directions. Close is synchronous and aborts
// admission immediately; cleanup waits for already-owned reserve/settle work.
export class RealtimeSession {
  private tail = Promise.resolve();
  private count = 0; private queuedBytes = 0; private eventCount = 0;
  private inputBytes = 0; private outputBytes = 0; private bufferBytes = 0;
  private forwardedBytes = 0; private consumedBytes = 0;
  private closed = false; private firstCause: string | null = null;
  private active?: Active; private policy?: Json; private pendingPolicy?: Json;
  private inputBuffer?: { unit: FundedInput; sent: boolean };
  private inputUnits = new Map<string, FundedInput>();
  private inputTerminals = new Map<string, string>();
  private speech: { id: string; start: number; end: number | null } | null = null;
  private cancellations = new Map<string, { client: boolean; acknowledged: boolean }>();
  private autoPending = 0;
  private calls = new Map<string, { item: string; name: string; response: string; completed: boolean; returned: boolean }>();
  private commitPending = false; private commitReady = false; private clearPending = false;
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
    const eventId = e.event_id === undefined ? crypto.randomUUID() : identity(e.event_id);
    // Media chunks have no replay/control identity in the native sender. Do
    // not retain a random UUID per 20ms chunk and exhaust the item/control cap.
    if (e.type !== 'input_audio_buffer.append') this.own(eventId);
    if (e.type === 'session.update') {
      const patch = object(e.session);
      // Native bridge toggles only auto-response flags around manual/tool
      // continuation. The vendor wire flags are already false, so this local
      // transition needs no vendor round trip and cannot race a second ACK.
      if (this.policy && Object.keys(patch).every(k => ['type', 'audio'].includes(k)) && patch.type === 'realtime') {
        fields(object(patch.audio), ['input']); fields(object(patch.audio.input), ['turn_detection']);
        if (this.pendingPolicy) fail('session_busy');
        const old = this.policy.audio.input.turn_detection;
        const next = vadPolicy({ ...old, ...object(patch.audio.input.turn_detection) });
        if (!old || !next || ['type', 'threshold', 'prefix_padding_ms', 'silence_duration_ms'].some(k => next[k] !== old[k])) fail('session_pinned');
        await this.options.guard(); if (this.closed) return;
        this.policy.audio.input.turn_detection = next;
        this.send(this.client, { type: 'session.updated', session: this.policy }); return;
      }
      if (this.pendingPolicy || this.active || this.bufferBytes || this.commitPending || this.commitReady || this.clearPending || this.inputUnits.size) fail('session_busy');
      const policy = sessionPolicy(e.session);
      if (policy.audio.input.transcription && (!this.options.allowTranscription || !this.options.fundInput)) throw new HttpError(400, 'pricing_required', 'Input transcription has no qualified hard-budget envelope; select an explicit soft policy');
      if (this.policy && JSON.stringify(policy.audio) !== JSON.stringify(this.policy.audio)) fail('session_pinned');
      if (policy.audio.input.transcription) await this.options.guardInput?.();
      await this.options.guard(); if (this.closed) return;
      this.pendingPolicy = policy; this.send(this.upstream, { type: e.type, event_id: eventId, session: wireSession(policy) }); return;
    }
    if (!this.policy || this.pendingPolicy) fail('session_not_ready');
    switch (e.type) {
      case 'input_audio_buffer.append': {
        if ((!this.policy.audio.input.turn_detection && (this.active || this.commitReady)) || this.commitPending || this.clearPending) fail('turn_busy');
        const bytes = audio(e.audio, this.policy.audio.input.format);
        // ASR is billable at automatic commit, not at response.create. Admit
        // its independent soft unit BEFORE the first byte can leave this owner.
        const input = !!this.policy.audio.input.transcription;
        if (this.options.guardMedia) await this.options.guardMedia(input, !!this.inputBuffer);
        else {
          if (input) await this.options.guardInput?.(!!this.inputBuffer);
          await this.options.guard();
        }
        if (this.closed) return;
        if (this.policy.audio.input.transcription && !this.inputBuffer) {
          const unit = await this.options.fundInput!(crypto.randomUUID(), this.abort.signal);
          this.inputBuffer = { unit, sent: false };
          // Own the receipt before rechecking authority after the funding await.
          // Failure/close retires this unsent unit exactly once on the tail.
          if (this.closed) return;
          await this.options.guard(); if (this.closed) return;
        }
        this.forwardedBytes += bytes; this.bufferBytes = this.forwardedBytes - this.consumedBytes;
        if (this.bufferBytes > 960_000) fail('audio_buffer_limit');
        if (this.inputBuffer) this.inputBuffer.sent = true;
        this.send(this.upstream, { type: e.type, event_id: eventId, audio: e.audio }); return;
      }
      case 'input_audio_buffer.commit':
        if (this.active || this.commitPending || this.commitReady || this.clearPending || this.bufferBytes < (this.policy.audio.input.format.type === 'audio/pcm' ? 4800 : 800)) fail('commit');
        this.commitPending = true; this.send(this.upstream, { type: e.type, event_id: eventId }); return;
      case 'input_audio_buffer.clear':
        if (this.commitPending || this.commitReady || this.clearPending) fail('commit_pending');
        this.clearPending = true; this.send(this.upstream, { type: e.type, event_id: eventId }); return;
      case 'conversation.item.create': {
        if (this.active) fail('turn_busy');
        const item = object(e.item);
        const id = item.id === undefined ? crypto.randomUUID() : identity(item.id); this.own(id);
        if (item.type === 'function_call_output') {
          fields(item, ['id', 'type', 'call_id', 'output']);
          const call = this.calls.get(identity(item.call_id));
          if (!call?.completed || call.returned || typeof item.output !== 'string' || item.output.length > 32768) fail('tool_result');
          await this.options.guard(); if (this.closed) return;
          call.returned = true;
        } else {
          fields(item, ['id', 'type', 'role', 'content']);
          if (item.type !== 'message' || item.role !== 'user' || !Array.isArray(item.content) || item.content.length !== 1) fail('item');
          const c = object(item.content[0]); fields(c, ['type', 'text']);
          if (c.type !== 'input_text' || typeof c.text !== 'string' || !c.text.length || c.text.length > 8192) fail('item');
        }
        this.send(this.upstream, { type: e.type, event_id: eventId, item: { ...item, id } }); return;
      }
      case 'response.create': {
        // Server VAD owns the next input buffer independently of the committed
        // conversation. Trailing media must not block a manual response or its
        // tool continuation, even after createResponse clears commitReady.
        // No-VAD input still requires an explicit commit before a response.
        if (this.active || this.autoPending || this.commitPending || this.clearPending || this.bufferBytes && !this.policy.audio.input.turn_detection) fail('turn_busy');
        await this.createResponse(eventId, e.response); return;
      }
      case 'response.cancel':
        if (!this.active?.sent) {
          this.send(this.client, { type: 'error', error: { type: 'invalid_request_error', code: 'response_cancel_not_active', event_id: eventId, message: 'Cancellation failed: no active response found' } }); return;
        }
        if (e.response_id !== undefined && e.response_id !== this.active.response) fail('unknown_response');
        this.cancelResponse(eventId, true); return;
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

  private cancelResponse(eventId: string = crypto.randomUUID(), client = false): void {
    const a = this.active;
    if (!a?.sent || a.cancelSent) return;
    if (this.cancellations.size >= REALTIME.turns) fail('turn_limit');
    this.cancellations.set(eventId, { client, acknowledged: false }); a.cancelSent = true;
    this.send(this.upstream, { type: 'response.cancel', event_id: eventId, ...(a.response ? { response_id: a.response } : {}) });
  }
  private async createResponse(eventId: string, value?: unknown): Promise<void> {
    if (++this.turns > REALTIME.turns) fail('turn_limit');
    const r = value === undefined ? {} : object(value); fields(r, ['max_output_tokens', 'output_modalities', 'tool_choice']);
    if (r.output_modalities !== undefined && JSON.stringify(r.output_modalities) !== '["audio"]') fail('modality');
    const outputCap = cap(r.max_output_tokens ?? this.policy!.max_output_tokens);
    if (outputCap > this.policy!.max_output_tokens) fail('output_limit');
    const choice = r.tool_choice === undefined ? undefined : toolChoice(r.tool_choice, this.policy!.tools);
    const a: Active = { unit: crypto.randomUUID(), event: eventId, outputCap, response: null, sent: false, settled: false }; this.active = a;
    a.funded = await this.options.fund(a.unit, outputCap, this.abort.signal);
    if (this.closed) { await this.settle(a, null, false); return; }
    await this.options.guard(); if (this.closed) return;
    a.sent = true;
    this.send(this.upstream, { type: 'response.create', event_id: eventId, response: { output_modalities: ['audio'], max_output_tokens: outputCap, ...(choice === undefined ? {} : { tool_choice: choice }), metadata: { clawrouter_unit: a.unit } } });
    this.commitReady = false;
  }
  private async automaticResponse(): Promise<void> {
    if (this.closed || this.active || !this.autoPending) return;
    this.autoPending--; await this.createResponse(crypto.randomUUID());
  }
  private functionItem(item: Json, response: string): void {
    if (item.type !== 'function_call' || !this.policy!.tools.some((t: Json) => t.name === item.name)) fail('upstream_item');
    const id = identity(item.id), callId = identity(item.call_id), prior = this.calls.get(callId);
    if (prior && (prior.item !== id || prior.name !== item.name || prior.response !== response)) fail('tool_identity');
    if (!prior) {
      if (this.calls.size >= REALTIME.turns || this.items.has(id)) fail('tool_identity');
      this.calls.set(callId, { item: id, name: item.name, response, completed: false, returned: false });
    }
    this.addItem(id);
  }
  private async digest(raw: string): Promise<string> {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
    return [...new Uint8Array(bytes)].map(x => x.toString(16).padStart(2, '0')).join('');
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
      // Validate the disabled vendor authority, then ACK the logical proxy-owned
      // behavior. Clients must not mistake wire funding controls for their policy.
      this.policy = this.pendingPolicy; this.pendingPolicy = undefined;
      this.send(this.client, { ...e, session: { ...e.session, ...this.policy } }); return;
    }
    if (e.type === 'input_audio_buffer.speech_started' || e.type === 'input_audio_buffer.speech_stopped') {
      if (!this.policy?.audio.input.turn_detection || !this.bufferBytes) fail('unsolicited_vad');
      const id = identity(e.item_id);
      if (e.type.endsWith('speech_started')) {
        if (this.speech || !Number.isSafeInteger(e.audio_start_ms) || e.audio_start_ms < 0 || e.audio_start_ms > Math.ceil(this.forwardedBytes / this.inputBytesPerMs()) || this.items.has(id)) fail('vad_order');
        this.speech = { id, start: e.audio_start_ms, end: null };
        if (this.policy.audio.input.turn_detection.interrupt_response) this.cancelResponse();
      } else {
        if (!this.speech || this.speech.id !== id || this.speech.end !== null || !Number.isSafeInteger(e.audio_end_ms) || e.audio_end_ms < this.speech.start || e.audio_end_ms > Math.ceil(this.forwardedBytes / this.inputBytesPerMs()) || e.audio_end_ms * this.inputBytesPerMs() <= this.consumedBytes) fail('vad_order');
        this.speech.end = e.audio_end_ms;
      }
      this.send(this.client, e); return;
    }
    if (e.type === 'input_audio_buffer.committed') {
      const automatic = this.policy?.audio.input.turn_detection, explicit = this.commitPending;
      if (!explicit && (!automatic || this.speech?.end == null || this.speech.id !== e.item_id)) fail('unsolicited_commit');
      const id = identity(e.item_id); if (this.items.has(id)) fail('reused_item');
      // VAD offsets are session audio time, not ACK receipt time. A delayed
      // commit must not consume media already forwarded for a later utterance.
      // Permit at most the sub-ms codec rounding at the end of sent audio.
      this.consumedBytes = explicit ? this.forwardedBytes : Math.min(this.forwardedBytes, this.speech!.end! * this.inputBytesPerMs());
      this.bufferBytes = this.forwardedBytes - this.consumedBytes;
      if (this.inputBuffer) {
        const { unit } = this.inputBuffer; this.inputUnits.set(id, unit);
        // This is a child receipt for ALREADY admitted soft media, not a new
        // post-execution admission and never a hard reservation or free refund.
        this.inputBuffer = this.bufferBytes ? { unit: unit.fork(), sent: true } : undefined;
      }
      this.speech = null; this.commitPending = false; this.commitReady = true;
      this.addItem(id); this.send(this.client, e);
      if (!explicit && automatic?.create_response) { if (++this.autoPending > REALTIME.turns) fail('turn_limit'); await this.automaticResponse(); }
      return;
    }
    if (e.type.startsWith('conversation.item.input_audio_transcription.')) {
      if (!this.policy?.audio.input.transcription || e.content_index !== 0) fail('unsolicited_transcription');
      const id = identity(e.item_id), suffix = e.type.slice('conversation.item.input_audio_transcription.'.length);
      if (!['delta', 'completed', 'failed'].includes(suffix)) fail('upstream_event_unsupported');
      const unit = this.inputUnits.get(id);
      if (suffix === 'delta') { if (!unit || typeof e.delta !== 'string') fail('unknown_transcription'); this.send(this.client, e); return; }
      const hash = await this.digest(raw), prior = this.inputTerminals.get(id);
      if (prior) { if (prior !== hash) fail('conflicting_transcription'); return; }
      if (!unit) fail('unknown_transcription');
      this.inputTerminals.set(id, hash); await unit.settle(e, true, id); this.inputUnits.delete(id);
      this.send(this.client, e); return;
    }
    if (e.type === 'input_audio_buffer.cleared') {
      // Clear owns its acknowledgement: never retire a later buffer using an
      // unsolicited or delayed ACK. New media waits for this unit to retire.
      if (!this.clearPending) fail('unsolicited_clear');
      this.clearPending = false; this.consumedBytes = this.forwardedBytes; this.bufferBytes = 0;
      if (this.inputBuffer) { await this.inputBuffer.unit.settle(null, this.inputBuffer.sent, null); this.inputBuffer = undefined; }
      this.speech = null; this.send(this.client, e); return;
    }
    if (e.type === 'error') {
      // Only a correlated invalid create rejected before response.created proves
      // nonexecution. Never attach a global error to an arbitrary funded turn.
      const a = this.active, err = object(e.error);
      const cancellation = this.cancellations.get(err.event_id);
      // A late no-active error answers only its exact cancel request, never
      // the response currently executing. Unknown correlations still close.
      if (cancellation && err.type === 'invalid_request_error' && err.code === 'response_cancel_not_active') {
        if (cancellation.client && !cancellation.acknowledged) this.send(this.client, e);
        cancellation.acknowledged = true; return;
      }
      if (a?.sent && !a.response && err.event_id === a.event && err.type === 'invalid_request_error' && ['invalid_value', 'invalid_type', 'unknown_parameter', 'missing_required_parameter'].includes(err.code)) {
        await this.settle(a, null, true); this.active = undefined; this.retireDeleted(); this.send(this.client, e); await this.automaticResponse(); return;
      }
      this.close('upstream_error'); return;
    }
    if (e.type === 'response.done') {
      const response = object(e.response), id = identity(response.id);
      const hash = await this.digest(raw);
      if (this.terminals.has(id)) { if (this.terminals.get(id) !== hash) fail('conflicting_terminal'); return; }
      const a = this.active; if (!a || a.response !== id) fail('unknown_terminal');
      if (!['completed', 'cancelled', 'failed', 'incomplete'].includes(response.status)) fail('terminal_status');
      if (this.terminals.size >= REALTIME.turns) fail('terminal_limit');
      // Provisional function argument events are not execution authority. Only
      // a successful terminal of the owned response authorizes a tool result.
      if (response.output !== undefined) {
        if (!Array.isArray(response.output) || response.output.length > 32) fail('terminal_output');
        for (const item of response.output) {
          if (item.type === 'function_call') {
            this.functionItem(object(item), id);
            if (typeof item.arguments !== 'string' || item.arguments.length > 32768) fail('tool_arguments');
            if (response.status === 'completed' && [undefined, 'completed'].includes(item.status)) this.calls.get(item.call_id)!.completed = true;
          } else if (item.type !== 'message' || item.role !== 'assistant') fail('terminal_output');
        }
      }
      // Keep only bounded identity + hash, never terminal transcripts in history.
      this.terminals.set(id, hash);
      await this.settle(a, e, false); this.active = undefined; this.retireDeleted(); this.send(this.client, e); await this.automaticResponse(); return;
    }
    if (e.type === 'response.created') {
      const a = this.active, r = object(e.response);
      if (!a?.sent || a.response || r.metadata?.clawrouter_unit !== a.unit) fail('unsolicited_response');
      const id = identity(r.id); if (this.terminals.has(id)) fail('reused_response'); a.response = id; this.send(this.client, e); return;
    }
    if (e.type.startsWith('response.')) {
      const a = this.active; if (!a?.response || e.response_id !== a.response) fail('unknown_response');
      const allowed = ['response.output_item.added', 'response.output_item.done', 'response.content_part.added', 'response.content_part.done', 'response.output_audio.delta', 'response.output_audio.done', 'response.output_audio_transcript.delta', 'response.output_audio_transcript.done', 'response.function_call_arguments.delta', 'response.function_call_arguments.done'];
      if (!allowed.includes(e.type)) fail('upstream_event_unsupported');
      if (e.item) {
        if (e.item.type === 'function_call') this.functionItem(object(e.item), a.response);
        else { if (e.item.type !== 'message' || e.item.role !== 'assistant') fail('upstream_item'); this.addItem(e.item.id); }
      }
      if (e.type.startsWith('response.function_call_arguments.')) {
        const call = this.calls.get(identity(e.call_id));
        if (!call || call.item !== e.item_id || call.response !== a.response || typeof (e.delta ?? e.arguments) !== 'string') fail('tool_identity');
      }
      if (e.type === 'response.output_audio.delta') {
        const id = this.item(e.item_id, true);
        const n = audio(e.delta, this.policy!.audio.output.format);
        this.items.set(id, this.items.get(id)! + n);
      }
      this.send(this.client, e); return;
    }
    if (['conversation.item.created', 'conversation.item.added', 'conversation.item.done'].includes(e.type)) {
      const item = object(e.item);
      if (item.type === 'function_call') { if (!this.active?.response) fail('unknown_response'); this.functionItem(item, this.active.response); }
      else if (item.type === 'function_call_output') { const call = this.calls.get(identity(item.call_id)); if (!call?.returned) fail('tool_result'); this.addItem(item.id); }
      else { if (item.type !== 'message' || !['user', 'assistant'].includes(item.role)) fail('upstream_item'); this.addItem(item.id); }
      this.send(this.client, e); return;
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

  private inputBytesPerMs(): number { return this.policy!.audio.input.format.type === 'audio/pcm' ? 48 : 8; }
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
    const finish = this.tail.then(async () => {
      const cleanup: Promise<unknown>[] = [...this.inputUnits].map(([id, unit]) => unit.settle(null, true, id));
      if (this.inputBuffer) cleanup.push(this.inputBuffer.unit.settle(null, this.inputBuffer.sent, null));
      if (this.active) cleanup.push(this.settle(this.active, null, false));
      await Promise.all(cleanup);
    }).catch(() => undefined);
    this.options.waitUntil(finish);
  }
}
