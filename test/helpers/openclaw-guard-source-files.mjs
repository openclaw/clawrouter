import assert from "node:assert/strict";
import { lstat } from "node:fs/promises";

const same = (a, b) => ["dev", "ino", "uid", "nlink", "mode"].every(key => a[key] === b[key]);

// Fixed profile for the native guard observers' owned, bounded source files.
export function guardSourceFiles(label) {
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
    assert.ok((await read(file)).bytes.equals(bytes), `${label} overlay readback changed`);
  };

  async function restore(row, read, write, statPath = lstat) {
    const now = await read(row.file);
    assert.ok(same(now.stat, row.stat) && same(await statPath(row.path), row.stat), `${label} source inode changed`);
    if (row.changed) {
      if (row.applied) assert.ok(now.bytes.equals(row.output), `${label} observation changed during execution`);
      await write(row.file, row.bytes);
    } else assert.ok(now.bytes.equals(row.bytes), `${label} guard source changed during execution`);
    assert.ok(same(await row.file.stat(), row.stat) && same(await statPath(row.path), row.stat), `${label} restored pathname changed`);
  }

  return { same, read, write, restore };
}
