import assert from 'node:assert/strict';
import { ownedUsageWire } from './owned-json-parser-cases.mjs';

// Fixture-only source observers. Forward every original operation unchanged;
// retain scalar counts, never parser input, keys, values, containers or tokens.
// These observers are NOT production factories or a complete CONTROL inventory.
export function createOwnedJsonObservation() {
  const rows = [], readers = new WeakSet();
  let current, preparations = 0;
  const consumers = { created: 0, acquired: 0, retired: 0, live: 0, inner: 0, outer: 0,
    read: 0, cancel: 0, unlock: 0, nativeUnlocked: 0, unlockSettled: 0, thenCalls: 0, closed: 0, closedSettled: 0, replay: 0, transferred: 0, pricing: 0, enqueued: 0, oversizedOutput: 0, mutations: 0, held: false, released: false, reasonReads: 0 };
  const usage = { census: 0, parsed: 0, maxGraph: 0, maxContainers: 0, maxStrings: 0, maxAtoms: 0, maxUnits: 0, summaries: 0, cleared: 0 };
  const shared = { claims: 0, held: 0, refused: 0, before: 0, after: 0 };
  let releaseConsumer, mutateIntake;
  const statusReaders = [], statusReleases = [];
  const publicReaders = { ...consumers }, intakeReaders = { ...consumers }, sourceReaders = { ...consumers };
  consumers.public = publicReaders; consumers.intake = intakeReaders; consumers.source = sourceReaders;
  function faultReader(reader, mode, consumers) {
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
    consumers,
    usage,
    shared,
    sharedClaim(before, after, held) {
      if (shared.claims || held !== 65536 || after - before !== held) throw new Error('shared claim is not one exact positive debit');
      shared.claims++; shared.held = held; shared.before = before; shared.after = after;
    },
    sharedRefused(before, after) { if (before !== after) throw new Error('failed shared claim changed COMMON'); shared.refused++; },
    sharedPressure(charge) { if (!charge) throw new Error('shared claim pressure setup'); releaseConsumer = () => charge.release(); },
    statusReaders,
    statusReader(reader, index) {
      const row = { read: 0, cancel: 0, unlock: 0, nativeUnlocked: 0, unlockSettled: 0, thenCalls: 0, closed: 0, closedSettled: 0, reasonReads: 0, held: false, retired: false, decided: false };
      statusReaders[index] = row;
      const previous = releaseConsumer;
      if (this.consumerMode.startsWith('status-')) faultReader(reader, this.consumerMode.slice(7), row);
      if (releaseConsumer !== previous) statusReleases.push(releaseConsumer);
      releaseConsumer = previous;
    },
    statusDecision(index) { statusReaders[index].decided = true; },
    statusRetired(index) { statusReaders[index].retired = true; },
    capturedIntake(length) { intakeReaders.captures = (intakeReaders.captures ?? 0) + 1; intakeReaders.capturedBytes = (intakeReaders.capturedBytes ?? 0) + length; },
    intakeGraph(bytes) { intakeReaders.graphBytes = bytes; },
    mutateIntake() { mutateIntake?.(); },
    census(c, s, a, u, graph) {
      usage.census++; usage.maxGraph = Math.max(usage.maxGraph, graph);
      usage.maxContainers = Math.max(usage.maxContainers, c); usage.maxStrings = Math.max(usage.maxStrings, s);
      usage.maxAtoms = Math.max(usage.maxAtoms, a); usage.maxUnits = Math.max(usage.maxUnits, u);
    },
    beforeUsageParse() { if (usage.parsed >= usage.census) throw new Error('native usage parse before census'); usage.parsed++; },
    summary(value) { if (value !== undefined && value !== 'refusal') throw new Error('private summary retained a stop-reason subtree'); usage.summaries++; },
    usageCleared() { usage.cleared++; },
    consumerMode: 'normal',
    previousCodec: undefined,
    consumerCreated() { consumers.created++; },
    replay() { consumers.replay++; },
    transferred(reader) { if (!readers.has(reader)) throw new Error("sniff handoff replaced its original reader"); consumers.transferred++; },
    enqueued(bytes) { consumers.enqueued += bytes.byteLength; if (bytes.buffer.byteLength !== bytes.byteLength) consumers.oversizedOutput++; },
    pricing(delta) { consumers.pricing += delta; if (consumers.pricing < 0) throw new Error("pricing retired twice"); },
    reader(reader) {
      consumers.acquired++; consumers.live++; readers.add(reader);
      if (consumers.acquired === 1 || this.consumerMode.startsWith('usage:') || this.consumerMode === 'then-early') faultReader(reader, this.consumerMode, consumers);
    },
    sourceReader(reader) {
      sourceReaders.acquired++;
      if (this.consumerMode === 'source-then-early') faultReader(reader, 'then-early', sourceReaders);
    },
    publicReader(reader) {
      publicReaders.acquired++; publicReaders.live++;
      if ((publicReaders.acquired === 1 || this.consumerMode === 'public-then-early') && this.consumerMode.startsWith('public-')) faultReader(reader, this.consumerMode.slice(7), publicReaders);
    },
    intakeReader(reader) {
      intakeReaders.acquired++; intakeReaders.live++;
      if (intakeReaders.acquired === 1 && this.consumerMode.startsWith('intake-')) faultReader(reader, this.consumerMode.slice(7), intakeReaders);
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
      if (current || !row || row.kind !== 'validator' || !row.cleared || row.graph <= 0 || row.nativeParses)
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
  if (/[\\/]worker[\\/]venice-chat-runtime\.ts$/.test(path)) {
    source = 'import { bodyBudgetCharged as __sharedCharged, bodyBudgetBytes as __sharedLimit } from "./body-budget.ts";\n' + source;
    source = replace(source, 'const charge = ExactBodyCharge.reserve(65536);',
      'if (' + probe + '.consumerMode === "shared-refusal") ' + probe + '.sharedPressure(ExactBodyCharge.reserve(__sharedLimit - __sharedCharged() - 65535)); '
      + 'const __beforeShared = __sharedCharged(); const charge = ExactBodyCharge.reserve(65536);');
    source = replace(source, 'if (!charge) throw identityFailure("limit");',
      'if (!charge) { ' + probe + '.sharedRefused(__beforeShared, __sharedCharged()); throw identityFailure("limit"); }');
    source = replace(source, 'ownedTokenizerShared = charge;',
      'ownedTokenizerShared = charge; ' + probe + '.sharedClaim(__beforeShared, __sharedCharged(), charge.bytes);');
    source = replace(source, 'return JSON.parse(text);', probe + '.nativeParse(); return JSON.parse(text);');
    source = replace(source, 'this.reader = (this.flags & 8) ? this.body.getReader({ mode: "byob" }) : this.body.getReader();',
      'this.reader = (this.flags & 8) ? this.body.getReader({ mode: "byob" }) : this.body.getReader(); ' + probe + '.sourceReader(this.reader);');
  } else if (/[\\/]worker[\\/]token-usage\.ts$/.test(path)) {
    source = replace(source, 'return 16 * (containers + strings + atoms) + 2 * units;',
      probe + '.census(containers, strings, atoms, units, 16 * (containers + strings + atoms) + 2 * units); return 16 * (containers + strings + atoms) + 2 * units;');
    source = replace(source, 'owned?.admitJson(data);', 'owned?.admitJson(data); if (owned) ' + probe + '.beforeUsageParse();');
    source = replace(source, 'this.admitJson(this.text, true);', 'this.admitJson(this.text, true); ' + probe + '.beforeUsageParse();');
    source = replace(source, 'messageUsage = messageCounters(usageRecord(root));',
      'if (privateUsageAccumulators?.has(accept)) ' + probe + '.summary(message.stop_reason); messageUsage = messageCounters(usageRecord(root));');
    source = replace(source, 'const delta = messageCounters(usageRecord(root));',
      'if (privateUsageAccumulators?.has(accept)) ' + probe + '.summary(message?.stop_reason); const delta = messageCounters(usageRecord(root));');
    source = replace(source, 'ownedAcceptedUsage!.delete(this.cap);', 'ownedAcceptedUsage!.delete(this.cap); ' + probe + '.usageCleared();');
  } else if (/[\\/]worker[\\/]json-body\.ts$/.test(path)) {
    source = replace(source, 'export function validatePrivateJsonBody(text: string): number {',
      'export function validatePrivateJsonBody(text: string): number { const __validatorProbe = ' + probe + '.begin("validator");');
    source = replace(source, 'if (++depth > 128) throw new JsonBodyStructureLimit();',
      'depth++; ' + probe + '.validating(__validatorProbe, depth); if (depth > 128) throw new JsonBodyStructureLimit();');
    source = replace(source, 'consume.push(text.slice(offset, end)); offset = end;',
      probe + '.enter(__validatorProbe); try { consume.push(text.slice(offset, end)); } catch (error) { ' + probe + '.rejected(__validatorProbe); throw error; } finally { ' + probe + '.leave(__validatorProbe); } offset = end;');
    source = replace(source, 'consume.end();\n    return 8 * (2 * values - 1 + keys) + 2 * units;',
      probe + '.enter(__validatorProbe); try { consume.end(); } finally { ' + probe + '.leave(__validatorProbe); } '
      + probe + '.validated(__validatorProbe, 8 * (2 * values - 1 + keys) + 2 * units); return 8 * (2 * values - 1 + keys) + 2 * units;');
    source = replace(source, 'consume = undefined; accept = undefined; text = "";',
      'consume = undefined; accept = undefined; text = ""; ' + probe + '.validatorCleared(__validatorProbe, consume === undefined && accept === undefined && text === "");');
    source = replace(source, 'let pendingKey: string | undefined;',
      'let pendingKey: string | undefined; const __parserProbe = privateParents ? ' + probe + '.begin() : undefined;');
    source = replace(source, 'parent = parents.at(-1); member = pendingKey;',
      'parent = parents.at(-1); member = pendingKey; ' + probe + '.attaching(__parserProbe, member !== undefined);');
    source = replace(source, 'if (parents) { pendingKey = undefined; member = undefined; }',
      'if (parents) { const __attached = !parent ? root === value : Array.isArray(parent) ? parent.at(-1) === value : Object.hasOwn(parent, member!) && parent[member!] === value; '
      + 'pendingKey = undefined; member = undefined; ' + probe + '.attached(__parserProbe, !parent ? 0 : Array.isArray(parent) ? 1 : 2, __attached, pendingKey === undefined, member === undefined); }');
    source = replace(source, 'if (parents) parents.push(value);',
      'if (parents) { parents.push(value); ' + probe + '.consumer(__parserProbe, parents.length, pendingKey !== undefined); }');
    source = replace(source, '(parents ?? stack!).pop();',
      '(parents ?? stack!).pop(); if (parents) ' + probe + '.consumer(__parserProbe, parents.length, pendingKey !== undefined);');
    source = replace(source, 'if (parents) pendingKey = scalar;',
      'if (parents) { pendingKey = scalar; ' + probe + '.consumer(__parserProbe, parents.length, true); }');
    source = replace(source, '(parents ?? stack!).length = 0;',
      '(parents ?? stack!).length = 0; if (__parserProbe) ' + probe + '.discard(__parserProbe, parents?.length === 0, pendingKey === undefined, scalar === "", root === undefined, consume === undefined);');
    source = replace(source, 'for (let offset = 0; offset < text.length; offset += 4096) consume.push(text.slice(offset, offset + 4096));',
      'if (__parserProbe) ' + probe + '.enter(__parserProbe); try { for (let offset = 0; offset < text.length; offset += 4096) consume.push(text.slice(offset, offset + 4096)); } catch (__rejected) { if (__parserProbe) ' + probe + '.rejected(__parserProbe); throw __rejected; } finally { if (__parserProbe) ' + probe + '.leave(__parserProbe); }');
    source = replace(source, 'try { consume.end(); return root; }\n    finally { discard(); }',
      'if (__parserProbe) ' + probe + '.enter(__parserProbe); try { consume.end(); return root; }\n    finally { if (__parserProbe) ' + probe + '.leave(__parserProbe); discard(); }');
  } else if (/[\\/]worker[\\/]proxy-accounting\.ts$/.test(path)) {
    source = replace(source, '    records.push(cap);',
      '    records.push(cap); if (preparation) ' + probe + '.accounting(1);');
    source = replace(source, '  unbindOwnedAccountingPlan(state.factsCell.current.cost);',
      '  if (state.state & 1) ' + probe + '.accounting(-1); unbindOwnedAccountingPlan(state.factsCell.current.cost);');
  } else if (/[\\/]worker[\\/]http-identity-owner\.ts$/.test(path)) {
    source = replace(source, 'function ownHttpResponse(cap: OwnedHttpRequest, response: Response, publicBoundary: boolean): Response {',
      'function ownHttpResponse(cap: OwnedHttpRequest, response: Response, publicBoundary: boolean): Response { ' + probe + '.wrapper(publicBoundary);');
    source = replace(source, 'try { this.reader = this.body!.getReader(); }',
      'try { this.reader = this.body!.getReader(); this.__probeAcquired = true; ' + probe + '.publicReader(this.reader); }');
    source = replace(source, '      this.nativeFailure = undefined; this.resolve();',
      '      this.nativeFailure = undefined; if (this.__probeAcquired) ' + probe + '.publicRetiredReader(); this.resolve();');
    source = replace(source, '    this.observeClosed();', '    ' + probe + '.statusReader(this.reader, this.index); this.observeClosed();');
    source = replace(source, 'this.owner.retire(this.index, this);', probe + '.statusRetired(this.index); this.owner.retire(this.index, this);');
    source = replace(source, 'this.owner.decide(this.index, !!(this.flags & 64) && !(this.flags & 16), this.spent);',
      probe + '.statusDecision(this.index); this.owner.decide(this.index, !!(this.flags & 64) && !(this.flags & 16), this.spent);');
  } else if (/[\\/]worker[\\/]proxy\.ts$/.test(path)) {
    source = replace(source, 'const diagnostics = beginOwnedHttpIntakeDiagnostics(cap);',
      'const diagnostics = beginOwnedHttpIntakeDiagnostics(cap); let __intakeProbeAcquired = false;');
    source = replace(source, 'try { reader = body.getReader({ mode: "byob" }); }',
      'try { reader = body.getReader({ mode: "byob" }); __intakeProbeAcquired = true; ' + probe + '.intakeReader(reader); }');
    source = replace(source, 'parser?.discard(); parser = undefined; prefixWire = undefined; captureWire = undefined;',
      'parser?.discard(); parser = undefined; prefixWire = undefined; captureWire = undefined; if (__intakeProbeAcquired) ' + probe + '.intakeRetiredReader();');
    source = replace(source, 'captureLength = item.value.byteLength; captureWire!.set(item.value);',
      'captureLength = item.value.byteLength; captureWire!.set(item.value); ' + probe + '.capturedIntake(captureLength);');
    source = replace(source, 'const graph = ownedHttpJsonDataBytes(text);',
      'const graph = ownedHttpJsonDataBytes(text); ' + probe + '.intakeGraph(graph);');
  } else if (/[\\/]worker[\\/]proxy-response\.ts$/.test(path)) {
    source = replace(source, 'checkOwnedHttpCodecConsumer(http, codec, response, operation, streaming, requestId, usageContext);',
      'if (' + probe + '.consumerMode === "forged") codec = Object.freeze({}); '
      + 'else if (' + probe + '.consumerMode === "stale") codec = ' + probe + '.previousCodec; '
      + 'else if (' + probe + '.consumerMode === "mode") streaming = !streaming; '
      + 'checkOwnedHttpCodecConsumer(http, codec, response, operation, streaming, requestId, usageContext); '
      + probe + '.previousCodec = codec; ' + probe + '.consumerCreated();');
    source = replace(source, 'state.reader = state.body.getReader();', 'state.reader = state.body.getReader(); state.__probeAcquired = true; ' + probe + '.reader(state.reader);');
    source = replace(source, 'finishOwnedCodecDiagnostics(state.owner.codec, state.role);',
      'finishOwnedCodecDiagnostics(state.owner.codec, state.role); if (state.__probeAcquired) ' + probe + '.retiredReader();');
    source = replace(source, 'function replayResponse(response: Response, reader: ReadableStreamDefaultReader<Uint8Array>, chunks: Uint8Array[], readerDone: boolean): Response {',
      'function replayResponse(response: Response, reader: ReadableStreamDefaultReader<Uint8Array>, chunks: Uint8Array[], readerDone: boolean): Response { ' + probe + '.replay();');
    source = replace(source, '    return sniff;', '    ' + probe + '.transferred(sniff.reader); return sniff;');
    source = replace(source, 'if (!this.finished) controller.enqueue(next.value);\n      this.state.captured = undefined;',
      'if (!this.finished) { controller.enqueue(next.value); ' + probe + '.enqueued(next.value); }\n      this.state.captured = undefined;');
  } else if (/[\\/]worker[\\/]pricing\.ts$/.test(path)) {
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
    build.onLoad({ filter: /(?:[\\/]worker[\\/](?:json-body|proxy-accounting|proxy-response|proxy|http-identity-owner|pricing|token-usage|venice-chat-runtime)\.ts|[\\/]stream-json[\\/](?:src[\\/])?core[\\/]parser\.js)$/ }, async ({ path }) => ({
      contents: observeOwnedJsonSource(path, await readFile(path, 'utf8')),
      loader: path.endsWith('.ts') ? 'ts' : 'js', resolveDir: dirname(path),
    }));
  } }] });
  return startBundledWorkerdFixture(directory, bundled.outputFiles[0].text, upstream, options);
}
