import assert from 'node:assert/strict';
import { ownedUsageWire } from './owned-json-parser-cases.mjs';

// Fixture-only source observers. Forward every original operation unchanged;
// retain scalar counts, never parser input, keys, values, containers or tokens.
// These observers are NOT production factories or a complete CONTROL inventory.
export function createOwnedJsonObservation() {
  const rows = [], readers = new WeakSet(), driverOriginOwners = new WeakSet(), foregroundOwners = [];
  function assertClosedHandler(handler) {
    if (!Object.isFrozen(handler)) throw Error('actual observer handler is extensible');
    const names = Reflect.ownKeys(handler), prototype = Object.getPrototypeOf(handler);
    const name = Object.getOwnPropertyDescriptor(handler, 'name'), length = Object.getOwnPropertyDescriptor(handler, 'length');
    const foreign = { marker: 'foreign-handler-graph' }, symbol = Symbol('foreign-handler');
    if (Reflect.set(handler, 'foreign', foreign) || Reflect.set(handler, symbol, foreign)
      || Reflect.defineProperty(handler, 'name', { value: 'x'.repeat(40000) })
      || Reflect.defineProperty(handler, 'length', { value: foreign })
      || Reflect.setPrototypeOf(handler, foreign)) throw Error('actual observer handler shape changed');
    if (Reflect.ownKeys(handler).length !== names.length || Object.getPrototypeOf(handler) !== prototype
      || Object.getOwnPropertyDescriptor(handler, 'name').value !== name.value
      || Object.getOwnPropertyDescriptor(handler, 'length').value !== length.value) throw Error('handler descriptor mutation');
  }

  let current, censusUsage = false, preparations = 0;
  let archiveWriter, releaseArchiveFault, archiveRawReason, archiveSubjectChecking = false;
  const archiveFault = { calls: 0, observations: 0, touched: 0, entered: false, released: false,
    original: null, installation: null, thrown: null, didThrow: false, fulfilled: false, commandFulfilled: false, commandRejected: false, nativeFailed: false, unknown: false, before: 0, after: 0, phase: 0, originalOrdinal: -1, installationOrdinal: -1, reasonReads: 0, puts: 0, envGets: 0, cancelCalls: 0, awaitingBounded: false, failures: [] };
  function archiveFaultOriginal(original, command, mode, outcome, reasonKind) {
    archiveFault.calls++;
    const first = reasonKind === 'undefined' ? undefined : Object.freeze({ fixture: 'archive-original' });
    const second = reasonKind === 'undefined' ? undefined : reasonKind === 'equal' ? first : Object.freeze({ fixture: 'archive-installation' });
    const nativeThen = Promise.prototype.then;
    void Reflect.apply(nativeThen, original, [() => { archiveFault.nativeFailed = false; }, () => { archiveFault.nativeFailed = true; }]);
    void Reflect.apply(nativeThen, command.ready, [value => {
      if (value !== undefined) throw Error('archive command transported a graph'); archiveFault.commandFulfilled = true;
    }, reason => {
      if (reason !== command.owner.sinkOrigins.get(Math.floor(command.origin / 32))
        && reason !== command.owner.sinkOrigins.get(Math.floor(command.installationOrigin / 32))) throw Error('unbounded archive command failure');
      archiveFault.commandRejected = true; reason = undefined;
    }]);
    let release; const held = new Promise(resolve => { release = resolve; });
    releaseArchiveFault = () => { archiveFault.released = true; release(); };
    const foreign = Object.defineProperty({}, 'then', { get() { archiveFault.touched++; throw Error('foreign archive observer return'); } });
    Object.defineProperty(original, 'then', { value(yes, no) {
      archiveFault.observations++; archiveFault.entered = true;
      if (this !== original || arguments.length !== 2) throw Error('archive actual original operands');
      assertClosedHandler(yes); assertClosedHandler(no);
      archiveFault.originalOrdinal = Math.floor(command.origin / 32);
      archiveFault.installationOrdinal = Math.floor(command.installationOrigin / 32);
      if (mode === 'install') {
        if (outcome === 'reject') no(first); else yes(undefined);
        throw second;
      }
      void Reflect.apply(nativeThen, original, [value => { void held.then(() => yes(value)); }, reason => { void held.then(() => no(reason)); }]);
      return outcome === 'held' ? new Promise(() => {}) : outcome === 'hostile' ? foreign : undefined;
    } });
    return original;
  }

  const consumers = { created: 0, acquired: 0, retired: 0, live: 0, inner: 0, outer: 0,
    read: 0, cancel: 0, unlock: 0, nativeUnlocked: 0, unlockSettled: 0, thenCalls: 0, closed: 0, closedSettled: 0, replay: 0, transferred: 0, pricing: 0, enqueued: 0, oversizedOutput: 0, mutations: 0, held: false, released: false, reasonReads: 0 };
  const usage = { census: 0, parsed: 0, maxGraph: 0, maxContainers: 0, maxStrings: 0, maxAtoms: 0, maxUnits: 0, summaries: 0, cleared: 0 };
  const shared = { claims: 0, held: 0, refused: 0, before: 0, after: 0 };
  let restoreIngressConstruction;
  let releaseConsumer, mutateIntake, restoreArchiveData, restoreHeaderIterator, restoreHeaderForEach, releaseMetadataPressure;
  const headers = { applied: false, body: 0, headers: 0, status: 0, statusText: 0, hooks: 0, coercions: 0, constructors: 0, component: 0, early: 0, indexUnits: 0, unitMeasurements: 0 };
  const initialErrors = { bootstrapRefused: 0, owners: 0, renderings: 0, hooks: 0, refusals: 0 };
  let restoreErrorHooks, releaseEntryPressure;
  const metadata = { entered: false, hooks: 0, versionGets: 0, stage: -1, factories: [0, 0, 0, 0, 0, 0], refused: -1, stages: [] };
  const archive = { pulls: 0, chunks: 0, maximumBacking: 0, hookAccesses: 0, puts: 0, nativeSettled: 0, thenCalls: 0, delivered: 0, released: false };
  const statusReaders = [], statusReleases = [];
  const publicReaders = { ...consumers, captureCount: 0, captureTotal: 0, capturePeak: 0, liveCapture: 0, postSeal: 0, handoffs: 0, copies: 0, refusals: 0, refusedLive: 0, refusedHigh: 0, beforeLive: 0, beforeHigh: 0 }, intakeReaders = { ...consumers }, sourceReaders = { ...consumers };
  const normalizers = { ...consumers, doneGets: 0, valueGets: 0, eofValues: 0, trace: "", captured: 0, transfers: 0, postSeal: 0, maximumBacking: 0 };
  const publication = { active: false, entered: false, trace: "", hooks: 0, produced: 0, published: 0, factories: 0,
    headerFactories: 0, growCalls: 0, refused: false, foreignCancels: 0, cleanups: 0, bytes: 0, retired: 0 };
  const publicationResponse = Response, publicationHeaders = Headers, publicationApply = Reflect.apply;
  const publicationResponsePrototype = Response.prototype, publicationHeaderPrototype = Headers.prototype;
  // Match the production trusted-init capture: Workerd declares body on Body.
  const publicationBody = (Object.getOwnPropertyDescriptor(publicationResponsePrototype, "body")
    ?? Object.getOwnPropertyDescriptor(Object.getPrototypeOf(publicationResponsePrototype), "body")).get;
  const publicationStatus = Object.getOwnPropertyDescriptor(publicationResponsePrototype, "status").get;
  const publicationStatusText = Object.getOwnPropertyDescriptor(publicationResponsePrototype, "statusText").get;
  const publicationHeader = Object.getOwnPropertyDescriptor(publicationResponsePrototype, "headers").get;
  const publicationSet = Headers.prototype.set, publicationAppend = Headers.prototype.append;
  let restorePublication, publicationSourceHeaders, publicationFinalHeaders, publicationPressureCharge;
  const generic = { ...consumers, doneGets: 0, valueGets: 0, eofValues: 0, trace: "", transfers: 0, lateGets: 0, logical: 0, installs: 0, failures: 0, readFailures: 0, copies: 0 };
  consumers.publication = publication;
  consumers.generic = generic;
  consumers.normalizer = normalizers;
  consumers.public = publicReaders; consumers.intake = intakeReaders; consumers.source = sourceReaders;
  function faultReader(reader, mode, consumers, intakeOwner) {
      if (mode === 'constructor-capture') {
        const parse = JSON.parse, apply = Reflect.apply;
        consumers.constructorHooks = 0; consumers.constructed = 0;
        JSON.parse = function (text, reviver) {
          if (typeof text === 'string' && text.includes('privateConstructorProbe')) {
            consumers.constructorHooks++; throw Error('private ingress text exposed');
          }
          return apply(parse, this, [text, reviver]);
        };
        restoreIngressConstruction = () => { JSON.parse = parse; };
        releaseConsumer = restoreIngressConstruction;
        return;
      }
      if (mode === 'byte-snapshot' || mode === 'eof-foreign') {
        const read = reader.read, then = Promise.prototype.then;
        consumers.snapshotGets = 0; consumers.shadowGets = 0; consumers.eofValueGets = 0;
        Object.defineProperty(reader, 'read', { value(...args) {
          if (this !== reader) throw Error('snapshot read receiver');
          consumers.read++;
          const original = Reflect.apply(read, this, args);
          Object.defineProperty(original, 'then', { value(yes, no) {
            if (this !== original || arguments.length !== 2) throw Error('snapshot observer boundary');
            consumers.thenCalls++;
            void Reflect.apply(then, this, [part => {
              const done = part.done;
              if (done && mode === 'eof-foreign') {
                yes({ done: true, get value() {
                  consumers.eofValueGets++;
                  return { get buffer() { consumers.shadowGets++; throw Error('EOF storage inspection'); } };
                } });
                return;
              }
              const bytes = part.value;
              if (!done && bytes) {
                for (const key of ['buffer', 'byteLength', 'length']) Object.defineProperty(bytes, key, {
                  configurable: true, get() { consumers.shadowGets++; throw Error('public snapshot property shadow'); },
                });
              }
              yes({ get done() { consumers.snapshotGets++; return done; }, get value() { consumers.snapshotGets++; return bytes; } });
              if (!done && bytes) { Uint8Array.prototype.fill.call(bytes, 0); consumers.mutations++; }
            }, no]);
            return undefined;
          } });
          return original;
        } });
        return;
      }
      if (mode.startsWith('operand-')) {
        const name = mode.slice(8), read = reader.read, then = Promise.prototype.then;
        const typed = Object.getPrototypeOf(Uint8Array.prototype), descriptor = Object.getOwnPropertyDescriptor(typed, 'set');
        const shadow = Object.getOwnPropertyDescriptor(Uint8Array.prototype, 'set');
        let first = true;
        consumers.operandOrder = []; consumers.copyAccessor = 0; consumers.customCopy = 0; consumers.coercions = 0;
        const restore = () => {
          Object.defineProperty(typed, 'set', descriptor);
          if (shadow) Object.defineProperty(Uint8Array.prototype, 'set', shadow); else delete Uint8Array.prototype.set;
        };
        releaseConsumer = restore;
        const accessor = { configurable: true, get() { consumers.copyAccessor++; return descriptor.value; } };
        Object.defineProperty(reader, 'read', { value(view) {
          if (this !== reader || arguments.length !== 1 || view.byteLength !== 16384) throw Error('intake operand read boundary');
          consumers.read++;
          const original = Reflect.apply(read, this, [view]);
          Object.defineProperty(original, 'then', { value(yes, no) {
            if (this !== original || arguments.length !== 2) throw Error('intake operand observer boundary');
            void Reflect.apply(then, this, [part => {
              if (!first || part.done) { yes(part); return; }
              first = false;
              let one = new Uint8Array([91, 93]), two = new Uint8Array([48, 48]), three = new Uint8Array([123, 125]);
              let length = 2, firstBuffer = one.buffer;
              if (name.endsWith('-oversized')) {
                const large = new Uint8Array(new ArrayBuffer(16385), 0, 2);
                large.set([123, 125]);
                if (name === 'value1-oversized') { one = large; firstBuffer = new ArrayBuffer(2); }
                else if (name === 'value2-oversized') two = large; else three = large;
              }
              if (name === 'length-one-to-four') { length = 1; three = new Uint8Array([49, 50, 51, 52]); }
              if (name === 'length-four-to-one') { length = 4; three = new Uint8Array([48]); }
              if (name === 'length-object') length = { valueOf() { consumers.coercions++; throw Error('length coercion'); } };
              if (name === 'shadow-buffer') {
                Object.defineProperty(two, 'buffer', { get() { throw Error('VALUE2 buffer shadow'); } });
                Object.defineProperty(three, 'buffer', { get() { throw Error('VALUE3 buffer shadow'); } });
                Object.defineProperty(three, 'length', { get() { throw Error('VALUE3 length shadow'); } });
              }
              Object.defineProperty(one, 'buffer', { get() { consumers.operandOrder.push('buffer1'); return firstBuffer; } });
              Object.defineProperty(two, 'byteLength', { get() { consumers.operandOrder.push('length2'); return length; } });
              if (name === 'set-accessor' || name === 'set-persist-through-auth') Object.defineProperty(typed, 'set', accessor);
              else if (name === 'set-shadow') Object.defineProperty(Uint8Array.prototype, 'set', accessor);
              else if (name === 'set-replacement') Object.defineProperty(typed, 'set', { ...descriptor, value() { consumers.customCopy++; } });
              let gets = 0;
              try { yes({
                get done() { consumers.operandOrder.push('done'); return false; },
                get value() {
                  consumers.operandOrder.push('value' + ++gets);
                  if (gets === 3 && name === 'set-change-in-third-getter') Object.defineProperty(typed, 'set', accessor);
                  return gets === 1 ? one : gets === 2 ? two : three;
                },
              }); } finally { if (name !== 'set-persist-through-auth') restore(); one = undefined; two = undefined; three = undefined; firstBuffer = undefined; }
            }, no]);
            return undefined;
          } });
          return original;
        } });
        return;
      }
      if (mode === 'cells-148' || mode === 'cells-512') {
        const read = reader.read, then = Promise.prototype.then, retained = [];
        let owner = intakeOwner;
        consumers.getterOrder = ''; consumers.foreignGets = 0; consumers.coercions = 0; consumers.inert = 0; consumers.observations = 0;
        const foreign = { get done() { consumers.foreignGets++; throw Error('foreign done'); }, get value() { consumers.foreignGets++; throw Error('foreign value'); } };
        const truthy = { [Symbol.toPrimitive]() { consumers.coercions++; throw Error('done coercion'); } };
        const replay = () => {
          for (const item of retained) {
            if (item.cell.flags !== 8 || item.cell.owner !== undefined || item.cell.ready !== undefined || item.cell.resolve !== undefined || item.cell.kind !== 0)
              throw Error('intake cell not detached after consumption');
            item.yes(foreign); item.no(foreign);
          }
          consumers.inert = retained.length;
        };
        Object.defineProperty(reader, 'read', { value(view) {
          if (this !== reader || arguments.length !== 1 || view.byteLength !== 16384) throw Error('intake read call changed');
          replay(); consumers.read++;
          const original = Reflect.apply(read, this, [view.subarray(0, 1)]);
          Object.defineProperty(original, 'then', { value(yes, no) {
            if (this !== original || arguments.length !== 2) throw Error('intake observer call changed');
            const cell = owner.reading;
            if (!cell || cell.owner !== owner || cell.flags & 1) throw Error('missing prepaid intake cell');
            consumers.observations++;
            retained.push({ cell, yes, no });
            void Reflect.apply(then, this, [part => yes({
              get done() { consumers.getterOrder += 'd'; yes(foreign); no(foreign); return part.done ? truthy : false; },
              get value() { consumers.getterOrder += 'v'; if (part.done) throw Error('intake EOF value read'); yes(foreign); return part.value; },
            }), no]);
            return undefined;
          } });
          return original;
        } });
        releaseConsumer = () => { replay(); retained.length = 0; owner = undefined; };
        return;
      }
      if (mode === 'handoff-getters' || mode === 'handoff-duplicates') {
        const read = reader.read, nativeThen = Promise.prototype.then;
        let stale;
        consumers.getterOrder = ''; consumers.methodGets = 0; consumers.duplicateCalls = 0; consumers.staleCalls = 0;
        const poison = Object.freeze({ get done() { throw new Error('stale done consumed'); }, get value() { throw new Error('stale value consumed'); } });
        Object.defineProperty(reader, 'read', { get() {
          consumers.methodGets++;
          return function (...args) {
            if (this !== reader || args.length !== 0) throw new Error('reader receiver or arguments changed');
            consumers.read++;
            if (stale) { const previous = stale; stale = undefined; consumers.staleCalls++; previous(poison); }
            const original = Reflect.apply(read, this, args).then(result => {
              let doneRead = false, valueRead = false;
              return {
                get done() { if (doneRead) throw new Error('done getter repeated'); doneRead = true; consumers.getterOrder += 'd'; return result.done; },
                get value() { if (valueRead) throw new Error('value getter repeated'); valueRead = true; consumers.getterOrder += 'v'; return result.value; },
              };
            });
            if (mode === 'handoff-duplicates') Object.defineProperty(original, 'then', { value(yes, no) {
              consumers.thenCalls++;
              return Reflect.apply(nativeThen, this, [value => {
                yes(value); consumers.duplicateCalls++; yes(poison); no(undefined); stale = yes;
              }, no]);
            } });
            return original;
          };
        } });
        releaseConsumer = () => { stale = undefined; };
        return;
      }
      if (mode === 'pending-success' || mode === 'then-early') {
        const read = reader.read;
        let first = true, release;
        const held = new Promise(resolve => { release = resolve; });
        releaseConsumer = release;
        Object.defineProperty(reader, 'read', { value(...args) {
          const original = Reflect.apply(read, this, args).then(async result => {
            consumers.read++;
            if (first && !result.done) { first = false; consumers.held = true; await held; }
            return result;
          });
          if (mode === 'then-early') {
            const then = original.then;
            Object.defineProperty(original, 'then', { value(...handlers) {
              consumers.thenCalls++; Reflect.apply(then, this, handlers);
              return Promise.resolve({ done: true, value: undefined });
            } });
          }
          return original;
        } });
        return;
      }
      if (mode === 'request-before' || mode === 'request-after' || mode === 'request-late') {
        const read = reader.read;
        let retained, position = 0, release;
        const held = new Promise(resolve => { release = resolve; });
        releaseConsumer = () => { retained = undefined; release(); };
        mutateIntake = () => { if (!retained) throw new Error('request original view absent'); retained[position] = 66; consumers.mutations++; };
        Object.defineProperty(reader, 'read', { value(...args) {
          return Reflect.apply(read, this, args).then(async result => {
            if (!result.done && result.value) {
              const marker = new TextDecoder().decode(result.value).indexOf('snapA');
              if (marker >= 0) {
                position = marker + 4;
                if (mode === 'request-before') { result.value[position] = 66; consumers.mutations++; }
                else retained = result.value;
                if (mode === 'request-late') { consumers.held = true; await held; }
              }
            }
            consumers.read++; return result;
          });
        } });
        return;
      }
      if (mode.startsWith('usage:')) {
        const [, name, format] = mode.split(':'), read = reader.read;
        let wire = globalThis.__ownedUsageWire(name, format === 'sse'), offset = 0;
        releaseConsumer = () => { wire = ''; };
        Object.defineProperty(reader, 'read', { value(...args) {
          return Reflect.apply(read, this, args).then(result => {
            if (offset < wire.length) {
              const end = Math.min(wire.length, offset + 1900000);
              const bytes = new TextEncoder().encode(wire.slice(offset, end)); offset = end;
              return { done: false, value: bytes };
            }
            wire = '';
            return result.done ? result : { done: false, value: new Uint8Array(0) };
          });
        } });
        return;
      }
      if (mode === 'capture-before' || mode === 'capture-after') {
        const read = reader.read;
        let previous, offset = 0;
        releaseConsumer = () => { previous = undefined; };
        Object.defineProperty(reader, 'read', { value(...args) {
          if (previous) { previous[offset] = 57; previous = undefined; consumers.mutations++; }
          return Reflect.apply(read, this, args).then(result => {
            if (!result.done && result.value) {
              const marker = new TextDecoder().decode(result.value).indexOf('"prompt_tokens":4');
              if (marker >= 0) {
                const index = marker + '"prompt_tokens":'.length;
                if (mode === 'capture-before') { result.value[index] = 57; consumers.mutations++; }
                else { previous = result.value; offset = index; }
              }
            }
            return result;
          });
        } });
        return;
      }
      if (!mode.startsWith('read-') && !mode.startsWith('unlock-') && !mode.startsWith('closed-')) return;
      const kind = mode.split('-').at(-1);
      let reason = kind === 'undefined' ? undefined : kind === 'primitive' ? 'x'.repeat(17 * 1024 * 1024)
        : Object.freeze({ get message() { consumers.reasonReads++; throw new Error('foreign reason getter'); },
          get then() { consumers.reasonReads++; throw new Error('foreign reason then'); } });
      const read = reader.read, cancel = reader.cancel, unlock = reader.releaseLock;
      let reads = 0;
      const released = new Promise(resolve => { releaseConsumer = resolve; });
      if (!mode.startsWith('read-')) {
        if (mode.startsWith('closed-') || mode.includes('-closed-')) {
          const original = reader.closed;
          const observed = original.then(() => {
            consumers.closed++; consumers.held = true;
            return released.then(() => { consumers.closedSettled++; if (kind !== 'success') throw reason; });
          });
          Object.defineProperty(reader, 'closed', { get() { return observed; } });
        }
        Object.defineProperty(reader, 'releaseLock', { value(...args) {
          consumers.unlock++;
          const native = () => { Reflect.apply(unlock, this, args); consumers.nativeUnlocked++; };
          if (mode.startsWith('closed-')) { native(); consumers.unlockSettled++; return; }
          if (mode.startsWith('unlock-before-')) native();
          consumers.held = true;
          const original = released.then(() => {
            if (mode.startsWith('unlock-after-')) native();
            consumers.unlockSettled++;
            if (kind !== 'success') throw reason;
          });
          return mode === 'unlock-after-success' ? { then(fulfilled, rejected) {
            consumers.thenCalls++; return original.then(fulfilled, rejected);
          } } : original;
        } });
        return;
      }
      // Faults occur AFTER the actual native method. Production must call these
      // actual methods, observe their original promises, and retain that join.
      Object.defineProperty(reader, 'read', { value(...args) {
        consumers.read++; const original = Reflect.apply(read, this, args);
        return original.then(value => { if (++reads === 2) throw reason; return value; });
      } });
      Object.defineProperty(reader, 'cancel', { value(...args) {
        consumers.cancel++; const original = Reflect.apply(cancel, this, args);
        return original.then(async () => { consumers.held = true; await released; const failure = reason; reason = undefined; throw failure; });
      } });
      Object.defineProperty(reader, 'releaseLock', { value(...args) {
        Reflect.apply(unlock, this, args); consumers.unlock++; throw reason;
      } });
  }
  const peak = row => {
    row.peakParents = Math.max(row.peakParents, row.parents);
    row.peakTokens = Math.max(row.peakTokens, row.tokens);
    const stored = (row.kind === 'validator' ? 1 : 2) + row.parents + row.tokens + Number(row.pending) + Number(row.member);
    row.peakStored = Math.max(row.peakStored, stored);
    if (current === row) row.peakActive = Math.max(row.peakActive, stored);
    else row.peakBetween = Math.max(row.peakBetween, stored);
  };
  return {
    rows,
    foreground(owner) { if (this.retainedStatus) foregroundOwners.push(owner); },
    foregroundState() { return foregroundOwners.map(owner => ({ bytes: owner.lease.bytes, reduction: owner.reduction ?? 0, retained: owner.retained })); },
    reductionBlocked: [],
    preflightTransfers: { staged: 0, taken: 0, advanced: 0 },
    driverReads: 0, driverFactories: 0, intakeFactories: 0, retryPorts: [], credentialReductions: [], credentialCensuses: [], originalObservers: [],
    retainOriginalHandlers(cell, fulfilled, rejected) {
      this.originalObservers.push({ cell, fulfilled, rejected, role: cell.owner.constructor.name });
      return [fulfilled, rejected];
    },
    originalObserverState() {
      return this.originalObservers.map(row => ({ role: row.role, state: row.cell.state, severed: row.cell.owner === undefined }));
    },
    replayRetiredOriginals() {
      let reads = 0, callbacks = 0;
      const foreign = {};
      for (const key of ['then', 'body', 'ok', 'done', 'value', 'buffer']) Object.defineProperty(foreign, key, { get() { reads++; throw Error('retired callback inspected payload'); } });
      for (const row of this.originalObservers) if (row.cell.owner === undefined) { row.fulfilled(foreign); row.rejected(foreign); callbacks += 2; }
      return { reads, callbacks };
    },
    driverFactory() { if (shared.held !== 65536 || shared.claims !== 1) throw new Error("driver field initializer before shared claim"); this.driverFactories++; },
    intakeFactory() { if (shared.held !== 65536 || shared.claims !== 1) throw new Error("intake field initializer before shared claim"); this.intakeFactories++; },
    driverRead() { this.driverReads++; },
    consumers,
    usage,
    shared,
    sharedClaim(before, after, held) {
      if (shared.claims || held !== 65536 || after - before !== held) throw new Error('shared claim is not one exact positive debit');
      shared.claims++; shared.held = held; shared.before = before; shared.after = after;
    },
    sharedRefused(before, after) { if (before !== after) throw new Error('failed shared claim changed COMMON'); shared.refused++; },
    sharedPressure(charge) { if (!charge) throw new Error('shared claim pressure setup'); releaseConsumer = () => charge.release(); },
    initialErrors,
    entryPressure(charge) {
      if (!charge) throw Error('entry pressure setup');
      const previous = releaseConsumer;
      releaseEntryPressure = () => { charge.release(); releaseEntryPressure = undefined; };
      releaseConsumer = () => { restoreErrorHooks?.(); releaseEntryPressure?.(); previous?.(); };
    },
    initialErrorHooks() {
      if (this.consumerMode !== 'initial-error-hooks') return;
      const object = Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON');
      const array = Object.getOwnPropertyDescriptor(Array.prototype, 'toJSON');
      restoreErrorHooks = () => {
        if (object) Object.defineProperty(Object.prototype, 'toJSON', object); else delete Object.prototype.toJSON;
        if (array) Object.defineProperty(Array.prototype, 'toJSON', array); else delete Array.prototype.toJSON;
        restoreErrorHooks = undefined;
      };
      Object.defineProperty(Object.prototype, 'toJSON', { configurable: true, value() { initialErrors.hooks++; throw Error('initial object hook'); } });
      Object.defineProperty(Array.prototype, 'toJSON', { configurable: true, value() { initialErrors.hooks++; return 'expanded array'; } });
    },
    initialErrorDone() { restoreErrorHooks?.(); },
    metadata,
    metadataInput(response, request, env, mark, background) {
      const mode = this.consumerMode;
      if (!mode.startsWith('metadata-') || metadata.entered) return;
      metadata.entered = true;
      const previous = releaseConsumer, restores = [];
      releaseConsumer = () => { for (const restore of restores) restore(); previous?.(); };
      if (mode === 'metadata-branded-held' || mode === 'metadata-refuse-0') mark(response, 'fixture_metadata', 'synthetic private metadata error');
      background(request, 'synthetic-locator-' + 'x'.repeat(8192));
      const version = Object.getOwnPropertyDescriptor(env, 'CF_VERSION_METADATA');
      Object.defineProperty(env, 'CF_VERSION_METADATA', { configurable: true, get() {
        return { get id() { return ++metadata.versionGets === 1 ? 'first-only' : 'second-value'; } };
      } });
      restores.push(() => { if (version) Object.defineProperty(env, 'CF_VERSION_METADATA', version); else delete env.CF_VERSION_METADATA; });
      if (mode === 'metadata-poison') {
        const headers = response.headers;
        headers.set('x-ratelimit-fixture', '7'); headers.set('anthropic-ratelimit-fixture', '8');
        headers.append('set-cookie', 'first=1; Expires=Wed, 21 Oct 2037 07:28:00 GMT'); headers.append('set-cookie', 'second=2');
        for (const name of ['set', 'has', 'delete', 'keys', 'forEach', Symbol.iterator]) {
          const descriptor = Object.getOwnPropertyDescriptor(Headers.prototype, name);
          restores.push(() => Object.defineProperty(Headers.prototype, name, descriptor));
          Object.defineProperty(Headers.prototype, name, { configurable: true, writable: true, value() { metadata.hooks++; throw Error('mutable final metadata method'); } });
        }
      }
    },
    metadataStage(stage) { if (metadata.entered) { metadata.stage = stage; metadata.stages.push(stage); } },
    metadataFactory() { if (metadata.entered) metadata.factories[metadata.stage]++; },
    metadataPressure(stage, charge) {
      if (!charge) throw Error('metadata pressure setup'); metadata.refused = stage;
      const previous = releaseConsumer;
      releaseMetadataPressure = () => { charge.release(); releaseMetadataPressure = undefined; };
      releaseConsumer = () => { releaseMetadataPressure?.(); previous?.(); };
    },
    metadataRefused() { releaseMetadataPressure?.(); },
    headers,
    headerResponse(response, publicBoundary) {
      if (!publicBoundary || headers.applied || !this.consumerMode.startsWith('headers-')) return;
      headers.applied = true;
      const mode = this.consumerMode, prototype = Response.prototype;
      const body = Object.getOwnPropertyDescriptor(prototype, 'body').get;
      const status = Object.getOwnPropertyDescriptor(prototype, 'status').get;
      const statusText = Object.getOwnPropertyDescriptor(prototype, 'statusText').get;
      const original = response.headers, first = new Headers(original), second = new Headers(original);
      second.append('X-Mixed-Case', 'one'); second.append('x-mixed-case', 'two'); second.set('X-Empty', '');
      second.append('Set-Cookie', 'first=1; Expires=Wed, 21 Oct 2037 07:28:00 GMT'); second.append('Set-Cookie', 'second=2; Path=/');
      second.set('X-Fixture-Large', 'x'.repeat(4096));
      if (mode === 'headers-foreach') for (const value of [first, second]) Object.defineProperty(value, 'forEach', { value() { headers.hooks++; } });
      if (mode === 'headers-iterator') for (const value of [first, second]) Object.defineProperty(value, Symbol.iterator, { get() { headers.hooks++; throw Error('private constructor used custom iterator'); } });
      if (mode === 'headers-next') {
        const iterator = Headers.prototype.entries.call(first), parent = Object.getPrototypeOf(iterator), next = Object.getOwnPropertyDescriptor(parent, 'next');
        restoreHeaderIterator = () => { Object.defineProperty(parent, 'next', next); restoreHeaderIterator = undefined; };
        Object.defineProperty(parent, 'next', { configurable: true, value() { headers.hooks++; return { done: true }; } });
      }
      releaseConsumer = () => { restoreHeaderIterator?.(); restoreHeaderForEach?.(); };
      Object.defineProperties(response, {
        body: { get() { headers.body++; return Reflect.apply(body, response, []); } },
        headers: { get() { return ++headers.headers === 1 ? first : second; } },
        status: { get() {
          headers.status++; if (mode === 'headers-late') second.set('X-Status-Mutation', 'status');
          if (mode === 'headers-prototype-foreach') {
            const descriptor = Object.getOwnPropertyDescriptor(Headers.prototype, 'forEach');
            restoreHeaderForEach = () => { Object.defineProperty(Headers.prototype, 'forEach', descriptor); restoreHeaderForEach = undefined; };
            Object.defineProperty(Headers.prototype, 'forEach', { ...descriptor, value() { headers.hooks++; } });
          }
          if (mode === 'headers-constructor-held') return 99;
          return mode === 'headers-status-object' ? { valueOf() { headers.coercions++; return 200; } } : Reflect.apply(status, response, []);
        } },
        statusText: { get() {
          headers.statusText++; if (mode === 'headers-late') second.set('X-Text-Mutation', 'text');
          if (mode === 'headers-text-object') return { toString() { headers.coercions++; return 'OK'; } };
          return mode === 'headers-long-text' ? 'owned-' + 'x'.repeat(4096) : Reflect.apply(statusText, response, []);
        } },
      });
    },
    headerAdmission(component, early) { if (headers.applied) { headers.component = component; headers.early = early; } },
    headerConstructor() { if (headers.applied) headers.constructors++; if (publication.active) publication.factories++; },
    headerConstructed() { restoreHeaderIterator?.(); },
    headerUnits(units) { if (headers.applied) { headers.indexUnits = units; headers.unitMeasurements++; } },
    archive,
    archiveEnter() {
      if (this.consumerMode !== 'archive-kernel-held') return;
      archive.pulls++;
      const typed = Object.getPrototypeOf(Uint8Array.prototype), view = Object.getOwnPropertyDescriptor(typed, 'subarray');
      const encode = Object.getOwnPropertyDescriptor(TextEncoder.prototype, 'encodeInto'), species = Object.getOwnPropertyDescriptor(Uint8Array, Symbol.species);
      restoreArchiveData = () => {
        Object.defineProperty(typed, 'subarray', view); Object.defineProperty(TextEncoder.prototype, 'encodeInto', encode);
        if (species) Object.defineProperty(Uint8Array, Symbol.species, species); else delete Uint8Array[Symbol.species];
        restoreArchiveData = undefined;
      };
      const trap = { configurable: true, get() { archive.hookAccesses++; throw Error('private archive DATA escaped'); } };
      Object.defineProperty(typed, 'subarray', trap); Object.defineProperty(TextEncoder.prototype, 'encodeInto', trap);
      Object.defineProperty(Uint8Array, Symbol.species, trap);
    },
    archiveExit() { restoreArchiveData?.(); },
    archiveChunk(backing) { archive.chunks++; archive.maximumBacking = Math.max(archive.maximumBacking, backing); },
    archiveFault,
    archivePrepared(writer) {
      archiveWriter = writer;
      Object.assign(archiveFault, { calls: 0, observations: 0, touched: 0, entered: false, released: false,
        original: null, installation: null, thrown: null, didThrow: false, fulfilled: false, commandFulfilled: false,
        commandRejected: false, nativeFailed: false, unknown: false, before: writer.root.funding.bytes, after: 0, phase: 0,
        originalOrdinal: -1, installationOrdinal: -1, reasonReads: 0, puts: 0, envGets: 0, cancelCalls: 0, awaitingBounded: false });
      archiveFault.failures.length = 0;
      const [prefix, target, kind] = this.consumerMode.split(':');
      if (['archive-return', 'archive-install'].includes(prefix) && target === 'cancel') {
        Object.defineProperty(writer.bucket, 'put', { value() { archiveFault.puts++; throw Error('fixture required cancel'); } }); return;
      }
      if (prefix !== 'archive-failure') return;
      archiveRawReason = kind === 'undefined' ? undefined : kind === 'large-string' ? 'x'.repeat(17 * 1024 * 1024)
        : { payload: Array.from({ length: 10000 }, () => 'x'.repeat(1024)) };
      if (kind === 'opaque-object') for (const key of ['message', 'stack', 'cause', 'errors', 'code', 'then'])
        Object.defineProperty(archiveRawReason, key, { get() { archiveFault.reasonReads++; throw Error('foreign archive reason read'); } });
      if (target === 'getter') Object.defineProperty(writer.env, 'CONTENT_ARCHIVE', { configurable: true, get() {
        archiveFault.envGets++; throw archiveRawReason;
      } });
      else Object.defineProperty(writer.bucket, 'put', { configurable: true, value(...args) {
        if (this !== writer.bucket || args.length !== 3) throw Error('archive put operands');
        archiveFault.puts++; throw archiveRawReason;
      } });
    },
    archiveReadable(writer) {
      if (!this.consumerMode.startsWith('archive-failure:')) return;
      const readable = writer.readable, cancel = readable.cancel, nativeThen = Promise.prototype.then;
      let release; const held = new Promise(resolve => { release = resolve; });
      releaseArchiveFault = () => { archiveFault.released = true; release(); };
      Object.defineProperty(readable, 'cancel', { value(...args) {
        if (this !== readable || args.length) throw Error('archive cancel operands'); archiveFault.cancelCalls++;
        const original = Reflect.apply(cancel, this, args);
        Object.defineProperty(original, 'then', { value(yes, no) {
          if (this !== original || arguments.length !== 2) throw Error('archive cancel observer operands');
          archiveFault.entered = true; assertClosedHandler(yes); assertClosedHandler(no);
          void Reflect.apply(nativeThen, original, [() => { void held.then(() => no(archiveRawReason)); }, () => { void held.then(() => no(archiveRawReason)); }]);
          return undefined;
        } }); return original;
      } });
    },
    archivePrimary(primary, inspect) {
      if (!this.consumerMode.startsWith('archive-failure:')) return;
      const record = inspect(primary);
      if (!record || archiveWriter.root.sinkOrigins.get(record.ordinal) !== primary) throw Error('raw archive primary crossed await');
      archiveFault.awaitingBounded = true;
    },
    archiveFact(owner, record) {
      if (!this.consumerMode.startsWith('archive-failure:') || owner !== archiveWriter?.root) return;
      const ordinals = [archiveWriter.putCommand?.origin, archiveWriter.pipeCommand?.origin, archiveWriter.cancelCommand?.origin,
        archiveWriter.abortOrigin, archiveWriter.lockOrigin, archiveWriter.discardOrigin, archiveWriter.followOrigin];
      if (ordinals.some(origin => Math.floor(origin / 32) === record.ordinal)) archiveFault.failures.push({ ...record });
    },
    archiveWriting(writer, work, inspect) {
      if (!this.consumerMode.startsWith('archive-')) return;
      let root = writer.root;
      void Reflect.apply(Promise.prototype.then, work, [value => {
        if (value !== undefined) throw Error('archive work transported a graph'); archiveFault.fulfilled = true; root = undefined;
      }, reason => {
        const metadata = inspect(reason);
        if (!metadata || root.sinkOrigins.get(metadata.ordinal) !== reason) throw Error('archive retained an unbounded failure');
        archiveFault.didThrow = true; archiveFault.thrown = { ...metadata }; reason = undefined; root = undefined;
      }]);
    },

    archiveFaultState() {
      if (!archiveWriter) return archiveFault;
      archiveFault.unknown = archiveWriter.root?.unknown ?? false;
      archiveFault.after = archiveWriter.root?.funding.bytes ?? 0;
      archiveFault.phase = archiveWriter.phase;
      const records = archiveWriter.root?.sinkOrigins;
      archiveFault.original = records?.get(archiveFault.originalOrdinal) ?? null;
      archiveFault.installation = records?.get(archiveFault.installationOrdinal) ?? null;
      return archiveFault;
    },
    releaseArchiveFault() { releaseArchiveFault?.(); },
    archiveSubject(kind, writer, command) {
      if (archiveSubjectChecking) return;
      archiveSubjectChecking = true;
      const before = writer.root.funding.bytes, used = writer.used;
      let reads = 0;
      const foreign = new Proxy({}, { get() { reads++; throw Error('foreign archive subject getter'); } });
      const cases = kind === 'put' ? [[foreign, writer.key, writer.text ?? writer.readable, writer.expiresAt],
        [writer.bucket, 'foreign', foreign, writer.expiresAt], [writer.bucket, writer.key, foreign, writer.expiresAt]]
        : kind === 'pipe' ? [[foreign, writer.writable, writer.signal], [writer.source, foreign, writer.signal], [writer.source, writer.writable, foreign]]
        : [[foreign]];
      try {
        for (const operands of cases) {
          let rejected = false;
          try { command(writer.root.sink, ...operands); } catch { rejected = true; }
          if (!rejected || reads || writer.used !== used || writer.root.funding.bytes !== before) throw Error('foreign archive subject had effects');
        }
      } finally { archiveSubjectChecking = false; }
    },
    archiveClosed(writer, put, pipe, cancel, abort) {
      if (writer.phase !== 3) throw Error('archive phase did not close');
      const before = writer.root.funding.bytes, used = writer.used;
      const commands = [[put, writer.bucket, writer.key, writer.text ?? writer.readable, writer.expiresAt],
        [pipe, writer.source, writer.writable, writer.signal], [cancel, writer.readable], [abort, writer.controller]];
      for (const [command, ...operands] of commands) {
        let rejected = false;
        try { command(writer.root.sink, ...operands); } catch { rejected = true; }
        if (!rejected || writer.used !== used || writer.root.funding.bytes !== before) throw Error('closed archive command replayed');
      }
    },
    archiveActualOriginal(original, writer, kind) {
      const [prefix, target, outcome, reasonKind] = this.consumerMode.split(':');
      if (target !== kind || !['archive-install', 'archive-return'].includes(prefix)) return original;
      return archiveFaultOriginal(original, kind === 'put' ? writer.putCommand : kind === 'pipe' ? writer.pipeCommand : writer.cancelCommand,
        prefix === 'archive-install' ? 'install' : 'return', outcome, reasonKind);
    },
    archivePut(original) {
      if (this.consumerMode !== 'archive-kernel-held') return;
      archive.puts++;
      const then = Promise.prototype.then;
      let release; const gate = new Promise(resolve => { release = resolve; });
      releaseConsumer = () => { archive.released = true; restoreArchiveData?.(); release(); };
      void Reflect.apply(then, original, [() => { archive.nativeSettled++; }, () => { archive.nativeSettled++; }]);
      Object.defineProperty(original, 'then', { value(yes, no) {
        if (this !== original || arguments.length !== 2) throw Error('archive original observer boundary');
        archive.thenCalls++;
        void Reflect.apply(then, original, [async value => { await gate; archive.delivered++; yes(value); }, async reason => { await gate; archive.delivered++; no(reason); }]);
        return undefined;
      } });
    },
    rpcReaders: [],
    rpcReader(reader, kind) {
      if (!this.consumerMode.startsWith('rpc-')) return;
      const row = { kind, reads: 0, thenCalls: 0, reuses: 0, foreignGets: 0, orders: [], duplicateCalls: 0 };
      this.rpcReaders.push(row);
      const read = reader.read, then = Promise.prototype.then;
      let previousBacking;
      const poison = { get done() { row.foreignGets++; throw Error('foreign RPC done'); }, get value() { row.foreignGets++; throw Error('foreign RPC value'); } };
      const duplicates = this.consumerMode === 'rpc-duplicates';
      const releases = releaseConsumer;
      releaseConsumer = () => { previousBacking = undefined; releases?.(); };
      Object.defineProperty(reader, 'read', { value(view) {
        if (this !== reader || arguments.length !== 1) throw Error('RPC read boundary');
        if (previousBacking) { if (view.buffer !== previousBacking) throw Error('RPC lost original BYOB backing'); row.reuses++; }
        row.reads++;
        const original = Reflect.apply(read, this, [view]);
        Object.defineProperty(original, 'then', { value(yes, no) {
          if (this !== original || arguments.length !== 2) throw Error('RPC observer boundary');
          row.thenCalls++;
          void Reflect.apply(then, this, [part => {
            const bytes = part.value, done = part.done, order = [];
            if (row.orders.length < 4) row.orders.push({ done, value: !!bytes, order });
            let values = 0, dones = 0;
            if (bytes) {
              const backing = bytes.buffer, length = bytes.byteLength;
              previousBacking = backing;
              Object.defineProperty(bytes, 'buffer', { get() { order.push('b' + values); return backing; } });
              Object.defineProperty(bytes, 'byteLength', { get() { order.push('n' + values); return length; } });
            }
            yes({ get value() { order.push('v' + ++values); if (duplicates) { row.duplicateCalls++; yes(poison); no(undefined); } return bytes; },
              get done() { order.push('d' + ++dones); return done; } });
            if (duplicates) { row.duplicateCalls++; yes(poison); no(undefined); }
          }, no]);
          return undefined;
        } });
        return original;
      } });
    },
    publicPressure(charge, live, high) {
      if (!charge) throw Error('public capture pressure was not admitted');
      publicReaders.beforeLive = live; publicReaders.beforeHigh = high;
      releaseConsumer = () => charge.release();
    },
    publicRefused(live, high) { publicReaders.refusals++; publicReaders.refusedLive = live; publicReaders.refusedHigh = high; },
    publicCopied() { publicReaders.copies++; },
    publicCapture(live, high, component, sealed) {
      publicReaders.captureCount++; publicReaders.captureTotal += component;
      publicReaders.capturePeak = Math.max(publicReaders.capturePeak, high); publicReaders.liveCapture = live;
      if (sealed) publicReaders.postSeal++;
    },
    publicCaptureReleased(live) { publicReaders.liveCapture = live; publicReaders.handoffs++; },
    statusReaders,
    statusOrigins: [],
    statusFailure(index, offset, record) {
      if (this.consumerMode.startsWith('status-origin:')) this.statusOrigins.push({ index, offset, ...record });
      return record;
    },
    statusReader(reader, index) {
      const row = { read: 0, cancel: 0, unlock: 0, nativeUnlocked: 0, unlockSettled: 0, thenCalls: 0, closed: 0, closedSettled: 0, reasonReads: 0, held: false, retired: false, decided: false };
      statusReaders[index] = row;
      const previous = releaseConsumer;
      if (this.consumerMode.startsWith('status-origin:')) {
        const [, kind, outcome, reasonKind] = this.consumerMode.split(':');
        const first = reasonKind === 'undefined' ? undefined : Object.freeze({ fixture: 'status-original' });
        const second = reasonKind === 'undefined' ? undefined : reasonKind === 'equal' ? first : Object.freeze({ fixture: 'status-installation' });
        const original = { then(yes, no) {
          if (this !== original || arguments.length !== 2) throw Error('status original observer operands');
          row.thenCalls++; assertClosedHandler(yes); assertClosedHandler(no);
          if (outcome === 'reject') no(first); else yes(undefined);
          const poison = { get then() { row.reasonReads++; throw Error('duplicate status payload'); } };
          yes(poison); no(poison); throw second;
        } };
        if (kind === 'closed') {
          const native = reader.closed;
          void Reflect.apply(Promise.prototype.then, native, [() => undefined, () => undefined]);
          Object.defineProperty(reader, 'closed', { value: original });
        } else {
          const unlock = reader.releaseLock;
          Object.defineProperty(reader, 'releaseLock', { value(...args) {
            row.unlock++; if (this !== reader || args.length) throw Error('status unlock operands');
            Reflect.apply(unlock, this, args); row.nativeUnlocked++; return original;
          } });
        }
      } else if (this.consumerMode.startsWith('status-')) faultReader(reader, this.consumerMode.slice(7), row);
      if (releaseConsumer !== previous) statusReleases.push(releaseConsumer);
      releaseConsumer = previous;
    },
    statusDecision(index) { (statusReaders[index] ??= { read: 0, cancel: 0, unlock: 0, retired: false }).decided = true; },
    statusRetired(index) { statusReaders[index].retired = true; },
    adapterReads: { preflight: 0, continuation: 0, materialization: 0 },
    continuationStages: { staged: 0, delivered: 0, advanced: 0, handles: 0 },
    continuationStage(kind) { this.continuationStages[kind]++; },
    adapterReadCompleted(kind) { this.adapterReads[kind]++; },
    intakeCopyLookup() { intakeReaders.operandOrder?.push('set'); },
    capturedIntake(length) { intakeReaders.operandOrder?.push('copy'); intakeReaders.captures = (intakeReaders.captures ?? 0) + 1; intakeReaders.capturedBytes = (intakeReaders.capturedBytes ?? 0) + length; },
    intakeGraph(bytes) { intakeReaders.graphBytes = bytes; },
    intakeConstructed() { if (restoreIngressConstruction) { intakeReaders.constructed++; restoreIngressConstruction(); restoreIngressConstruction = undefined; } },
    mutateIntake() { mutateIntake?.(); },
    startCensus(usageOnly = false) {
      if (current || censusUsage) throw new Error('overlapping scalar census');
      if (usageOnly) censusUsage = true;
      else { const row = this.begin('validator'); this.enter(row); }
    },
    censusDepth(depth) { if (current) current.peakDepth = Math.max(current.peakDepth, depth); },
    census(c, s, a, u, upper, exact, limited) {
      if (censusUsage) {
        usage.census++; usage.maxGraph = Math.max(usage.maxGraph, upper);
        usage.maxContainers = Math.max(usage.maxContainers, c); usage.maxStrings = Math.max(usage.maxStrings, s);
        usage.maxAtoms = Math.max(usage.maxAtoms, a); usage.maxUnits = Math.max(usage.maxUnits, u);
      } else if (current) { current.graph = upper; current.exact = exact; current.limited = limited; }
    },
    censusCleared(clear) {
      if (!clear) throw new Error('scalar census retained text');
      if (current) { const row = current; this.leave(row); row.cleared = true; }
      censusUsage = false;
    },
    censusReceipt(clear, upper, exact, limited, backing, parsing) {
      const row = rows.at(-1);
      if (!clear || current || !row?.cleared) throw new Error('census receipt overlaps native parse');
      row.receiptCleared = true; row.paid = parsing; row.required = backing + upper;
      row.exactDebit = backing + exact; row.limited = limited;
    },
    exactRestored(bytes) { const row = rows.at(-1); if (!row?.nativeParses || bytes !== row.exactDebit) throw new Error('exact debit restored before native success'); row.restored = true; },
    fixedSyntax(error) { if (error.message !== 'invalid owned JSON') throw new Error('unbounded local syntax projection'); rows.at(-1).fixedSyntax = true; return error; },
    syntaxCleared(clear) { if (!clear) throw new Error('native SyntaxError retained'); rows.at(-1).syntaxCleared = true; },
    beforeUsageParse() { if (usage.parsed >= usage.census) throw new Error('native usage parse before census'); usage.parsed++; },
    summary(value) { if (value !== undefined && value !== 'refusal') throw new Error('private summary retained a stop-reason subtree'); usage.summaries++; },
    usageCleared() { usage.cleared++; },
    frozenHandlers(pair) { for (const handler of pair) assertClosedHandler(handler); return pair; },
    driverOrigins: { entered: 0, calls: 0, foreignGets: 0, handlerChecks: 0, records: [], original: null, installation: null },
    driverClosed(native, reader, driver) {
      const name = driver.constructor.name;
      const [prefix, target, outcome, reasonKind] = this.consumerMode.split(':');
      const row = this.driverOrigins;
      if (prefix !== 'driver-origin' || target !== name || row.entered) return native;
      row.entered++; row.driver = name; driverOriginOwners.add(driver);
      const originalReason = reasonKind === 'undefined' ? undefined : Object.freeze({ fixture: 'closed-original' });
      const installationReason = reasonKind === 'undefined' ? undefined : reasonKind === 'equal' ? originalReason : Object.freeze({ fixture: 'closed-installation' });
      const nativeClosed = reader.closed, then = Promise.prototype.then;
      void Reflect.apply(then, nativeClosed, [() => undefined, () => undefined]);
      const original = { then(yes, no) {
        if (this !== original || arguments.length !== 2) throw Error('driver closed observer boundary');
        row.calls++;
        assertClosedHandler(yes); assertClosedHandler(no); row.handlerChecks += 2;
        if (outcome === 'reject') no(originalReason); else yes(undefined);
        const poison = { get then() { row.foreignGets++; throw Error('duplicate payload inspected'); } };
        yes(poison); no(poison);
        throw installationReason;
      } };
      Object.defineProperty(reader, 'closed', { configurable: true, value: original });
      return false;
    },
    driverOrigin(record) {
      if (!this.consumerMode.startsWith('driver-origin:') || !this.driverOrigins.entered) return;
      this.driverOrigins.records.push({ ...record });
    },
    driverClosedFact(driver, installation, record) {
      if (!driverOriginOwners.has(driver)) return;
      this.driverOrigins[installation ? 'installation' : 'original'] = { ...record };
    },
    consumerMode: 'normal',
    previousCodec: undefined,
    consumerCreated() { consumers.created++; },
    replay() { consumers.replay++; },
    transferred(reader) { if (!readers.has(reader)) throw new Error("sniff handoff replaced its original reader"); consumers.transferred++; },
    enqueued(bytes) { consumers.enqueued += bytes.byteLength; if (bytes.buffer.byteLength !== bytes.byteLength) consumers.oversizedOutput++; },
    pricing(delta) { consumers.pricing += delta; if (consumers.pricing < 0) throw new Error("pricing retired twice"); },
    reader(reader) {
      consumers.acquired++; consumers.live++; readers.add(reader);
      if (['publication-fail-held', 'publication-capacity-held'].includes(this.consumerMode)) faultReader(reader, 'unlock-after-success', consumers);
      if (consumers.acquired === 1 || this.consumerMode.startsWith('usage:') || this.consumerMode === 'then-early' || this.consumerMode.startsWith('handoff-')) faultReader(reader, this.consumerMode, consumers);
    },
    publicationEnter(response) {
      if (publication.entered || !this.consumerMode.startsWith('publication-')) return;
      publication.entered = true; publication.active = true;
      const restores = [], mode = this.consumerMode;
      Object.defineProperties(response, {
        status: { configurable: true, get() { publication.trace += 'S;'; return mode === 'publication-producer-fail' ? 99 : publicationApply(publicationStatus, response, []); } },
        statusText: { configurable: true, get() { publication.trace += 'T;'; return mode === 'publication-long-text' ? 'owned-' + 'x'.repeat(16384) : publicationApply(publicationStatusText, response, []); } },
        headers: { configurable: true, get() { publication.trace += 'H;'; return publicationApply(publicationHeader, response, []); } },
      });
      const poison = () => { publication.hooks++; throw Error('private publication operand escaped'); };
      if (mode === 'publication-constructors') {
        const response = globalThis.Response, headers = globalThis.Headers;
        globalThis.Response = poison; globalThis.Headers = poison;
        restores.push(() => { globalThis.Response = response; globalThis.Headers = headers; });
      }
      if (mode === 'publication-methods') for (const name of ['set', 'delete', 'forEach', Symbol.iterator]) {
        const descriptor = Object.getOwnPropertyDescriptor(publicationHeaderPrototype, name);
        Object.defineProperty(publicationHeaderPrototype, name, { configurable: true, get: poison });
        restores.push(() => Object.defineProperty(publicationHeaderPrototype, name, descriptor));
      }
      if (mode === 'publication-next') {
        const iterator = publicationHeaderPrototype.entries.call(new publicationHeaders()), prototype = Object.getPrototypeOf(iterator);
        const descriptor = Object.getOwnPropertyDescriptor(prototype, 'next');
        Object.defineProperty(prototype, 'next', { configurable: true, value: poison });
        restores.push(() => Object.defineProperty(prototype, 'next', descriptor));
      }
      restorePublication = () => { for (const restore of restores) restore(); restorePublication = undefined; };
      const previous = releaseConsumer;
      releaseConsumer = () => { restorePublication?.(); publicationSourceHeaders = undefined; publicationFinalHeaders = undefined; previous?.(); };
    },
    publicationProduced(response) {
      if (!publication.active) return;
      publication.produced++;
      const headers = publicationApply(publicationHeader, response, []), body = publicationApply(publicationBody, response, []);
      const status = publicationApply(publicationStatus, response, []), statusText = publicationApply(publicationStatusText, response, []);
      publicationSourceHeaders = headers;
      for (const [name, value] of [['Set-Cookie', 'one=1; Expires=Wed, 21 Oct 2037 07:28:00 GMT'], ['set-cookie', 'two=2'],
        ['X-Mixed-Case', 'one'], ['x-mixed-case', 'two'], ['X-Unicode', 'héllo'], ['X-Empty', ''],
        ['x-clawrouter-error-code', 'spoof'], ['openai-organization', 'foreign']]) publicationApply(publicationAppend, headers, [name, value]);
      for (const name of ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'trailer', 'transfer-encoding', 'upgrade',
        'x-clawrouter-grant-failover', 'openai-project', 'anthropic-organization-id', 'anthropic-workspace-id'])
        publicationApply(publicationSet, headers, [name, 'fixture']);
      let bodies = 0;
      const mode = this.consumerMode, foreign = mode === 'publication-body-swap' ? new ReadableStream({ cancel() { publication.foreignCancels++; } }) : undefined;
      Object.defineProperties(response, {
        headers: { get() { if (publication.active) publication.trace += 'h;'; return headers; } },
        body: { get() { if (publication.active) { publication.trace += 'b;'; if (++bodies === 2 && foreign) return foreign; } return body; } },
        status: { get() {
          if (publication.active) {
            publication.trace += 's;';
            if (mode === 'publication-status-grow') publicationApply(publicationSet, headers, ['X-Late', 'x'.repeat(8192)]);
          }
          return mode === 'publication-constructor-fail' || mode === 'publication-fail-held' ? 99 : status;
        } },
        statusText: { get() { if (publication.active) publication.trace += 't;'; return mode === 'publication-long-text' ? 'owned-' + 'x'.repeat(16384) : statusText; } },
      });
    },
    publicationProvider(value) { if (publication.active) publication.trace += 'p;'; return value; },
    publicationFund(phase) {
      if (!publication.active) return;
      publication.growCalls++;
      if (phase === 1 && publication.growCalls === 2 && this.consumerMode === 'publication-fund-grow')
        publicationApply(publicationSet, publicationSourceHeaders, ['X-Funding', 'x'.repeat(8192)]);
      if (phase === 2 && this.consumerMode === 'publication-final-grow')
        publicationApply(publicationSet, publicationFinalHeaders, ['X-Final-Funding', 'x'.repeat(8192)]);
      if (phase === 1 && publication.growCalls === 2 && this.consumerMode === 'publication-shrink')
        publicationHeaderPrototype.delete.call(publicationSourceHeaders, 'X-Mixed-Case');
    },
    publicationPressure(charge) {
      if (!charge) throw Error('publication pressure setup'); publicationPressureCharge = charge;
      const previous = releaseConsumer; releaseConsumer = () => { this.publicationRefused(); previous?.(); };
    },
    publicationRefused() { if (publicationPressureCharge) { publication.refused = true; publicationPressureCharge.release(); publicationPressureCharge = undefined; } },
    publicationFinal(headers) { if (publication.active) publicationFinalHeaders = headers; },
    publicationExit(success) {
      if (!publication.active) return;
      publication.published += +success; publication.cleanups += +!success; publication.active = false;
      restorePublication?.(); publicationSourceHeaders = undefined; publicationFinalHeaders = undefined;
    },
    genericReader(reader) {
      generic.acquired++; generic.live++;
      if (['publication-fail-held', 'publication-capacity-held'].includes(this.consumerMode)) faultReader(reader, 'unlock-after-success', generic);
      if (!this.consumerMode.startsWith('generic-')) return;
      const mode = this.consumerMode.slice(8);
      if (!['snapshot', 'after', 'big', 'late', 'copy-normalizer', 'install-before', 'install-after', 'install-reject'].includes(mode)) { faultReader(reader, mode, generic); return; }
      const read = reader.read, then = Promise.prototype.then;
      let release; const held = mode === 'late' || mode.startsWith('install-') ? new Promise(resolve => { release = resolve; releaseConsumer = resolve; }) : undefined;
      reader.read = function (...args) {
        if (this !== reader || args.length) throw Error('generic actual read boundary'); generic.read++;
        const original = Reflect.apply(read, this, args);
        Object.defineProperty(original, 'then', { value(yes, no) {
          if (this !== original || arguments.length !== 2) throw Error('generic actual observer boundary'); generic.thenCalls++;
          if (mode.startsWith('install-')) {
            generic.installs++; generic.held = true;
            void Reflect.apply(then, original, [part => { void held.then(() => yes(part)); }, no]);
            if (mode === 'install-after') yes({ get done() { generic.doneGets++; return true; },
              get value() { generic.eofValues++; throw Error('generic EOF VALUE'); } });
            else if (mode === 'install-reject') no(undefined);
            throw undefined;
          }
          void Reflect.apply(then, original, [part => {
            if (mode === 'late') {
              generic.held = true;
              void held.then(() => yes({ get done() { generic.lateGets++; throw Error('finished late DONE'); },
                get value() { generic.lateGets++; throw Error('finished late VALUE'); } }));
              return;
            }
            let bytes = part.value, calls = 0;
            const done = part.done;
            if (!done && mode === 'copy-normalizer') { bytes = bytes.slice(); generic.copies++; }
            if (!done && mode === 'big') { const large = new Uint8Array(3 * 1024 * 1024 + bytes.byteLength); large.set(bytes); bytes = large.subarray(0, bytes.byteLength); }
            yes({ get done() { generic.doneGets++; generic.trace += 'd'; return done ? 1 : 0; },
              get value() {
                generic.valueGets++; generic.trace += 'v';
                if (done) { generic.eofValues++; throw Error('generic EOF VALUE'); }
                if (++calls !== 1) throw Error('generic repeated VALUE'); return bytes;
              } });
            if (!done && mode === 'after') bytes.fill(33);
            bytes = undefined;
          }, no]);
          return undefined;
        } });
        return original;
      };
    },
    genericRetired() { generic.retired++; generic.live--; },
    normalizerReader(reader) {
      normalizers.acquired++; normalizers.live++;
      if (!this.consumerMode.startsWith('normalizer-')) return;
      const mode = this.consumerMode.slice(11);
      if (mode === 'tiny-empty' || mode === 'sniff-eof' || mode === 'replay-eof') {
        const read = reader.read, then = Promise.prototype.then;
        const event = 'data: {"choices":[],"usage":{"prompt_tokens":4,"completion_tokens":3,"total_tokens":7}}\n\ndata: [DONE]\n\n';
        let offset = 0, turn = 0, wire = new TextEncoder().encode(mode === 'tiny-empty' ? ':\r\n\r\n'.repeat(160) + event : event);
        reader.read = function (...args) {
          if (this !== reader || args.length) throw Error('normalizer actual read boundary');
          normalizers.read++;
          const original = Reflect.apply(read, this, args);
          Object.defineProperty(original, 'then', { value(yes, no) {
            normalizers.thenCalls++;
            void Reflect.apply(then, original, [() => {
              const empty = mode === 'tiny-empty' && turn++ % 2 === 1;
              const done = mode === 'sniff-eof' || offset === wire.length;
              let bytes;
              if (done && mode !== 'sniff-eof') bytes = { get buffer() { throw Error('REPLAY EOF bytes inspected'); } };
              else if (empty) bytes = new Uint8Array(0);
              else { const end = mode === 'tiny-empty' ? offset + 1 : wire.length; bytes = wire.slice(offset, end); offset = end; }
              yes({ get done() { normalizers.doneGets++; normalizers.trace += 'd'; return done ? 1 : 0; },
                get value() { normalizers.valueGets++; normalizers.trace += 'v'; if (done) normalizers.eofValues++; return bytes; } });
              bytes = undefined;
            }, no]);
            return undefined;
          } });
          return original;
        };
        return;
      }
      if (!['trace', 'eof-value', 'large-backing', 'capture-before', 'capture-after'].includes(mode)) {
        faultReader(reader, mode, normalizers); return;
      }
      const read = reader.read, then = Promise.prototype.then;
      reader.read = function (...args) {
        if (this !== reader || args.length) throw Error('normalizer actual read boundary');
        normalizers.read++;
        const original = Reflect.apply(read, this, args);
        Object.defineProperty(original, 'then', { value(yes, no) {
          if (this !== original || arguments.length !== 2) throw Error('normalizer original observer boundary');
          normalizers.thenCalls++;
          void Reflect.apply(then, original, [part => {
            let bytes = part.value;
            const done = part.done;
            if (done && mode === 'eof-value') bytes = { get buffer() { throw Error('EOF bytes inspected'); } };
            if (!done && mode === 'large-backing') {
              const large = new Uint8Array(3 * 1024 * 1024 + bytes.byteLength); large.set(bytes);
              bytes = large.subarray(0, bytes.byteLength);
            }
            if (bytes instanceof Uint8Array) normalizers.maximumBacking = Math.max(normalizers.maximumBacking, bytes.buffer.byteLength);
            if (!done && mode === 'capture-before') bytes[0] = 58;
            yes({ get done() { normalizers.doneGets++; normalizers.trace += 'd'; return done ? 1 : 0; },
              get value() { normalizers.valueGets++; normalizers.trace += 'v'; if (done) normalizers.eofValues++; return bytes; } });
            if (!done && mode === 'capture-after') bytes.fill(33);
            bytes = undefined;
          }, no]);
          return undefined;
        } });
        return original;
      };
    },
    normalizerRetired() { normalizers.retired++; normalizers.live--; },
    sourceReader(reader) {
      sourceReaders.acquired++;
      if (this.consumerMode.startsWith('source-')) faultReader(reader, this.consumerMode.slice(7), sourceReaders);
    },
    publicReader(reader) {
      publicReaders.acquired++; publicReaders.live++;
      if (this.consumerMode === 'generic-copy-public' && generic.acquired) {
        const read = reader.read;
        reader.read = function (...args) {
          if (this !== reader || args.length) throw Error('outer public read boundary');
          return Reflect.apply(read, this, args).then(part => {
            if (part.done) return part;
            generic.copies++; return { done: false, value: part.value.slice() };
          });
        };
      }
      if (this.consumerMode === 'metadata-branded-held' && publicReaders.acquired === 1) faultReader(reader, 'unlock-after-success', publicReaders);
      if (headers.applied && this.consumerMode === 'headers-constructor-held' && !publicReaders.constructorHeld) {
        publicReaders.constructorHeld = true; faultReader(reader, 'unlock-after-success', publicReaders);
      }
      if ((publicReaders.acquired === 1 || this.consumerMode === 'public-then-early' || this.consumerMode.startsWith('public-handoff-')) && this.consumerMode.startsWith('public-')) faultReader(reader, this.consumerMode.slice(7), publicReaders);
    },
    intakeReader(reader, owner) {
      intakeReaders.acquired++; intakeReaders.live++;
      if (intakeReaders.acquired === 1 && this.consumerMode.startsWith('intake-')) faultReader(reader, this.consumerMode.slice(7), intakeReaders, owner);
    },
    intakeRetiredReader() { intakeReaders.retired++; if (--intakeReaders.live < 0) throw new Error('intake reader retired twice'); },
    publicRetiredReader() { publicReaders.retired++; if (--publicReaders.live < 0) throw new Error('public reader retired twice'); },
    releaseConsumer() { consumers.released = true; releaseConsumer?.(); releaseConsumer = undefined; mutateIntake = undefined; for (const release of statusReleases) release(); statusReleases.length = 0; },
    retiredReader() { consumers.retired++; if (--consumers.live < 0) throw new Error('consumer reader retired twice'); },
    wrapper(publicBoundary) { if (publicBoundary) consumers.outer++; else consumers.inner++; },
    accounting(delta) {
      preparations += delta;
      if (preparations < 0) throw new Error('preparation accounting retired twice');
    },
    begin(kind = 'materializer') {
      if (preparations !== 0) throw new Error('unused preparation accounting survived into codec');
      const row = { kind, peakDepth: 0, nativeParses: 0, graph: 0, statusPending: statusReaders.filter(value => value.held && !value.retired).length,
        parents: 0, tokens: 0, pending: false, member: false, peakParents: 0, peakTokens: 0, peakStored: 2, peakActive: 2, peakBetween: 2, peakRejected: 0,
        parentPushes: 0, parentPops: 0, tokenPushes: 0, tokenPops: 0, attachments: 0, objectAttachments: 0, cleared: false,
        consumerReaders: consumers.live, pricingOwners: consumers.pricing, innerWrappers: consumers.inner, outerWrappers: consumers.outer };
      rows.push(row); return row;
    },
    validating(row, depth) { row.peakDepth = Math.max(row.peakDepth, depth); },
    validated(row, graph) { row.graph = graph; },
    validatorCleared(row, clear) {
      if (!clear) throw new Error('validator retained a tokenizer, callback or text alias');
      row.abandonedTokens = row.tokens; row.tokens = 0; row.cleared = true;
    },
    nativeParse() {
      const row = rows.at(-1);
      if (current || !row || row.kind !== 'validator' || !row.cleared || !row.receiptCleared || row.required > row.paid || row.limited || row.nativeParses)
        throw new Error('native graph constructor overlaps validator or lacks admission');
      row.nativeParses++;
    },
    enter(row) { if (row) { if (current) throw new Error('nested fixture parser observation'); current = row; } },
    leave(row) { if (row) { if (current !== row) throw new Error('fixture parser observation mismatch'); current = undefined; peak(row); } },
    rejected(row) { if (row) row.peakRejected = Math.max(row.peakRejected, (row.kind === 'validator' ? 1 : 2) + row.parents + row.tokens + Number(row.pending) + Number(row.member)); },
    consumer(row, parents, pending) {
      if (!row) return;
      if (parents > row.parents) row.parentPushes += parents - row.parents;
      else row.parentPops += row.parents - parents;
      row.parents = parents; row.pending = pending; peak(row);
    },
    attaching(row, member) { if (row) { row.member = member; peak(row); } },
    attached(row, kind, exists, emptyPending, emptyMember) {
      if (!row) return;
      if (!(exists && emptyPending && emptyMember)) throw new Error('key cleared before actual attachment or retained afterward');
      row.attachments++; if (kind === 2) row.objectAttachments++;
      row.pending = false; row.member = false;
    },
    tokenizer(depth) {
      if (!current) return;
      if (depth > current.tokens) current.tokenPushes += depth - current.tokens;
      else current.tokenPops += current.tokens - depth;
      current.tokens = depth; peak(current);
    },
    discard(row, emptyParents, emptyKey, emptyScalar, emptyRoot, detachedTokenizer) {
      if (!row || row.cleared) return;
      if (!(emptyParents && emptyKey && emptyScalar && emptyRoot && detachedTokenizer)) throw new Error('private parser retained an application alias');
      row.abandonedParents = row.parents; row.abandonedTokens = row.tokens;
      row.parents = 0; row.tokens = 0; row.pending = false; row.member = false; row.cleared = true;
    },
  };
}

const probe = 'globalThis.__ownedJsonObservation';
function replace(source, anchor, replacement, count = 1) {
  assert.equal(source.split(anchor).length - 1, count, 'fixed original parser observer anchor: ' + anchor);
  return source.replaceAll(anchor, replacement);
}

export function observeOwnedJsonSource(path, source) {
  const handlerSites = { 'proxy-completion.ts': 1, 'http-identity-owner.ts': 6, 'credential-preflight-source.ts': 2,
    'identity-admission.ts': 2, 'proxy.ts': 1 }[path.split(/[\\/]/).at(-1)];
  if (handlerSites) {
    let sites = 0;
    source = source.replace(/\[freezeOwnedObserver\([^\n]+?, freezeOwnedObserver\([^\n]+?\)\]/g,
      pair => { sites++; return probe + '.frozenHandlers(' + pair + ')'; });
    assert.equal(sites, handlerSites, 'exact exposed observer pair inventory');
  }

  if (/[\\/]worker[\\/]credential-preflight-source\.ts$/.test(path)) {
    source = replace(source, 'if (owned) await owned.read(backing!);',
      'if (owned) { await owned.read(backing!); ' + probe + '.adapterReadCompleted(owned.kind); }');
    source = replace(source, '      this.result = closed;', '      this.result = closed; ' + probe + '.continuationStage("staged");');
    source = replace(source, '      this.destination!.continuationSource = this.budget;',
      '      this.destination!.continuationSource = this.budget; ' + probe + '.continuationStage("delivered");');
  } else if (/[\\/]worker[\\/]credential-cache\.ts$/.test(path)) {
    source = replace(source, '    return 8 * (containers + 2 * members + entries + values) + 2 * units + 6 * run.command.key.length;',
      '    ' + probe + '.credentialCensuses.push({ containers, members, entries, values, units, keyUnits: run.command.key.length, completion: run.completion, originalCleared: run.original === undefined, retained: run.retained, borrowed: !!run.borrowed }); return 8 * (containers + 2 * members + entries + values) + 2 * units + 6 * run.command.key.length;');
  } else if (/[\\/]worker[\\/]credential-preflight\.ts$/.test(path)) {
    source = replace(source, '  owner.stagedPreflight = reply; owner.preflightDelivered = true;',
      '  owner.stagedPreflight = reply; owner.preflightDelivered = true; ' + probe + '.preflightTransfers.staged++;');
    source = replace(source, '  owner.stagedPreflight = undefined;\n  return reply;',
      '  owner.stagedPreflight = undefined; ' + probe + '.preflightTransfers.taken++; return reply;');
    source = replace(source, '    advanceIdentitySource(owner.source, sent, reply.source, replySource);',
      '    if (http) { if (owner.stagedPreflight !== undefined || owner.preflightDelivered !== true) throw Error("preflight staged alias not consumed"); ' + probe + '.preflightTransfers.advanced++; } advanceIdentitySource(owner.source, sent, reply.source, replySource);');
    source = replace(source, '    httpCredentials.set(cap, owner); (httpForegroundReservations ??= new WeakMap()).set(http, cap);',
      '    httpCredentials.set(cap, owner); (httpForegroundReservations ??= new WeakMap()).set(http, cap); ' + probe + '.foreground(owner);');
    source = replace(source, '    owner.lease.replace(bytes); owner.reduction = 2;',
      '    const __before = owner.lease.bytes; let __rejected = 0; for (const __args of [[{}, request, cap, permit], [http, request, {}, permit], [http, request, cap, {}], [http, request, cap, permit]]) { try { reduceOwnedHttpPreparedCredential(...__args as [OwnedHttpRequest, Request, OwnedHttpCredential, object]); } catch { __rejected++; } } if (__rejected !== 4 || owner.lease.bytes !== __before) throw Error("retained transition reentry/foreign changed charge"); owner.lease.replace(bytes); owner.reduction = 2; try { reduceOwnedHttpPreparedCredential(http, request, cap, permit); throw Error("duplicate retained transition accepted"); } catch (__error) { if (!isIdentityFailure(__error) || owner.lease.bytes !== bytes) throw __error; } ' + probe + '.credentialReductions.push({ before: __before, after: owner.lease.bytes, bytes, idUnits: owner.id.length, rejections: __rejected + 1 });');
    source = replace(source, '    advanceIdentitySource(owner.source, sent, reply.source, replySource!);',
      '    advanceIdentitySource(owner.source, sent, reply.source, replySource!); if (owner.http) ' + probe + '.continuationStage("advanced");');
    source = replace(source, '    admissions.set(handle, owner); retained = true;',
      '    admissions.set(handle, owner); retained = true; if (owner.http) ' + probe + '.continuationStage("handles");');
  } else if (/[\\/]worker[\\/]identity-admission\.ts$/.test(path)) {
    source = replace(source, 'if (owned) await owned.read(backing);',
      'if (owned) { await owned.read(backing); ' + probe + '.adapterReadCompleted("materialization"); }');
  } else if (/[\\/]worker[\\/]venice-chat-runtime\.ts$/.test(path)) {
    source = replace(source, 'let census: ReturnType<typeof measurePrivateJsonBody> | undefined = measurePrivateJsonBody(text);',
      probe + '.startCensus(); let census: ReturnType<typeof measurePrivateJsonBody> | undefined = measurePrivateJsonBody(text);');
    source = replace(source, '  census = undefined;',
      '  census = undefined; ' + probe + '.censusReceipt(census === undefined, upper, exact, limited, backing, parsing);');
    source = replace(source, 'try { value = JSON.parse(text); }', 'try { ' + probe + '.nativeParse(); value = JSON.parse(text); }');
    source = replace(source, '    codecPhase(state, backing + exact);',
      '    codecPhase(state, backing + exact); ' + probe + '.exactRestored(backing + exact);');
    source = replace(source, '      error = undefined;', '      error = undefined; ' + probe + '.syntaxCleared(error === undefined);');
    source = replace(source, 'new Error("invalid owned JSON")', probe + '.fixedSyntax(new Error("invalid owned JSON"))', 2);
    source = replace(source, 'this.reader = (this.flags & 8) ? this.body.getReader({ mode: "byob" }) : this.body.getReader();',
      'this.reader = (this.flags & 8) ? this.body.getReader({ mode: "byob" }) : this.body.getReader(); ' + probe + '.sourceReader(this.reader);');
  } else if (/[\\/]worker[\\/]proxy-completion\.ts$/.test(path)) {
    source = replace(source, '  protected observeDriverClosed(native: boolean): void {',
      '  protected observeDriverClosed(native: boolean): void { native = ' + probe + '.driverClosed(native, this.reader, this);');
    source = replace(source, 'const failure = this.recordDriverFailure("closed", reason);',
      'const failure = this.recordDriverFailure("closed", reason); ' + probe + '.driverClosedFact(this, false, failure);');
    source = replace(source, 'if (started && this.closedObservation?.owner === this) this.closedObservation.installationFailure = failure;',
      'if (started && this.closedObservation?.owner === this) { this.closedObservation.installationFailure = failure; ' + probe + '.driverClosedFact(this, true, failure); }');
    source = replace(source, 'return counter.units;', probe + '.headerUnits(counter.units); return counter.units;');
    source = replace(source, 'return new ownedHeadersConstructor(headers);', probe + '.metadataFactory(); return new ownedHeadersConstructor(headers);');
    source = replace(source, 'return new ownedResponseConstructor(source.body,', probe + '.metadataFactory(); return new ownedResponseConstructor(source.body,');
    source = replace(source, 'return new ownedResponseConstructor(body, { __proto__: null, status, statusText, headers } as ResponseInit);',
      probe + '.headerConstructor(); ' + probe + '.metadataFactory(); const __response = new ownedResponseConstructor(body, { __proto__: null, status, statusText, headers } as ResponseInit); ' + probe + '.headerConstructed(); return __response;');
    source = 'import { bodyBudgetCharged as __sharedCharged, bodyBudgetBytes as __sharedLimit } from "./body-budget.ts";\n' + source;
    source = replace(source, 'const charge = ExactBodyCharge.reserve(65536);',
      'if (' + probe + '.consumerMode === "shared-refusal" && !' + probe + '.shared.refused) ' + probe + '.sharedPressure(ExactBodyCharge.reserve(__sharedLimit - __sharedCharged() - 65535)); '
      + 'const __beforeShared = __sharedCharged(); const charge = ExactBodyCharge.reserve(65536);');
    source = replace(source, 'if (!charge) return false;',
      'if (!charge) { ' + probe + '.sharedRefused(__beforeShared, __sharedCharged()); return false; }');
    source = replace(source, 'ownedHttpStaticCharge = charge;',
      'ownedHttpStaticCharge = charge; ' + probe + '.sharedClaim(__beforeShared, __sharedCharged(), charge.bytes);');
    source = replace(source, '  body?: ReadableStream<Uint8Array>;', '  body: ReadableStream<Uint8Array> | undefined = (' + probe + '.driverFactory(), undefined);');
    source = replace(source, '    this.pending |= 1; this.seen &= ~1; this.readDelivered = false; this.readFailure = undefined;',
      '    ' + probe + '.driverRead(); this.pending |= 1; this.seen &= ~1; this.readDelivered = false; this.readFailure = undefined;');
  } else if (/[\\/]worker[\\/]json-body\.ts$/.test(path)) {
    source = replace(source, 'const backing = ownedBytes ? newOwnedBytes(32768) : new Uint8Array(32768);',
      'if (ownedBytes) ' + probe + '.archiveEnter(); const backing = ownedBytes ? newOwnedBytes(32768) : new Uint8Array(32768);');
    source = replace(source, 'if (ownedBytes) enqueueOwnedBytes(controller, ownedByteSubarray(backing, 0, written));',
      'if (ownedBytes) { enqueueOwnedBytes(controller, ownedByteSubarray(backing, 0, written)); ' + probe + '.archiveChunk(ownedByteLength(backing)); }');
    source = replace(source, '          } catch (error) { release(); controller.error(error); }',
      '          } catch (error) { release(); controller.error(error); } finally { if (ownedBytes) ' + probe + '.archiveExit(); }');
    source = replace(source, 'if (++depth > 128) limited = true;',
      'depth++; ' + probe + '.censusDepth(depth); if (depth > 128) limited = true;');
    source = replace(source, '    return { upper: 16 * (containers + strings + atoms) + 2 * rawUnits,',
      '    ' + probe + '.census(containers, strings, atoms, rawUnits, 16 * (containers + strings + atoms) + 2 * rawUnits, 8 * (2 * (containers + strings - keys + atoms) - 1 + keys) + 2 * decodedUnits, limited); return { upper: 16 * (containers + strings + atoms) + 2 * rawUnits,');
    source = replace(source, '  } finally { text = ""; characterIndex[0] = 0; }',
      '  } finally { text = ""; characterIndex[0] = 0; ' + probe + '.censusCleared(text === ""); }');
    source = replace(source, 'let pendingKey: string | undefined;',
      'let pendingKey: string | undefined; const __parserProbe = privateParents ? ' + probe + '.begin() : undefined;');
    source = replace(source, 'parent = parents.length ? parents[parents.length - 1] : undefined; member = pendingKey;',
      'parent = parents.length ? parents[parents.length - 1] : undefined; member = pendingKey; ' + probe + '.attaching(__parserProbe, member !== undefined);');
    source = replace(source, 'if (parents) { pendingKey = undefined; member = undefined; }',
      'if (parents) { const __attached = !parent ? root === value : ownedArchiveArray(parent) ? parent[parent.length - 1] === value : ownedArchiveOwn(parent, member!) && parent[member!] === value; '
      + 'pendingKey = undefined; member = undefined; ' + probe + '.attached(__parserProbe, !parent ? 0 : ownedArchiveArray(parent) ? 1 : 2, __attached, pendingKey === undefined, member === undefined); }');
    source = replace(source, 'if (parents) ownedArchiveProperty(parents, parents.length,\n          { __proto__: null, value, writable: true, enumerable: true, configurable: true } as PropertyDescriptor);',
      'if (parents) { ownedArchiveProperty(parents, parents.length, { __proto__: null, value, writable: true, enumerable: true, configurable: true } as PropertyDescriptor); ' + probe + '.consumer(__parserProbe, parents.length, pendingKey !== undefined); }');
    source = replace(source, 'if (parents) { if (parents.length) parents.length--; }',
      'if (parents) { if (parents.length) parents.length--; ' + probe + '.consumer(__parserProbe, parents.length, pendingKey !== undefined); }');
    source = replace(source, 'if (parents) pendingKey = scalar;',
      'if (parents) { pendingKey = scalar; ' + probe + '.consumer(__parserProbe, parents.length, true); }');
    source = replace(source, '(parents ?? stack!).length = 0;',
      '(parents ?? stack!).length = 0; if (__parserProbe) ' + probe + '.discard(__parserProbe, parents?.length === 0, pendingKey === undefined, scalar === "", root === undefined, consume === undefined);');
    source = replace(source, 'for (let offset = 0; offset < text.length; offset += 4096) consume.push(text.slice(offset, offset + 4096));',
      'if (__parserProbe) ' + probe + '.enter(__parserProbe); try { for (let offset = 0; offset < text.length; offset += 4096) consume.push(text.slice(offset, offset + 4096)); } catch (__rejected) { if (__parserProbe) ' + probe + '.rejected(__parserProbe); throw __rejected; } finally { if (__parserProbe) ' + probe + '.leave(__parserProbe); }');
    source = replace(source, 'try { consume.end(); return root; }\n    finally { discard(); }',
      'if (__parserProbe) ' + probe + '.enter(__parserProbe); try { consume.end(); return root; }\n    finally { if (__parserProbe) ' + probe + '.leave(__parserProbe); discard(); }');
  } else if (/[\\/]worker[\\/]proxy-accounting\.ts$/.test(path)) {
    source = replace(source, '    const cap = Object.freeze(Object.create(OwnedHttpAccountingCommand.prototype))',
      '    globalThis.__ownedTerminalFixture?.factoryEnd(); const cap = Object.freeze(Object.create(OwnedHttpAccountingCommand.prototype))');
    source = replace(source, '      accountingSinks(env, options.ownedHttp), context, context.waitUntil?.bind(context), options.completion!.fork(), preparation);',
      '      (globalThis.__ownedTerminalFixture?.factoryBegin(), accountingSinks(env, options.ownedHttp)), context, context.waitUntil?.bind(context), options.completion!.fork(), preparation);');
    source = replace(source, '  try { event = accountingReceipt(state.factsCell.current, outcome); }',
      '  try { globalThis.__ownedTerminalFixture?.receipt(false); event = accountingReceipt(state.factsCell.current, outcome); }');
    source = replace(source, '      event = accountingReceipt(state.factsCell.current, { ...outcome, tokens: null, characterEstimate: null,',
      '      globalThis.__ownedTerminalFixture?.receipt(true); event = accountingReceipt(state.factsCell.current, { ...outcome, tokens: null, characterEstimate: null,');
    source = replace(source, '  return startOwnedHttpAccountingTerminal(state.http, cap, state.sinks, outcome.reservation, event, state.custody);',
      '  globalThis.__ownedTerminalFixture?.validate(state.http, cap, state.sinks, outcome.reservation, event, state.custody);\n'
      + '  return startOwnedHttpAccountingTerminal(state.http, cap, state.sinks, outcome.reservation, event, state.custody);');
    source = replace(source, '  state.terminalOutcome = undefined; state.terminalEvent = undefined; state.terminalReservation = undefined;',
      '  globalThis.__ownedTerminalFixture?.clear(state.terminalOutcome !== undefined, !!(state.state & 16)); '
      + 'state.terminalOutcome = undefined; state.terminalEvent = undefined; state.terminalReservation = undefined;');
    source = replace(source, '    records.push(cap);',
      '    records.push(cap); if (preparation) ' + probe + '.accounting(1);');
    source = replace(source, '  unbindOwnedAccountingPlan(state.factsCell.current.cost);',
      '  if (state.state & 1) ' + probe + '.accounting(-1); unbindOwnedAccountingPlan(state.factsCell.current.cost);');
  } else if (/[\\/]worker[\\/]http-identity-owner\.ts$/.test(path)) {
    source = replace(source, '    const error = { __proto__: null, code, message };',
      '    ' + probe + '.initialErrors.renderings++; ' + probe + '.initialErrorHooks(); const error = { __proto__: null, code, message };');
    source = replace(source, '    const text = ownedErrorStringify(envelope);',
      '    let text; try { text = ownedErrorStringify(envelope); } finally { ' + probe + '.initialErrorDone(); }');
    source = replace(source, '  try { installOwnedOriginalMethod(cell, original, original.then); }',
      '  globalThis.__ownedProvenanceFixture?.capture(cell); try { installOwnedOriginalMethod(cell, original, original.then); }');
    source = replace(source, '  if (root.unknown) return false;\n  const funding = root.funding.replace(root.funding.bytes - bytes);',
      '  globalThis.__ownedAckPhaseFixture?.beforeCredit(root, bytes); if (root.unknown) { globalThis.__ownedAckPhaseFixture?.afterCredit(root, false); return false; }\n  const funding = root.funding.replace(root.funding.bytes - bytes);');
    source = replace(source, '  root.funding = funding;\n  return true;\n}\n\ntype OwnedLedgerResult',
      '  root.funding = funding; globalThis.__ownedAckPhaseFixture?.afterCredit(root, true);\n  return true;\n}\n\ntype OwnedLedgerResult');
    source = replace(source, '    this.response = response;\n  }\n  dispatchOriginal(cell: OwnedOriginalObservation, failed: boolean, value: unknown): void {\n    if (cell !== this.cancelObservation',
      '    this.response = response; globalThis.__ownedAckPhaseFixture?.ack(this);\n  }\n  dispatchOriginal(cell: OwnedOriginalObservation, failed: boolean, value: unknown): void {\n    if (cell !== this.cancelObservation');
    source = replace(source, '[freezeOwnedObserver(ackReadFulfilled.bind(observation)), freezeOwnedObserver(ackReadRejected.bind(observation))]',
      '(globalThis.__ownedAckPhaseFixture ? globalThis.__ownedAckPhaseFixture.read(observation, freezeOwnedObserver(ackReadFulfilled.bind(observation)), freezeOwnedObserver(ackReadRejected.bind(observation))) : [freezeOwnedObserver(ackReadFulfilled.bind(observation)), freezeOwnedObserver(ackReadRejected.bind(observation))])');
    source = replace(source, '    if (this.parent && !this.parent.handoffAck(this)) return;',
      '    globalThis.__ownedAckPhaseFixture?.beforeCut(this); if (this.parent && !this.parent.handoffAck(this)) return;');
    source = replace(source, '    const owner = this.owner!, slot = this.slot, root = this.root;',
      '    const owner = this.owner!, slot = this.slot, root = this.root; const __ackPhysical = owner.physical;');
    source = replace(source, '    delete this.owner; delete this.slot;',
      '    delete this.owner; delete this.slot; globalThis.__ownedAckPhaseFixture?.retired(this, owner, __ackPhysical);');
    source = replace(source, '    this.joinState = 262144; this.schedule();',
      '    this.joinState = 262144; globalThis.__ownedAckPhaseFixture?.afterCut(this); this.schedule();');
    source = replace(source, '    delete ended.plan; delete ended.attempt; delete ended.accounting; delete ended.http;',
      '    delete ended.plan; delete ended.attempt; delete ended.accounting; delete ended.http; globalThis.__ownedAckPhaseFixture?.budget(this);');
    source = replace(source, '[freezeOwnedObserver(ownedOriginalFulfilled.bind(cell)), freezeOwnedObserver(ownedOriginalRejected.bind(cell))]',
      probe + '.retainOriginalHandlers(cell, freezeOwnedObserver(ownedOriginalFulfilled.bind(cell)), freezeOwnedObserver(ownedOriginalRejected.bind(cell)))');
    source = replace(source, '  constructor(cap: OwnedHttpRequest, root: RequestOwner, sink: OwnedHttpSinkOwner) {\n    this.cap = cap; this.root = root; this.sink = sink;\n    this.result',
      '  constructor(cap: OwnedHttpRequest, root: RequestOwner, sink: OwnedHttpSinkOwner) {\n    this.cap = cap; this.root = root; this.sink = sink;\n    globalThis.__ownedTerminalFixture?.shell(); this.result');
    source = replace(source, '  root.accountingTerminal = new OwnedAccountingTerminal(cap, root, root.sink!);',
      '  root.accountingTerminal = new OwnedAccountingTerminal(cap, root, root.sink!); globalThis.__ownedTerminalFixture?.prepared(); globalThis.__ownedAckPhaseFixture?.terminal(root.accountingTerminal);');
    source = replace(source, '  const root = requestOwner(cap), sink = root.sink!, terminal = root.accountingTerminal;',
      '  globalThis.__ownedTerminalFixture?.enter(); const root = requestOwner(cap), sink = root.sink!, terminal = root.accountingTerminal;');
    source = replace(source, '  adoptOwnedHttpAccountingTerminal(cap, accounting, event, reservation);',
      '  adoptOwnedHttpAccountingTerminal(cap, accounting, event, reservation); globalThis.__ownedTerminalFixture?.adopted(cap, accounting, sinks, reservation, event, custody);');
    source = replace(source, '  terminal.failPreparation();', '  terminal.failPreparation(); globalThis.__ownedTerminalFixture?.failed();');
    source = replace(source, '  try { root.budgetSequence?.close(); }',
      '  try { root.budgetSequence?.close(); globalThis.__ownedTerminalFixture?.close(); }');
    source = replace(source, '  try { custody.startPrivateLeaf(() => terminal.retired); }',
      '  try { custody.startPrivateLeaf(() => terminal.retired); globalThis.__ownedTerminalFixture?.installed(); }');
    source = replace(source, '  try { terminal.start(); }',
      '  try { globalThis.__ownedTerminalFixture?.launching(); terminal.start(); globalThis.__ownedTerminalFixture?.started(); }');
    source = replace(source, '  try { failedSinkOrigin(root, origin, reason); } catch { root.unknown = true; }',
      '  try { failedSinkOrigin(root, origin, reason); globalThis.__ownedTerminalFixture?.diagnostic(sinkKinds[origin % 32], reason === undefined); } catch { root.unknown = true; }');
    source = replace(source, '  const admitted = plan as BudgetReservationPlan & BudgetReservation | undefined;',
      '  globalThis.__ownedBudgetSequenceFixture?.beforePlan(plan); const admitted = plan as BudgetReservationPlan & BudgetReservation | undefined;');
    source = replace(source, '  leg.flags |= 1; return leg.cap;',
      '  leg.flags |= 1; globalThis.__ownedBudgetSequenceFixture?.reserveClaimed(sink, intent, ordinal, leg.cap); return leg.cap;');
    source = replace(source, '  leg.flags |= 2; leg.reservation = reservation;',
      '  leg.flags |= 2; leg.reservation = reservation; globalThis.__ownedBudgetSequenceFixture?.accepted();');
    source = replace(source, '  sequence.result = result; sequence.phase = rollback ? 3 : 2;',
      '  sequence.result = result; sequence.phase = rollback ? 3 : 2; globalThis.__ownedBudgetSequenceFixture?.branch(rollback, sink);');
    source = replace(source, '  leg.flags |= 32;\n}\nfunction admittedOwnedBudgetCommand',
      '  leg.flags |= 32; globalThis.__ownedBudgetSequenceFixture?.queueClaimed(sink, cap);\n}\nfunction admittedOwnedBudgetCommand');
    source = replace(source, '  sequence.close();\n}\nfunction ownedBudgetReservationLeg',
      '  sequence.close(); globalThis.__ownedBudgetSequenceFixture?.finished(sink);\n}\nfunction ownedBudgetReservationLeg');
    source = replace(source, '  const funding = root.funding.replace(root.funding.bytes + legs * ledger\n    + Math.max(legs * ledger, rollback * (ledger + queue)) + metadata);\n  if (!funding) throw identityFailure("limit");',
      '  globalThis.__ownedBudgetSequenceFixture?.prepay(legs * ledger + Math.max(legs * ledger, rollback * (ledger + queue)) + metadata);\n'
      + '  const funding = root.funding.replace(root.funding.bytes + legs * ledger\n    + Math.max(legs * ledger, rollback * (ledger + queue)) + metadata);\n'
      + '  if (!funding) { globalThis.__ownedBudgetSequenceFixture?.refused(); throw identityFailure("limit"); }');
    source = replace(source, '  try { sequence.prepare(); }',
      '  try { sequence.prepare(); globalThis.__ownedBudgetSequenceFixture?.prepared(sequence); }');
    source = replace(source, '  publication.phase = 1;\n}\nexport function forwardOwnedHttpGenericUsage',
      '  publication.phase = 1; ' + probe + '.publicationEnter(source); ' + probe + '.publicationProduced(source);\n}\nexport function forwardOwnedHttpGenericUsage');
    source = replace(source, 'publication.source = output; publication.phase = 1;',
      'publication.source = output; publication.phase = 1; ' + probe + '.publicationProduced(output);', 2);
    source = replace(source, '  growOwnedHttpRequest(http, bytes);\n  if (ownedProxyPublication(http, source, phase)',
      '  ' + probe + '.publicationFund(phase); '
      + 'if (' + probe + '.consumerMode === "publication-capacity-held" && ' + probe + '.consumers.publication.growCalls === 2) '
      + probe + '.publicationPressure(ExactBodyCharge.reserve(__publicLimit - __publicCharged() - 1)); '
      + 'try { growOwnedHttpRequest(http, bytes); } catch (__failure) { ' + probe + '.publicationRefused(); throw __failure; }\n  if (ownedProxyPublication(http, source, phase)');
    source = replace(source, '  const publication = ownedProxyPublication(http, source, 2);\n  if (body !== publication.body',
      '  ' + probe + '.publicationFinal(headers); const publication = ownedProxyPublication(http, source, 2);\n  if (body !== publication.body');
    source = replace(source, '  publication.output = output; publication.phase = 3; return output;',
      '  publication.output = output; publication.phase = 3; ' + probe + '.consumers.publication.bytes = publication.admittedBytes; return output;');
    source = replace(source, '      owner.publication = undefined;',
      '      if (owner.publication) ' + probe + '.consumers.publication.retired++; owner.publication = undefined;');

    source = replace(source, '  try { funding = ExactBodyCharge.reserve(requestMetadataBytes); }',
      '  if (' + probe + '.consumerMode === "bootstrap-refuse" && !' + probe + '.initialErrors.bootstrapRefused) ' + probe + '.entryPressure(ExactBodyCharge.reserve(__publicLimit - __publicCharged() - requestMetadataBytes + 1)); try { funding = ExactBodyCharge.reserve(requestMetadataBytes); }');
    source = replace(source, '  if (!funding) return undefined;',
      '  if (!funding) { ' + probe + '.initialErrors.bootstrapRefused++; return undefined; }');
    source = replace(source, '    owner.sinkOrigins!.set(ordinal, record); sinkFailures!.add(record);', '    owner.sinkOrigins!.set(ordinal, record); sinkFailures!.add(record); ' + probe + '.driverOrigin(record); ' + probe + '.archiveFact(owner, record);');
    source = replace(source, '    const owner = new OwnedHttpRequestReceiver();',
      '    ' + probe + '.initialErrors.owners++; const owner = new OwnedHttpRequestReceiver();');
    source = replace(source, '  owner.errorState = 1;',
      '  owner.errorState = 1; if (' + probe + '.consumerMode === "initial-error-refuse" && !' + probe + '.initialErrors.refusals) { ' + probe + '.initialErrors.refusals++; ' + probe + '.entryPressure(ExactBodyCharge.reserve(__publicLimit - __publicCharged())); }');
    source = 'import { markLocalError as __metadataMark } from "./native-errors.ts";\nimport { setBackgroundRecovery as __metadataBackground } from "./correlation.ts";\n' + source;
    source = replace(source, '  growOwnedHttpRequest(cap, 8192 + 2 * path.length + 2 * requestId.length);',
      probe + '.metadataInput(response, request, env, __metadataMark, __metadataBackground); growOwnedHttpRequest(cap, 8192 + 2 * path.length + 2 * requestId.length);');
    source = replace(source, '  state.busy = true;', '  state.busy = true; ' + probe + '.metadataStage(stage);');
    source = replace(source, '  growOwnedHttpRequest(cap, bytes);',
      '  if (' + probe + '.consumerMode === "metadata-refuse-" + stage && ' + probe + '.metadata.refused < 0) ' + probe + '.metadataPressure(stage, ExactBodyCharge.reserve(__publicLimit - __publicCharged() - bytes + 1)); try { growOwnedHttpRequest(cap, bytes); } catch (__refused) { ' + probe + '.metadataRefused(); throw __refused; }');
    source = replace(source, 'const copy = inheritOwnedLocalError(response, newOwnedResponse(stream, status, statusText, headers));',
      probe + '.headerAdmission(component, headerBytes); const copy = inheritOwnedLocalError(response, newOwnedResponse(stream, status, statusText, headers));');
    source = replace(source, '    original = bucket.put(key, value, { httpMetadata: { contentType: "application/json" }, customMetadata: { expiresAt } });',
      '    original = bucket.put(key, value, { httpMetadata: { contentType: "application/json" }, customMetadata: { expiresAt } }); ' + probe + '.archivePut(original);');
    for (const kind of ['Put', 'Pipe', 'Cancel', 'Abort']) {
      const start = source.indexOf('export function ownedHttpArchive' + kind + '(');
      const marker = '  const writer = archiveWriter(sink);';
      const at = source.indexOf(marker, start);
      if (start < 0 || at < 0) throw Error('archive subject hook missing: ' + kind);
      source = source.slice(0, at) + marker + ' ' + probe + '.archiveSubject("' + kind.toLowerCase() + '", writer, ownedHttpArchive' + kind + ');' + source.slice(at + marker.length);
    }
    source = replace(source, '      this.phase = 3;\n    }\n    if (primary) throw primary;',
      '      this.phase = 3; ' + probe + '.archiveClosed(this, ownedHttpArchivePut, ownedHttpArchivePipe, ownedHttpArchiveCancel, ownedHttpArchiveAbort);\n    }\n    if (primary) throw primary;');
    source = replace(source, 'writer.phase = 1; return writer;', 'writer.phase = 1; ' + probe + '.archivePrepared(writer); return writer;');
    source = replace(source, '    return this.writing = this.execute();', '    this.writing = this.execute(); ' + probe + '.archiveWriting(this, this.writing, ownedHttpFailureMetadata); return this.writing;');
    source = replace(source, 'if (!this.primary) { this.readable = this.fixed.readable; await ownedHttpArchivePut',
      'if (!this.primary) { this.readable = this.fixed.readable; ' + probe + '.archiveReadable(this); await ownedHttpArchivePut');
    source = replace(source, 'try { await ownedHttpArchiveCancel(this.root.sink!, operand); }',
      'try { ' + probe + '.archivePrimary(primary, ownedHttpFailureMetadata); await ownedHttpArchiveCancel(this.root.sink!, operand); }');

    source = replace(source, '  command.observe(original); original = undefined as never; return command.ready;\n}\nexport function ownedHttpArchivePipe',
      '  ' + probe + '.archiveActualOriginal(original, writer, "put"); command.observe(original); original = undefined as never; return command.ready;\n}\nexport function ownedHttpArchivePipe');
    source = replace(source, '  command.observe(original); original = undefined as never; return command.ready;\n}\nexport function ownedHttpArchiveCancel',
      '  ' + probe + '.archiveActualOriginal(original, writer, "pipe"); command.observe(original); original = undefined as never; return command.ready;\n}\nexport function ownedHttpArchiveCancel');
    source = replace(source, '  command.observe(original); original = undefined as never; return command.ready;\n}\nexport function ownedHttpArchiveAbort',
      '  ' + probe + '.archiveActualOriginal(original, writer, "cancel"); command.observe(original); original = undefined as never; return command.ready;\n}\nexport function ownedHttpArchiveAbort');

    source = 'import { bodyBudgetCharged as __publicCharged, bodyBudgetBytes as __publicLimit } from "./body-budget.ts";\n' + source;
    source = replace(source, 'const replacement = this.owner.funding.replace(this.owner.funding.bytes + high - this.owner.publicCaptureHighWater);\n      if (!replacement) throw identityFailure("limit");',
      'if (' + probe + '.consumerMode === "public-capacity-refusal" && !' + probe + '.consumers.public.refusals) '
      + probe + '.publicPressure(ExactBodyCharge.reserve(__publicLimit - __publicCharged() - (high - this.owner.publicCaptureHighWater) + 1), this.owner.publicCaptureLiveBytes, this.owner.publicCaptureHighWater); '
      + 'const replacement = this.owner.funding.replace(this.owner.funding.bytes + high - this.owner.publicCaptureHighWater);\n'
      + '      if (!replacement) { ' + probe + '.publicRefused(this.owner.publicCaptureLiveBytes, this.owner.publicCaptureHighWater); throw identityFailure("limit"); }');
    source = replace(source, 'this.captured = copy;', 'this.captured = copy; ' + probe + '.publicCopied();');
    source = replace(source, '    this.captureLiveBytes = component; this.handedOff = false;',
      '    this.captureLiveBytes = component; this.handedOff = false; ' + probe + '.publicCapture(live, high, component, this.owner.sealed);');
    source = replace(source, 'this.owner.publicCaptureLiveBytes -= this.captureLiveBytes; this.captureLiveBytes = 0; this.handedOff = false;',
      'this.owner.publicCaptureLiveBytes -= this.captureLiveBytes; this.captureLiveBytes = 0; this.handedOff = false; ' + probe + '.publicCaptureReleased(this.owner.publicCaptureLiveBytes);');
    source = replace(source, '    this.observeDriverClosed(Object.getPrototypeOf(reader) === (this.byob ? ReadableStreamBYOBReader.prototype : ReadableStreamDefaultReader.prototype)',
      '    ' + probe + '.rpcReader(reader, this.kind); this.observeDriverClosed(Object.getPrototypeOf(reader) === (this.byob ? ReadableStreamBYOBReader.prototype : ReadableStreamDefaultReader.prototype)');
    source = replace(source, 'function ownHttpResponse(cap: OwnedHttpRequest, response: Response, publicBoundary: boolean): Response {',
      'function ownHttpResponse(cap: OwnedHttpRequest, response: Response, publicBoundary: boolean): Response { ' + probe + '.wrapper(publicBoundary); ' + probe + '.headerResponse(response, publicBoundary);');
    source = replace(source, 'try { this.reader = this.body!.getReader(); }',
      'try { this.reader = this.body!.getReader(); this.__probeAcquired = true; ' + probe + '.publicReader(this.reader); }');
    source = replace(source, '    this.original = undefined; this.clearCapture();',
      '    this.original = undefined; this.clearCapture(); if (this.__probeAcquired) ' + probe + '.publicRetiredReader();');
    source = replace(source, 'export function canCompleteOwnedHttpPreparation(cap: OwnedHttpRequest, request?: Request): boolean {\n  const owner = OwnedHttpRegistrations.requests?.get(cap);',
      'export function canCompleteOwnedHttpPreparation(cap: OwnedHttpRequest, request?: Request): boolean {\n  const owner = OwnedHttpRegistrations.requests?.get(cap); if (owner?.unknown) ' + probe + '.reductionBlocked.push({ unknown: owner.unknown, aborted: owner.abortController?.signal.aborted, funding: owner.funding.bytes });');
    source = replace(source, '    this.observeClosed();', '    ' + probe + '.statusReader(this.reader, this.index); this.observeClosed();');
    source = replace(source, '    return failedSinkOrigin(requestOwner(this.owner.http), origin, reason);',
      '    return ' + probe + '.statusFailure(this.index, offset, failedSinkOrigin(requestOwner(this.owner.http), origin, reason));');
    source = replace(source, 'this.owner.retire(this.index, this);', probe + '.statusRetired(this.index); this.owner.retire(this.index, this);');
    source = replace(source, 'this.owner.decide(this.index, !!(this.flags & 64) && !(this.flags & 16), this.spent);',
      probe + '.statusDecision(this.index); this.owner.decide(this.index, !!(this.flags & 64) && !(this.flags & 16), this.spent);');
    source = replace(source, 'const ordinal = child.base + offset + (installation ? 9 : 0), known = child.root.sinkOrigins!.has(ordinal);',
      'if (installation) ' + probe + '.consumers.generic.failures++; else if (kind === "read") ' + probe + '.consumers.generic.readFailures++; '
      + 'const ordinal = child.base + offset + (installation ? 9 : 0), known = child.root.sinkOrigins!.has(ordinal);');
    source = replace(source, 'acceptOwnedGenericUsage(child.http, cap, result); child.delivered = true;',
      'acceptOwnedGenericUsage(child.http, cap, result); child.delivered = true; ' + probe + '.consumers.generic.logical++;');
  } else if (/[\\/]worker[\\/]providers\.ts$/.test(path)) {
    source = replace(source, '  completeOwnedHttpAttemptProvider(cap, permit);',
      '  completeOwnedHttpAttemptProvider(cap, permit); if (' + probe + '.retainedStatusPrepared) await ' + probe + '.retainedStatusPrepared();');
  } else if (/[\\/]worker[\\/]proxy\.ts$/.test(path)) {
    source = replace(source, 'function commitOwnedHttpAttempt(cap: OwnedHttpRequest): PreparedUpstream {\n  const owner = ownedProxyInvocations?.get(cap), port = owner?.retry?.pending;',
      'function commitOwnedHttpAttempt(cap: OwnedHttpRequest): PreparedUpstream {\n  const owner = ownedProxyInvocations?.get(cap), port = owner?.retry?.pending; if (owner) globalThis.__ownedAckPhaseFixture?.beforeCommit(owner);');
    source = replace(source, '  owner.retryClosed = true; delete owner.required; delete owner.retry;',
      '  owner.retryClosed = true; delete owner.required; delete owner.retry; if (globalThis.__ownedAckPhaseFixture) { let __rejected = 0; try { excludeOwnedHttpGrant(cap, "fixture-stale-key"); } catch { __rejected++; } try { commitOwnedHttpAttempt(cap); } catch { __rejected++; } globalThis.__ownedAckPhaseFixture.retry(owner, !owner.prepared || ownedPreparedUploads?.get(owner.prepared) === owner.upload, __rejected); }');
    source = replace(source, '    retry.pending = port;',
      '    retry.pending = port; ' + probe + '.retryPorts.push({ keys: [...port.input.excludedKeys!], signal: port.signal, input: port.input });');
    source = replace(source, '  try { return await original; }\n  finally {',
      '  try { const __logical = await original; globalThis.__ownedTerminalFixture?.logical(__logical); return __logical; }\n  finally {');
    source = replace(source, 'beginOwnedHttpProxyPublicationHeaders(http, response, selection.provider.id)',
      'beginOwnedHttpProxyPublicationHeaders(http, response, ' + probe + '.publicationProvider(selection.provider.id))');
    source = replace(source, '    if (codecConsumer && !codecPublished) abandonOwnedCodecConsumer(codecConsumer);',
      '    if (owned) ' + probe + '.publicationExit(codecPublished);\n    if (codecConsumer && !codecPublished) abandonOwnedCodecConsumer(codecConsumer);');

    source = replace(source, 'captureWire: Uint8Array | undefined = newOwnedBytes(16384);',
      'captureWire: Uint8Array | undefined = (' + probe + '.intakeFactory(), newOwnedBytes(16384));');
    source = replace(source, 'try { this.reader = this.body!.getReader({ mode: "byob" }); }',
      'try { this.reader = this.body!.getReader({ mode: "byob" }); this.__intakeProbeAcquired = true; ' + probe + '.intakeReader(this.reader, this); }');
    source = replace(source, 'this.reader = undefined; this.body = undefined; this.captureWire = undefined; this.nativeFailure = undefined;',
      'this.reader = undefined; this.body = undefined; this.captureWire = undefined; this.nativeFailure = undefined; if (this.__intakeProbeAcquired) ' + probe + '.intakeRetiredReader();');
    source = replace(source, 'method(destination, operand as Uint8Array);',
      'method(destination, operand as Uint8Array); ' + probe + '.capturedIntake(this.captureLength);');
    source = replace(source, 'method = copyOwnedBytes;', 'method = copyOwnedBytes; ' + probe + '.intakeCopyLookup();');
    source = replace(source, 'parsed = ownedIntakeJsonParse(text); text = "";',
      'parsed = ownedIntakeJsonParse(text); text = ""; ' + probe + '.intakeConstructed();');
    source = replace(source, 'const graph = ownedHttpJsonDataBytes(text);',
      'const graph = ownedHttpJsonDataBytes(text); ' + probe + '.intakeGraph(graph);');
  } else if (/[\\/]worker[\\/]token-usage\.ts$/.test(path)) {
    source = replace(source, 'owned?.admitJson(data);', 'owned?.admitJson(data); if (owned) ' + probe + '.beforeUsageParse();');
    source = replace(source, 'messageUsage = messageCounters(usageRecord(root));',
      'if (OwnedUsageRegistrations.privateUsageAccumulators?.has(accept)) ' + probe + '.summary(message.stop_reason); messageUsage = messageCounters(usageRecord(root));');
    source = replace(source, 'const delta = messageCounters(usageRecord(root));',
      'if (OwnedUsageRegistrations.privateUsageAccumulators?.has(accept)) ' + probe + '.summary(message?.stop_reason); const delta = messageCounters(usageRecord(root));');
  } else if (/[\\/]worker[\\/]proxy-response\.ts$/.test(path)) {
    source = replace(source, '      const status = response.status, statusText = response.statusText, headers = response.headers;',
      '      ' + probe + '.publicationEnter(response); const status = response.status, statusText = response.statusText, headers = response.headers;');
    source = replace(source, '    const status = response.status, statusText = response.statusText, headers = response.headers;',
      '    ' + probe + '.publicationEnter(response); const status = response.status, statusText = response.statusText, headers = response.headers;');

    source = replace(source, 'let census: ReturnType<typeof measurePrivateJsonBody> | undefined = measurePrivateJsonBody(data);',
      probe + '.startCensus(true); let census: ReturnType<typeof measurePrivateJsonBody> | undefined = measurePrivateJsonBody(data);');
    source = replace(source, 'this.admitJson(this.text, true);', 'this.admitJson(this.text, true); ' + probe + '.beforeUsageParse();');
    source = replace(source, 'ownedAcceptedUsage?.delete(this.cap);', 'ownedAcceptedUsage?.delete(this.cap); ' + probe + '.usageCleared();');
    source = replace(source, 'if (!this.finished) enqueueOwnedBytes(controller, bytes!);',
      'if (!this.finished) { enqueueOwnedBytes(controller, bytes!); ' + probe + '.enqueued(bytes!); }');
    source = replace(source, 'checkOwnedHttpCodecConsumer(http, codec, response, operation, streaming, requestId, usageContext);',
      'if (' + probe + '.consumerMode === "forged") codec = Object.freeze({}); '
      + 'else if (' + probe + '.consumerMode === "stale") codec = ' + probe + '.previousCodec; '
      + 'else if (' + probe + '.consumerMode === "mode") streaming = !streaming; '
      + 'checkOwnedHttpCodecConsumer(http, codec, response, operation, streaming, requestId, usageContext); '
      + probe + '.previousCodec = codec; ' + probe + '.consumerCreated();');
    source = replace(source, 'this.reader = this.body.getReader();', 'this.reader = this.body.getReader(); this.__probeAcquired = true; ' + probe + '.reader(this.reader);');
    source = replace(source, 'finishOwnedCodecDiagnostics(this.owner.codec, this.role);',
      'finishOwnedCodecDiagnostics(this.owner.codec, this.role); if (this.__probeAcquired) ' + probe + '.retiredReader();');
    source = replace(source, 'function replayResponse(response: Response, reader: ReadableStreamDefaultReader<Uint8Array>, chunks: Uint8Array[], readerDone: boolean): Response {',
      'function replayResponse(response: Response, reader: ReadableStreamDefaultReader<Uint8Array>, chunks: Uint8Array[], readerDone: boolean): Response { ' + probe + '.replay();');
    source = replace(source, '    return sniff;', '    ' + probe + '.transferred(sniff.reader); return sniff;');
    source = replace(source, '      this.reader = body.getReader();\n      const reader = this.reader;',
      '      this.reader = body.getReader(); ' + probe + '.genericReader(this.reader);\n      const reader = this.reader;');
    source = replace(source, 'protected driverRetired(): void { finishOwnedHttpGenericUsageReader(this.#cap, this); }',
      'protected driverRetired(): void { finishOwnedHttpGenericUsageReader(this.#cap, this); ' + probe + '.genericRetired(); }');
    source = replace(source, '    this.transferred = true; this.clearOutput();',
      '    ' + probe + '.consumers.generic.transfers++; this.transferred = true; this.clearOutput();');

    source = replace(source, '    this.reader = this.body!.getReader();\n    const reader = this.reader;',
      '    this.reader = this.body!.getReader(); ' + probe + '.normalizerReader(this.reader);\n    const reader = this.reader;');
    source = replace(source, 'protected driverRetired(): void { finishOwnedHttpNormalizationReader(this.#cap, this); }',
      'protected driverRetired(): void { finishOwnedHttpNormalizationReader(this.#cap, this); ' + probe + '.normalizerRetired(); }');
    source = replace(source, '    this.outputTransferred = true; this.clearOutput();',
      '    ' + probe + '.consumers.normalizer.transfers++; this.outputTransferred = true; this.clearOutput();');


  } else if (/[\\/]worker[\\/]pricing\.ts$/.test(path)) {
    source = replace(source, 'plan.toolScratchBytes = ownedToolScratchBytes(body, ownedHttpHasToolPriceCard(cap, body), plan.bytes);',
      'plan.toolScratchBytes = ownedToolScratchBytes(body, ownedHttpHasToolPriceCard(cap, body), plan.bytes); ' + probe + '.toolScratchBytes = plan.toolScratchBytes;');
    source = replace(source, 'ownedPricing.set(cap, retained); ownedPricingCount++;',
      'ownedPricing.set(cap, retained); ownedPricingCount++; ' + probe + '.pricing(1);');
    source = replace(source, 'plan.body = undefined; ownedPricing!.delete(cap);',
      'plan.body = undefined; ownedPricing!.delete(cap); ' + probe + '.pricing(-1);');
  } else if (/[\\/]stream-json[\\/](?:src[\\/])?core[\\/]parser\.js$/.test(path)) {
    // Exact pinned 3.8 tokenizer: two container-entry and three exit sites.
    // Observe the ORIGINAL stack *before* the consumer sees the returned batch.
    source = replace(source, 'stack.push(parent);', 'stack.push(parent); ' + probe + '?.tokenizer(stack.length);', 2);
    source = replace(source, 'parent = stack.pop();', 'parent = stack.pop(); ' + probe + '?.tokenizer(stack.length);', 3);
  }
  return source;
}

export async function startOwnedJsonObservedFixture(directory, router, upstream, options) {
  const [{ createRequire }, { readFile }, { dirname }, { startBundledWorkerdFixture }] = await Promise.all([
    import('node:module'), import('node:fs/promises'), import('node:path'), import('./workerd.mjs'),
  ]);
  const { build } = createRequire(import.meta.resolve('wrangler/package.json'))('esbuild');
  const bundled = await build({ stdin: {
    contents: 'globalThis.__ownedUsageWire = ' + ownedUsageWire.toString() + ';\nglobalThis.__ownedJsonObservation = (' + createOwnedJsonObservation.toString() + ')();\n' + router,
    resolveDir: process.cwd(), sourcefile: 'owned-json-fixture.ts', loader: 'ts',
  }, bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', logLevel: 'silent',
  plugins: [{ name: 'observe-original-json-stacks', setup(build) {
    build.onLoad({ filter: /(?:[\\/]worker[\\/](?:credential-preflight-source|credential-preflight|credential-cache|identity-admission|json-body|proxy-accounting|proxy-response|proxy-completion|proxy|providers|utils|http-identity-owner|pricing|token-usage|venice-chat-runtime)\.ts|[\\/]stream-json[\\/](?:src[\\/])?core[\\/]parser\.js)$/ }, async ({ path }) => ({
      contents: observeOwnedJsonSource(path, await readFile(path, 'utf8')),
      loader: path.endsWith('.ts') ? 'ts' : 'js', resolveDir: dirname(path),
    }));
  } }] });
  return startBundledWorkerdFixture(directory, bundled.outputFiles[0].text, upstream, options);
}
