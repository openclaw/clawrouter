export interface BoundedJsonLimits {
  readonly bytes: number;
  readonly depth: number;
  readonly values: number;
  readonly members: number;
  readonly entries: number;
  readonly strings: number;
  readonly scalar: number;
}

// Callers own their profile bounds and failure identity.
export function measureBoundedJson(value: unknown, cap: BoundedJsonLimits, fail: () => never): number {
  let bytes = 0, values = 0, members = 0, entries = 0, units = 0;
  const add = (n: number) => { if ((bytes += n) > cap.bytes) fail(); };
  const string = (text: string) => {
    if (text.length > cap.scalar || (units += text.length) > cap.strings) fail();
    add(2);
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i), next = text.charCodeAt(i + 1);
      if (c === 34 || c === 92 || c === 8 || c === 9 || c === 10 || c === 12 || c === 13) add(2);
      else if (c < 32) add(6);
      else if (c < 128) add(1);
      else if (c < 2048) add(2);
      else if (c >= 0xd800 && c <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) { add(4); i++; }
      else add(c >= 0xd800 && c <= 0xdfff ? 6 : 3);
    }
  };
  const visit = (item: unknown, depth: number): void => {
    if (++values > cap.values || depth > cap.depth) fail();
    if (item === null) { add(4); return; }
    if (typeof item === "string") { string(item); return; }
    if (typeof item === "boolean") { add(item ? 4 : 5); return; }
    if (typeof item === "number") { if (!Number.isFinite(item)) fail(); add(String(item).length); return; }
    if (typeof item !== "object") fail();
    if (Array.isArray(item)) {
      if ((entries += item.length) > cap.entries) fail();
      add(2 + Math.max(0, item.length - 1));
      for (let i = 0; i < item.length; i++) visit(item[i] ?? null, depth + 1);
      return;
    }
    if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) fail();
    add(2); let emitted = 0;
    for (const key in item) {
      if (!Object.hasOwn(item, key)) continue;
      if (++members > cap.members) fail();
      const field = Object.getOwnPropertyDescriptor(item, key)!;
      if (!("value" in field)) fail();
      if (field.value === undefined) continue;
      if (emitted++) add(1);
      string(key); add(1); visit(field.value, depth + 1);
    }
  };
  visit(value, 1); return bytes;
}
