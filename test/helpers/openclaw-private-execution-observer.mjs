import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, lstat } from "node:fs/promises";
import { join, resolve } from "node:path";

// E2-only test observations. Temporary, hash-bound source overlays reach both
// Vitest and native module loads; they do not replace either loader or transport.
export const privateExecutionSources = Object.freeze([
  { path: "packages/ai/src/stream.ts", sha256: "08bc3fa48900ee89d34c33b9eb92508285f7332cb73aa19bd61ec5c09625b7de" },
  { path: "packages/ai/src/api-registry.ts", sha256: "5455ee2b67c34bd1d8e85811ee55fe3596bf1291a0165765afdf6b82af7fc18a" },
  { path: "packages/ai/src/host.ts", sha256: "b72db9f92331cc55c89e467f1e6e39cd2fdabe82f2e49cbbe07028305d3231c9" },
  { path: "src/infra/net/fetch-guard.ts", sha256: "571a4fc615fa9e4ed3ab44f40b2e09121dae3bae9afaa43b71d740d3627df282" },
  { path: "src/agents/provider-transport-dispatcher-pool.ts", sha256: "fbdb819ace74f9aab0c5d9e9cc7c262e5959687258266f7d011524e8e99cb796" },
  { path: "packages/ai/src/transports/transport-stream-shared.ts", sha256: "d987e6ccdfb3aa106e0c81f1fa67eb52ec22fab45eb783d6904b0adfabdf2cf7" },
].map(Object.freeze));
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const validHash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

export function overlayPrivateExecutionSource(index, bytes, contract) {
  assert.ok(Number.isInteger(index) && index >= 0 && index < privateExecutionSources.length);
  assert.ok(validHash(contract));
  assert.equal(sha(bytes), privateExecutionSources[index].sha256, "E2 execution source changed");
  let source = bytes.toString("utf8");
  assert.ok(Buffer.from(source).equals(bytes));
  assert.equal(source.includes("__privateE2"), false);
  const replace = (before, after) => {
    assert.equal(source.split(before).length, 2, "one exact E2 execution anchor");
    source = source.replace(before, after);
  };
  if (index === 0) {
    replace("return startStream(() =>\n      resolveApiProvider(model.api).stream(model, context, options as StreamOptions),\n    );",
      "return startStream(() => {\n      const __privateE2Provider = resolveApiProvider(model.api);\n      const __privateE2Callable = __privateE2Provider.stream;\n      __privateE2Observe(1, [__privateE2Provider, __privateE2Callable, model]);\n      return Reflect.apply(__privateE2Callable, __privateE2Provider, [model, context, options as StreamOptions]);\n    });");
    replace("return startStream(() => resolveApiProvider(model.api).streamSimple(model, context, options));",
      "return startStream(() => {\n      const __privateE2Provider = resolveApiProvider(model.api);\n      const __privateE2Callable = __privateE2Provider.streamSimple;\n      __privateE2Observe(2, [__privateE2Provider, __privateE2Callable, model]);\n      return Reflect.apply(__privateE2Callable, __privateE2Provider, [model, context, options]);\n    });");
  }
  if (index === 1) {
    replace("    providers.set(provider.api, {\n      provider: {", "    let __privateE2Record: RegisteredApiProvider;\n    providers.set(provider.api, {\n      provider: (__privateE2Record = {");
    replace("      },\n      sourceId,\n    });", "      }),\n      sourceId,\n    });\n    __privateE2Observe(3, [__privateE2Record]);");
  }
  if (index === 2) replace("  return scopedAiTransportHost?.getStore() ?? activeAiTransportHost;",
    "  const __privateE2Host = scopedAiTransportHost?.getStore() ?? activeAiTransportHost;\n  __privateE2Observe(4, [getAiTransportHost, __privateE2Host]);\n  return __privateE2Host;");
  if (index === 3) replace("export async function fetchWithSsrFGuard(params: GuardedFetchOptions): Promise<GuardedFetchResult> {",
    "export async function fetchWithSsrFGuard(params: GuardedFetchOptions): Promise<GuardedFetchResult> {\n  __privateE2Observe(5, [fetchWithSsrFGuard, params]);");
  if (index === 4) replace("  return fetchWithSsrFGuard({\n    ...options,\n    dispatcherPool: getProviderTransportDispatcherPool(),\n  });",
    "  const __privateE2Guard = fetchWithSsrFGuard;\n  const __privateE2Input = {\n    ...options,\n    dispatcherPool: getProviderTransportDispatcherPool(),\n  };\n  __privateE2Observe(6, [__privateE2Guard, __privateE2Input]);\n  return __privateE2InvokeGuard(__privateE2Guard, __privateE2Input);");
  if (index === 5) replace("  const { stream, output, signal, error, cleanup } = params;",
    "  const { stream, output, signal, error, cleanup } = params;\n  __privateE2Observe(7, [error, output, signal]);");
  // The channel is installed for one owned case at a time. Observer
  // exceptions are independent faults, never replacements for SDK outcomes.
  return Buffer.from(`const __privateE2Module = {};
${index === 4 ? `function __privateE2InvokeGuard(fn: Function, input: unknown) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, Symbol.for("clawrouter.private.execution.${contract}"));
  const channel = descriptor && "value" in descriptor ? descriptor.value : undefined;
  const call = channel && Object.getOwnPropertyDescriptor(channel, "guardCall");
  if (call && "value" in call && typeof call.value === "function") return Reflect.apply(call.value, undefined, [__privateE2Module, fn, input]);
  return Reflect.apply(fn, undefined, [input]);
}
` : ""}function __privateE2Observe(site: number, values: unknown[]) {
  let channel;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, Symbol.for("clawrouter.private.execution.${contract}"));
    if (!descriptor || !("value" in descriptor)) return;
    channel = descriptor.value;
    channel.observe(${index}, __privateE2Module, site, values);
  } catch (error) { try { channel?.fault(error); } catch {} }
}
` + source);
}

// Own the already-admitted ephemeral CI checkout only. No backup files or
// alternate SDK tree; retain originals in memory and restore each exact inode.
export async function withPrivateExecutionOverlay(root, fixtureSHA, run, io = { open, realpath, lstat }) {
  assert.ok(validHash(fixtureSHA));
  assert.equal(await io.realpath(root), resolve(root));
  root = resolve(root);
  const contract = sha(JSON.stringify({ v: 1, pin: "e2a8b8d4ec290cd6c035f3568a14e4d7c6433635",
    nonce: randomBytes(32).toString("hex"), fixtureSHA, sources: privateExecutionSources }));
  const rows = [], failures = []; let result;
  const same = (a, b) => ["dev", "ino", "uid", "nlink", "mode"].every(key => a[key] === b[key]);
  const read = async file => {
    const before = await file.stat();
    assert.ok(before.isFile() && before.uid === process.getuid() && before.nlink === 1 && before.size <= 65536);
    const buffer = Buffer.alloc(65537); let size = 0;
    while (size < buffer.length) { const r = await file.read(buffer, size, buffer.length - size, size); if (!r.bytesRead) break; size += r.bytesRead; }
    const after = await file.stat();
    assert.ok(same(before, after) && before.size === size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs && size <= 65536);
    return { bytes: buffer.subarray(0, size), stat: after };
  };
  const write = async (file, bytes) => {
    let offset = 0;
    while (offset < bytes.length) { const r = await file.write(bytes, offset, bytes.length - offset, offset); assert.ok(r.bytesWritten > 0); offset += r.bytesWritten; }
    await file.truncate(bytes.length); await file.sync();
    assert.ok((await read(file)).bytes.equals(bytes), "E2 overlay write readback changed");
  };
  try {
    for (let i = 0; i < privateExecutionSources.length; i++) {
      const path = join(root, privateExecutionSources[i].path);
      assert.equal(await io.realpath(path), path);
      const file = await io.open(path, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const row = { path, file, changed: false }; rows.push(row);
      Object.assign(row, await read(file));
      row.output = overlayPrivateExecutionSource(i, row.bytes, contract);
    }
    for (const row of rows) {
      assert.ok((await read(row.file)).bytes.equals(row.bytes), "E2 preimage changed before overlay");
      assert.ok(same(await io.lstat(row.path), row.stat), "E2 source path changed");
      row.changed = true; await write(row.file, row.output); row.applied = true;
    }
    result = await run(contract);
  } catch (error) { failures.push(error); }
  for (const row of rows.reverse()) {
    if (row.changed) try {
      const now = await read(row.file);
      assert.ok(same(now.stat, row.stat) && same(await io.lstat(row.path), row.stat), "E2 overlay inode changed");
      // A failed initial write can be partial; keep its original failure and
      // restore only this held inode. After dispatch, require our exact bytes.
      if (row.applied) assert.ok(now.bytes.equals(row.output), "E2 overlay changed during execution");
      await write(row.file, row.bytes);
    } catch (error) { failures.push(error); }
    try { await row.file.close(); } catch (error) { failures.push(error); }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, "Private execution and overlay restoration failed");
  return result;
}
