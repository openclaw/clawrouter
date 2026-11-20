import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, lstat } from "node:fs/promises";
import { join, resolve } from "node:path";

export const basetenGuardPin = "761748e1824e2ee43e886fcce4376c3b20055015";
export const basetenGuardSources = Object.freeze([
  { path: "src/media-understanding/shared.ts", sha256: "712a4fde1ed05f51d22d439ed0ccc5957dc579849c054c5c129bdc2b4977459f" },
  { path: "src/agents/provider-transport-dispatcher-pool.ts", sha256: "fbdb819ace74f9aab0c5d9e9cc7c262e5959687258266f7d011524e8e99cb796" },
  { path: "src/infra/net/fetch-guard.ts", sha256: "b8a2b253eb3c217809e8113e224a0acf37d3cdb111f0c197d7acf03fedc817c8" },
].map(Object.freeze));
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const validHash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const same = (a, b) => ["dev", "ino", "uid", "nlink", "mode"].every(key => a[key] === b[key]);

export async function restoreBasetenGuardSource(row, read, write, statPath = lstat) {
  const now = await read(row.file);
  assert.ok(same(now.stat, row.stat) && same(await statPath(row.path), row.stat), "Baseten source inode changed");
  if (row.changed) {
    if (row.applied) assert.ok(now.bytes.equals(row.output), "Baseten observation changed during execution");
    await write(row.file, row.bytes);
  } else assert.ok(now.bytes.equals(row.bytes), "Baseten guard source changed during execution");
  assert.ok(same(await row.file.stat(), row.stat) && same(await statPath(row.path), row.stat), "Baseten restored pathname changed");
}

// Observe the real call before native SDK compilation. Neither the loader nor
// the guard/transport is replaced; the exact original promise returns unchanged.
export function basetenGuardPrelude(contract, site = "catalog") {
  assert.ok(validHash(contract)); assert.ok(["catalog", "decision"].includes(site));
  return `const __basetenGuardModule = { site: ${JSON.stringify(site)}, faults: [] as unknown[] };
function __basetenGuardObserve(fn: Function, input: unknown, returned: boolean, value: unknown) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, Symbol.for("clawrouter.baseten.guard.${contract}"));
  if (!descriptor || !("value" in descriptor)) return;
  const channel = descriptor.value;
  try {
    channel.modules.add(__basetenGuardModule);
    channel.observe(__basetenGuardModule, fn, undefined, [input], returned, value);
  } catch (error) { __basetenGuardModule.faults.push(error); }
}
function __basetenGuardInvoke<T>(fn: (input: T) => Promise<GuardedFetchResult>, input: T): Promise<GuardedFetchResult> {
  let original: Promise<GuardedFetchResult>;
  try { original = Reflect.apply(fn, undefined, [input]); }
  catch (error) { __basetenGuardObserve(fn, input, false, error); throw error; }
  __basetenGuardObserve(fn, input, true, original);
  return original;
}
`;
}

export function overlayBasetenGuardSource(bytes, contract, site = "catalog") {
  const index = site === "catalog" ? 0 : site === "decision" ? 1 : -1;
  assert.ok(index >= 0); assert.equal(sha(bytes), basetenGuardSources[index].sha256, "Baseten original callsite changed");
  const source = bytes.toString("utf8"); assert.ok(Buffer.from(source).equals(bytes)); assert.equal(source.includes("__basetenGuard"), false);
  const before = site === "catalog" ? "  return await fetchWithSsrFGuard({\n    url,\n    fetchImpl: fetchFn," : "  return fetchWithSsrFGuard({\n    ...options,";
  assert.equal(source.split(before).length, 2, "one original callsite per module");
  return Buffer.from(basetenGuardPrelude(contract, site) + source.replace(before, before.replace("fetchWithSsrFGuard({", "__basetenGuardInvoke(fetchWithSsrFGuard, {")));
}

// The ephemeral CI checkout owns these three held inodes. Keep original bytes in
// memory and restore them even when compilation, execution or observation fails.
export async function withBasetenGuardObservation(root, fixtureSHA, run) {
  assert.equal(process.env.CI, "true", "Baseten native observation requires its ephemeral CI checkout");
  assert.ok(validHash(fixtureSHA));
  assert.equal(await realpath(root), resolve(root)); root = resolve(root);
  assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(), basetenGuardPin);
  execFileSync("git", ["diff", "--quiet", "HEAD", "--"], { cwd: root });
  const contract = sha(JSON.stringify({ v: 1, pin: basetenGuardPin, fixtureSHA,
    nonce: randomBytes(32).toString("hex"), sources: basetenGuardSources }));
  const rows = [], failures = []; let result;
  const read = async file => {
    const before = await file.stat();
    assert.ok(before.isFile() && before.uid === process.getuid() && before.nlink === 1 && before.size <= 65536);
    const buffer = Buffer.alloc(65537); let size = 0;
    while (size < buffer.length) { const row = await file.read(buffer, size, buffer.length - size, size); if (!row.bytesRead) break; size += row.bytesRead; }
    const after = await file.stat();
    assert.ok(same(before, after) && before.size === size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs && size <= 65536);
    return { bytes: buffer.subarray(0, size), stat: after };
  };
  const write = async (file, bytes) => {
    let offset = 0;
    while (offset < bytes.length) { const row = await file.write(bytes, offset, bytes.length - offset, offset); assert.ok(row.bytesWritten > 0); offset += row.bytesWritten; }
    await file.truncate(bytes.length); await file.sync();
    assert.ok((await read(file)).bytes.equals(bytes), "Baseten overlay readback changed");
  };
  try {
    for (const source of basetenGuardSources) {
      const path = join(root, source.path); assert.equal(await realpath(path), path);
      const file = await open(path, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const row = { path, file, changed: false }; rows.push(row); Object.assign(row, await read(file));
      assert.equal(sha(row.bytes), source.sha256, "Baseten original source pin changed");
    }
    for (const [index, site] of ["catalog", "decision"].entries()) {
      const row = rows[index]; row.output = overlayBasetenGuardSource(row.bytes, contract, site);
      assert.ok((await read(row.file)).bytes.equals(row.bytes) && same(await lstat(row.path), row.stat));
      row.changed = true; await write(row.file, row.output); row.applied = true;
    }
    result = await run(contract);
  } catch (error) { failures.push(error); }
  for (const row of rows.reverse()) {
    try {
      await restoreBasetenGuardSource(row, read, write);
    } catch (error) { failures.push(error); }
    try { await row.file.close(); } catch (error) { failures.push(error); }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, "Baseten native execution and observation restoration failed");
  return result;
}
