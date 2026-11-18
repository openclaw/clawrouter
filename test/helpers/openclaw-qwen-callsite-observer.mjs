import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants, openSync, closeSync, fstatSync, readSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// D8 source overlays are diagnostics, not SDK changes or ownership evidence.
export const qwenValuePin = "d8bb939408aa4d2be7df0161748edb52ebf3b1fb";
export const qwenValueTarget = "extensions/qwen/worker-regions-contract.test.ts";
export const qwenValueModule = "virtual:clawrouter-qwen-values";
export const qwenValueSources = Object.freeze([
  Object.freeze({ path: "packages/ai/src/providers/openai-provider-client.ts",
    sha256: "0c049068171de83e25e8c12cbbe9c24ad984280776ed47f3554e7beb50997e41" }),
  Object.freeze({ path: "src/agents/provider-transport-dispatcher-pool.ts",
    sha256: "fbdb819ace74f9aab0c5d9e9cc7c262e5959687258266f7d011524e8e99cb796" }),
]);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const validHash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export const clientValueAnchor = "getAiTransportHost().buildModelFetch(model) ?? globalThis.fetch";
export const guardValueAnchor = "fetchWithSsrFGuard({\n    ...options,\n    dispatcherPool: getProviderTransportDispatcherPool(),\n  })";

// Lexical arrows preserve this/arguments and leave every original call Reference
// intact. The hook callee and preceding constructor/options work remain outside.
// Engine-generated error text/stacks may reflect the overlay; no byte-equivalence
// or native qualification is claimed.
export const clientValueExpression = `(() => {
        const token = __qwenValues.begin(1);
        try {
          return __qwenValues.selected(token,
            __qwenValues.build(token,
              __qwenValues.host(token, getAiTransportHost()).buildModelFetch(model)
            ) ?? __qwenValues.fallback(token, globalThis.fetch));
        } finally { __qwenValues.finish(token); }
      })()`;
export const guardValueExpression = `(() => {
    const token = __qwenValues.begin(2);
    try {
      return __qwenValues.result(token,
        fetchWithSsrFGuard(__qwenValues.argument(token, {
          ...options,
          dispatcherPool: getProviderTransportDispatcherPool(),
        })));
    } finally { __qwenValues.finish(token); }
  })()`;

// Serialized into one nonce-specific WORKER module, never a config-side sink.
// No observed value is reflected on, invoked, assimilated or serialized.
export function createQwenValueSink(contract) {
  const is = Object.is, freeze = Object.freeze;
  const activations = [0, 0], claims = new Set(), tokens = new Map();
  let active, poisoned = false, ordinal = 0;
  const stray = [];
  const overflow = new Error("Qwen value recording capacity exceeded");
  function fault(owner, error) {
    const list = owner ? owner.errors : stray;
    if (list.length < 31) list.push(error);
    else if (list.length === 31) list.push(overflow);
    if (owner) owner.unknown = true;
    else poisoned = true;
  }
  function invalidate(owner) { if (owner) owner.unknown = true; }
  function safe(owner, fn) { try { return fn(); } catch (error) { fault(owner, error); } }
  function activate(site, key) {
    safe(active, () => {
      if (key !== contract || (site !== 1 && site !== 2) || ++activations[site - 1] !== 1) poisoned = true;
    });
  }
  function begin(site) {
    const owner = active;
    return safe(owner, () => {
      if (!owner || owner.closed || (site !== 1 && site !== 2)) { poisoned = true; return null; }
      if (owner.entering) { invalidate(owner); return null; }
      owner.entering = true;
      try {
        const invocation = owner.current(), row = owner.rows.get(invocation);
        if (!row) { invalidate(owner); return null; }
        // Bound before operand evaluation: even a nested lookup/spread that throws
        // before its first value tap invalidates BOTH evaluations.
        if (owner.stack.length || row.sites[site - 1]) invalidate(owner);
        if (++owner.evaluations > 8) { invalidate(owner); return null; }
        const token = freeze({});
        const state = { owner, invocation, row, site, bits: 0, closed: false,
          id: owner.evaluations, build: undefined, fallback: undefined, branch: 0, kind: 0 };
        row.sites[site - 1] = state; tokens.set(token, state); owner.stack.push(token);
        return token;
      } finally { owner.entering = false; }
    }) ?? null;
  }
  const kind = value => value === undefined ? 1 : value === null ? 2
    : typeof value === "boolean" ? 3 : typeof value === "number" ? 4
    : typeof value === "bigint" ? 5 : typeof value === "string" ? 6
    : typeof value === "symbol" ? 7 : typeof value === "function" ? 9 : 8;
  function tap(token, phase, value) {
    const state = tokens.get(token), owner = state?.owner ?? active;
    safe(owner, () => {
      if (!state || state.closed || active !== owner || owner.closed ||
          owner.stack.at(-1) !== token || owner.current() !== state.invocation) {
        if (owner) invalidate(owner); else poisoned = true;
        return;
      }
      const before = state.bits;
      if (phase === 1 && state.site === 1 && before === 0) state.bits = 1;
      else if (phase === 2 && state.site === 1 && before === 1) {
        state.build = value; state.bits = 3;
      } else if (phase === 4 && state.site === 1 && before === 3 &&
          (state.build === null || state.build === undefined)) {
        state.fallback = value; state.bits = 7;
      } else if (phase === 8 && state.site === 1 && (before === 3 || before === 7)) {
        const nullish = state.build === null || state.build === undefined;
        if ((before === 7) !== nullish || !is(value, nullish ? state.fallback : state.build)) invalidate(owner);
        state.bits |= 8; state.branch = nullish ? 2 : 1; state.kind = kind(value);
      } else if (phase === 16 && state.site === 2 && before === 0) state.bits = 1;
      else if (phase === 32 && state.site === 2 && before === 1) state.bits = 3;
      else invalidate(owner);
    });
    return value;
  }
  function finish(token) {
    const state = tokens.get(token), owner = state?.owner ?? active;
    safe(owner, () => {
      if (!state || state.closed || active !== owner || owner.closed) { invalidate(owner); return; }
      try {
        if (owner.stack.at(-1) !== token || owner.current() !== state.invocation) invalidate(owner);
      } finally {
        // Retire even when recording throws undefined. Never replace the operand's
        // original throw or return; recording faults are collected independently.
        state.closed = true; tokens.delete(token);
        const index = owner.stack.indexOf(token);
        if (index >= 0) owner.stack.splice(index, 1);
      }
    });
  }
  function claim(key, id, current) {
    const owner = { current, rows: new Map(), stack: [], errors: [], evaluations: 0,
      unknown: false, closed: false };
    safe(owner, () => {
      if (key !== contract || !Number.isSafeInteger(id) || id < 1 || id > 103 ||
          typeof current !== "function" || claims.has(id) || active) {
        invalidate(active); owner.unknown = true; poisoned = true;
      }
      claims.add(id); active = owner;
      for (const error of stray.splice(0)) fault(owner, error);
    });
    return freeze({
      bind(invocation) {
        safe(owner, () => {
          if (owner.closed || active !== owner || owner.rows.has(invocation) || owner.rows.size >= 2) { invalidate(owner); return; }
          owner.rows.set(invocation, { id: ++ordinal, sites: [null, null] });
        });
      },
      snapshot(invocation, diagnostic = false) {
        // First failed gate only: no new context lookup or operand evaluation.
        // 0=value, 1=poisoned, 2=owner unknown, 3=recording fault, 4=unbound,
        // 5/6=client/guard activation, 7=open evaluation, 8=no complete group,
        // 9=snapshot threw. Relay-only 10/11 mean missing/mismatched binding.
        let reason = 9, valueSites = null;
        const values = safe(owner, () => {
          const row = owner.rows.get(invocation);
          reason = poisoned ? 1 : owner.unknown ? 2 : owner.errors.length ? 3 : !row ? 4
            : activations[0] !== 1 ? 5 : activations[1] !== 1 ? 6 : owner.stack.length ? 7 : 0;
          if (diagnostic && (reason === 0 || reason === 7)) {
            const [client, guard] = row.sites;
            // Private retained state only: present, phase mask, closed per site.
            valueSites = freeze([client ? 1 : 0, client?.bits ?? 0, client?.closed ? 1 : 0,
              guard ? 1 : 0, guard?.bits ?? 0, guard?.closed ? 1 : 0]);
          }
          if (reason) return null;
          const [client, guard] = row.sites;
          // Missing or partial groups are UNKNOWN (zero), never "call absent".
          const c = client?.closed && (client.bits === 11 || client.bits === 15) ? client : null;
          const g = guard?.closed && guard.bits === 3 ? guard : null;
          if (!c && !g) { reason = 8; return null; }
          // v,key,invocation,clientEval,clientPhases,branch,selectedType,
          // guardEval,guardPhases,activatedSites,calleeIdentities(UNKNOWN).
          return freeze([1, contract, row.id, c?.id ?? 0, c?.bits ?? 0,
            c?.branch ?? 0, c?.kind ?? 0, g?.id ?? 0, g?.bits ?? 0, 3, 0]);
        }) ?? null;
        return diagnostic ? freeze({ values,
          valueState: freeze([activations[0], activations[1], values === null && reason === 0 ? 9 : reason]),
          valueSites: values === null && reason === 0 ? null : valueSites }) : values;
      },
      close() {
        safe(owner, () => {
          if (owner.closed || active !== owner || owner.stack.length) invalidate(owner);
          for (const token of owner.stack) tokens.delete(token);
          owner.stack.length = 0; owner.closed = true;
          if (active === owner) active = undefined;
        });
        // Original operations have already drained; caller appends these faults
        // after original failures, including falsey reasons, without flattening.
        return owner.errors.splice(0);
      },
    });
  }
  return freeze({ activate, claim, begin, finish,
    host: (t, v) => tap(t, 1, v), build: (t, v) => tap(t, 2, v),
    fallback: (t, v) => tap(t, 4, v), selected: (t, v) => tap(t, 8, v),
    argument: (t, v) => tap(t, 16, v), result: (t, v) => tap(t, 32, v) });
}

export function overlayQwenValueSource(site, source, contract) {
  assert.ok(site === 1 || site === 2);
  assert.ok(validHash(contract));
  assert.equal(hash(source), qwenValueSources[site - 1].sha256, "D8 callsite source changed");
  const text = source.toString("utf8"), anchor = site === 1 ? clientValueAnchor : guardValueAnchor;
  assert.ok(Buffer.from(text).equals(source) && text.split(anchor).length === 2, "exact single callsite anchor");
  assert.equal(text.includes("__qwenValues"), false, "overlay name collision");
  return `import { sink as __qwenValues } from "${qwenValueModule}";\n`
    + text.replace(anchor, site === 1 ? clientValueExpression : guardValueExpression)
    + `\n__qwenValues.activate(${site}, "${contract}");\n`;
}

export function qwenValueConfigText(plan) {
  return `import base from "../test/vitest/vitest.extension-providers.config.ts";
import { createQwenValuePlugin } from "./callsite-observer.mjs";
const plugin = createQwenValuePlugin(new URL("../", import.meta.url), new URL("./", import.meta.url), ${JSON.stringify(plan)});
export default { ...base, plugins: [...(base.plugins ?? []), plugin] };
`;
}

export function makeQwenValuePlan({ nonce, helperSHA, fixtureSHA, originals }) {
  assert.ok([nonce, helperSHA, fixtureSHA].every(validHash));
  assert.equal(originals.length, 2);
  const contract = hash(JSON.stringify({ schema: "qwen-value-overlay.v1", nonce, pin: qwenValuePin,
    helperSHA, fixtureSHA, originals: qwenValueSources }));
  const virtualSource = `const create = ${createQwenValueSink.toString()};\nexport const contract = "${contract}";\nexport const sink = create(contract);\n`;
  const outputs = originals.map((bytes, i) => overlayQwenValueSource(i + 1, bytes, contract));
  const plan = { schema: "qwen-value-overlay.v1", nonce, pin: qwenValuePin, target: qwenValueTarget,
    helperSHA, fixtureSHA, contract, virtualSHA: hash(virtualSource),
    sources: qwenValueSources.map((row, i) => ({ ...row, outputSHA: hash(outputs[i]) })) };
  const config = qwenValueConfigText(plan);
  return { plan, config, virtualSource, outputs, configSHA: hash(config) };
}

export function readQwenValueInput(file, expected, privateMode) {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const errors = []; let bytes;
  try {
    const before = fstatSync(fd);
    if (privateMode !== undefined) assert.ok((before.mode & 0o777) === privateMode && before.uid === process.getuid() && before.nlink === 1, "owned overlay input");
    assert.ok(before.isFile() && before.size > 0 && before.size <= 65536, "bounded regular D8 input");
    const buffer = Buffer.alloc(65537); let size = 0;
    while (size < buffer.length) { const n = readSync(fd, buffer, size, buffer.length - size, size); if (!n) break; size += n; }
    const after = fstatSync(fd);
    assert.ok(size === before.size && size <= 65536 &&
      ["dev", "ino", "size", "mtimeMs", "ctimeMs"].every(key => before[key] === after[key]), "D8 source changed while reading");
    bytes = buffer.subarray(0, size); assert.equal(hash(bytes), expected);
  } catch (error) { errors.push(error); }
  try { closeSync(fd); } catch (error) { errors.push(error); }
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new AggregateError(errors, "callsite read and close failed");
  return bytes;
}

export function createQwenValuePlugin(rootURL, directoryURL, expected) {
  const root = fileURLToPath(rootURL), directory = fileURLToPath(directoryURL);
  assert.equal(realpathSync(root), resolve(root), "canonical SDK root");
  assert.equal(dirname(resolve(directory)), resolve(root), "owned overlay directory");
  assert.match(resolve(directory).split(/[\\/]/).at(-1), /^\.clawrouter-runner-report-[A-Za-z0-9_-]+$/);
  readQwenValueInput(join(directory, "callsite-observer.mjs"), expected.helperSHA, 0o400);
  const ids = qwenValueSources.map(row => resolve(root, row.path));
  assert.ok(ids.every(id => realpathSync(id) === id), "canonical callsite IDs");
  const originals = ids.map((id, i) => readQwenValueInput(id, qwenValueSources[i].sha256));
  const contract = hash(JSON.stringify({ schema: "qwen-value-overlay.v1", nonce: expected.nonce,
    pin: qwenValuePin, helperSHA: expected.helperSHA, fixtureSHA: expected.fixtureSHA,
    originals: qwenValueSources }));
  assert.ok([expected.nonce, expected.helperSHA, expected.fixtureSHA, expected.virtualSHA].every(validHash));
  assert.equal(expected.contract, contract);
  const outputs = originals.map((bytes, i) => overlayQwenValueSource(i + 1, bytes, contract));
  const plan = { schema: "qwen-value-overlay.v1", nonce: expected.nonce, pin: qwenValuePin, target: qwenValueTarget,
    helperSHA: expected.helperSHA, fixtureSHA: expected.fixtureSHA, contract, virtualSHA: expected.virtualSHA,
    sources: qwenValueSources.map((row, i) => ({ ...row, outputSHA: hash(outputs[i]) })) };
  assert.deepEqual(plan, expected, "closed overlay plan");
  // Prepared from the hash-bound helper in the parent, not Function#toString
  // after config bundling. The worker receives these exact verified input bytes.
  const virtualSource = readQwenValueInput(join(directory, "worker-values.mjs"), expected.virtualSHA, 0o600).toString("utf8");
  const config = qwenValueConfigText(plan), configSHA = hash(config);
  assert.equal(hash(readQwenValueInput(join(directory, "qwen-callsite.config.ts"), configSHA, 0o600)), configSHA);
  const bundle = { outputs, virtualSource, configSHA };
  const virtualId = "\0clawrouter:qwen-values:" + expected.nonce;
  const virtualImporters = new Set([...ids, resolve(root, qwenValueTarget)]);
  const key = hash(JSON.stringify(expected) + "\0" + bundle.configSHA);
  return {
    name: "clawrouter:qwen-value-observation", enforce: "pre",
    configureVitest({ defineCacheKeyGenerator }) {
      // Every cached worker import is invocation-specific, including dependents.
      defineCacheKeyGenerator(() => key);
    },
    resolveId(id, importer) {
      if (id !== qwenValueModule) return null;
      assert.ok(virtualImporters.has(importer), "foreign worker sink importer");
      return virtualId;
    },
    load(id) {
      if (id === virtualId) return { code: bundle.virtualSource, moduleType: "js" };
      const index = ids.indexOf(id);
      if (index >= 0) {
        assert.equal(hash(readQwenValueInput(id, qwenValueSources[index].sha256)), qwenValueSources[index].sha256);
        return { code: bundle.outputs[index], map: null };
      }
      const canonical = id.split(/[?#]/, 1)[0];
      assert.ok(!ids.includes(canonical) && !id.startsWith("\0clawrouter:qwen-values:"), "foreign callsite/cache ID");
      return null;
    },
  };
}

// Explicit config retains extension-providers aliases, pool, setup and plugins.
// D8 run-vitest run + explicit config keeps native full-runtime/Kysely preparation.
export function qwenValueArgv(directory, target, reporterArgs) {
  assert.equal(target, qwenValueTarget);
  assert.ok(/^\.clawrouter-runner-report-[A-Za-z0-9_-]+$/.test(directory.split(/[\\/]/).at(-1)));
  return ["scripts/run-vitest.mjs", "run", "--config", join(directory, "qwen-callsite.config.ts"),
    target, "--maxWorkers=1", ...reporterArgs];
}
