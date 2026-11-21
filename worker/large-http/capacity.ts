// Capacity-only prototype. One actor; two durable permits; uncertainty is terminal.
export type Phase = 'idle' | 'starting' | 'ready' | 'retiring' | 'stopped' | 'quarantined' | 'closed';
export type Journal = {
  schema: 1; identity: string; deadline: number; used: number; phase: Phase; reason: string;
};
export interface Store {
  read(): Promise<unknown>;
  write(state: Journal): Promise<void>;
}
export interface Native {
  absent(): Promise<boolean>;
  start(generation: number): void;
  monitor(): Promise<void>;
  ready(generation: number): Promise<boolean>;
  keepalive(): Promise<void>;
  destroy(): Promise<void>;
}
export type Config = {identity: string; deadline: number};
const phases: Phase[] = ['idle', 'starting', 'ready', 'retiring', 'stopped', 'quarantined', 'closed'];
const reasons = ['none', 'uncertain', 'reconstructed', 'start_threw', 'monitor_threw', 'keepalive_failed', 'deadline'];
const active = (s: Journal) => ['starting', 'ready', 'retiring'].includes(s.phase);
export async function bounded<T>(work: Promise<T>, ms = 2000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(Error('effect_deadline')), ms);
    })]);
  } finally { clearTimeout(timer); }
}
function valid(x: unknown, c: Config): x is Journal {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return false;
  const s = x as Journal;
  return Object.keys(s).sort().join(',') === 'deadline,identity,phase,reason,schema,used' && reasons.includes(s.reason) &&
    s.schema === 1 && s.identity === c.identity && s.deadline === c.deadline &&
    Number.isInteger(s.used) && s.used >= 0 && s.used <= 2 && phases.includes(s.phase) &&
    (s.phase !== 'idle' || s.used === 0) && (!active(s) && s.phase !== 'stopped' || s.used > 0);
}
export class Capacity {
  private store: Store;
  private native: Native;
  private config: Config;
  private clock: () => number;
  private tail: Promise<unknown> = Promise.resolve();
  private state?: Journal;
  private fault = false;
  private monitor?: Promise<void>;
  private exit?: {generation: number; ok: boolean};
  constructor(store: Store, native: Native, config: Config, clock = Date.now) {
    if (!config.identity || !Number.isSafeInteger(config.deadline)) throw Error('config_invalid');
    this.store = store; this.native = native; this.config = config; this.clock = clock;
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn);
    this.tail = result.then(() => {}, () => {});
    return result;
  }
  private async commit(phase: Phase, used = this.state!.used, reason = phase === 'quarantined' ? 'uncertain' : 'none'): Promise<void> {
    const next: Journal = {schema: 1, ...this.config, used, phase, reason};
    try { await this.store.write(next); this.state = next; }
    catch { this.fault = true; throw Error('journal_write_failed'); }
  }
  private async load(): Promise<void> {
    if (this.fault) throw Error('capacity_fault');
    if (this.state) return;
    try {
      const x = await this.store.read();
      if (x === undefined) this.state = {schema: 1, ...this.config, used: 0, phase: 'idle', reason: 'none'};
      else {
        if (!valid(x, this.config)) throw Error('journal_invalid');
        this.state = x;
        // A monitor/continuation cannot be assumed to survive reconstruction.
        if (active(x)) await this.commit('quarantined', x.used, 'reconstructed');
      }
    } catch { this.fault = true; throw Error('journal_read_failed'); }
  }
  private watch(generation: number): void {
    this.exit = undefined;
    const monitor = this.native.monitor(); this.monitor = monitor;
    const observe = (ok: boolean) => {
      // Old-generation completions never replace the current generation's evidence.
      if (this.state?.used !== generation) return;
      this.exit = {generation, ok};
      void this.serial(() => this.reconcile(generation)).catch(() => {});
    };
    void monitor.then(() => observe(true), () => observe(false));
  }
  private async reconcile(generation: number): Promise<void> {
    if (this.fault || !this.state || this.state.used !== generation || !active(this.state)) return;
    if (!this.exit?.ok || this.exit.generation !== generation) await this.commit('quarantined');
    else {
      let absent = false;
      try { absent = await bounded(this.native.absent()); } catch { /* uncertain exit */ }
      await this.commit(absent ? 'stopped' : 'quarantined');
    }
  }
  private snapshot(code = 200) { return {code, state: {...this.state!}}; }
  command(action: 'state' | 'start' | 'check' | 'retire' | 'close', generation?: number) {
    return this.serial(async () => {
      await this.load();
      if (action === 'state') return this.snapshot();
      if (action === 'close') {
        await this.commit('closed');
        try { await bounded(this.native.destroy()); return this.snapshot(await bounded(this.native.absent()) ? 200 : 503); }
        catch { return this.snapshot(503); }
      }
      if (this.clock() >= this.config.deadline) {
        await this.commit('closed');
        try { await bounded(this.native.destroy()); } catch { /* no new authority */ }
        return this.snapshot(410);
      }
      const s = this.state!;
      if (s.phase === 'closed' || s.phase === 'quarantined') return this.snapshot(409);
      if (action === 'start') {
        if (![1, 2].includes(generation!) || generation !== s.used + 1 || s.used >= 2 ||
            !['idle', 'stopped'].includes(s.phase)) return this.snapshot(409);
        try {
          if (!await bounded(this.native.absent())) { await this.commit('quarantined'); return this.snapshot(409); }
        } catch { if (this.fault) throw Error('capacity_fault'); await this.commit('quarantined'); return this.snapshot(503); }
        // Commit before issuing the synchronous native call. A lost commit ack burns it.
        await this.commit('starting', generation);
        if (this.clock() >= this.config.deadline) { await this.commit('closed', generation, 'deadline'); return this.snapshot(410); }
        let failure = 'start_threw';
        try {
          this.native.start(generation);
          failure = 'monitor_threw';
          this.watch(generation);
          failure = 'keepalive_failed';
          await bounded(this.native.keepalive());
          return this.snapshot(202);
        } catch { await this.commit('quarantined', generation, failure); return this.snapshot(503); }
      }
      if (generation !== s.used || !['starting', 'ready', 'retiring', 'stopped'].includes(s.phase)) return this.snapshot(409);
      if (action === 'check') {
        if (!['starting', 'ready'].includes(s.phase)) return this.snapshot(409);
        try {
          if (this.exit?.generation === generation) {
            await this.reconcile(generation!); return this.snapshot(409);
          }
          if (!await bounded(this.native.ready(generation!))) {
            if (s.phase === 'ready') await this.commit('starting');
            return this.snapshot(202);
          }
          if (this.exit?.generation === generation) {
            await this.reconcile(generation!); return this.snapshot(409);
          }
          await this.commit('ready'); return this.snapshot();
        } catch { if (this.fault) throw Error('capacity_fault'); await this.commit('quarantined'); return this.snapshot(503); }
      }
      if (s.phase === 'stopped') return this.snapshot();
      await this.commit('retiring');
      try {
        await bounded(this.native.destroy());
        if (!this.monitor) throw Error('monitor_missing');
        await bounded(this.monitor);
        if (!this.exit?.ok || this.exit.generation !== generation || !await bounded(this.native.absent())) throw Error('exit_unconfirmed');
        await this.commit('stopped'); return this.snapshot();
      } catch { if (this.fault) throw Error('capacity_fault'); await this.commit('quarantined'); return this.snapshot(503); }
    });
  }
}
