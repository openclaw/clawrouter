import assert from "node:assert/strict";
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { guardSourceFiles } from "./helpers/openclaw-guard-source-files.mjs";

const io = guardSourceFiles("Fixture");

test("held source restores original bytes after short reads and writes", async t => {
  const root = await mkdtemp(join(tmpdir(), "guard-source-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "source.ts"), original = Buffer.from("original source");
  await writeFile(path, original);
  const file = await open(path, "r+");
  t.after(() => file.close());
  const short = {
    stat: () => file.stat(),
    read: (buffer, offset, length, position) => file.read(buffer, offset, Math.min(length, 3), position),
    write: (buffer, offset, length, position) => file.write(buffer, offset, Math.min(length, 2), position),
    truncate: length => file.truncate(length),
    sync: () => file.sync(),
  };
  const row = { path, file: short, ...await io.read(short), changed: true, applied: true, output: Buffer.from("overlay") };
  await io.write(short, row.output);
  await io.restore(row, io.read, io.write);
  assert.deepEqual(await readFile(path), original);
  await io.restore({ ...row, changed: false }, io.read, () => assert.fail("unchanged row must not write"));
});

test("held source read rejects oversized, foreign, linked and changing files", async () => {
  const bytes = Buffer.from("source");
  const stat = { dev: 1, ino: 2, uid: process.getuid(), nlink: 1, mode: 0o100644,
    size: bytes.length, mtimeMs: 1, ctimeMs: 1, isFile: () => true };
  for (const change of [{ size: 65537 }, { uid: stat.uid + 1 }, { nlink: 2 }, { isFile: () => false }]) {
    await assert.rejects(io.read({ stat: async () => ({ ...stat, ...change }), read: () => assert.fail("invalid file must not be read") }));
  }
  for (const change of [{ ino: 3 }, { mode: 0o100600 }, { mtimeMs: 2 }, { ctimeMs: 2 }]) {
    let stats = 0;
    await assert.rejects(io.read({
      stat: async () => ++stats === 1 ? stat : { ...stat, ...change },
      read: async (buffer, offset, length, position) => ({ bytesRead: bytes.copy(buffer, offset, position, position + length) }),
    }));
  }
  // Growth after the initial stat must be observed by the extra-byte probe.
  await assert.rejects(io.read({
    stat: async () => ({ ...stat, size: 65536 }),
    read: async (_buffer, _offset, length) => ({ bytesRead: length }),
  }));
});

test("held source write rejects stalled writes and mismatched readback", async () => {
  await assert.rejects(io.write({ write: async () => ({ bytesWritten: 0 }) }, Buffer.from("x")));
  const bytes = Buffer.from("x");
  const stat = { dev: 1, ino: 2, uid: process.getuid(), nlink: 1, mode: 0o100644,
    size: 1, mtimeMs: 1, ctimeMs: 1, isFile: () => true };
  const calls = [];
  await assert.rejects(io.write({
    write: async () => { calls.push("write"); return { bytesWritten: 1 }; },
    truncate: async () => calls.push("truncate"), sync: async () => calls.push("sync"),
    stat: async () => stat,
    read: async (buffer, offset, _length, position) => ({ bytesRead: Buffer.from("y").copy(buffer, offset, position) }),
  }, bytes), /Fixture overlay readback changed/);
  assert.deepEqual(calls, ["write", "truncate", "sync"]);
});
