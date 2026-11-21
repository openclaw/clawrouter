export interface JsonMeasurementCounts {
  text: number;
  bytes: number;
  values: number;
  containers: number;
  members: number;
  entries: number;
  units: number;
}

// Closed JSON accounting; callers retain their profile bounds and failure identity.
export function jsonMeasurement(maximum: number, counts: JsonMeasurementCounts,
  fail: (kind: "limit" | "protocol") => never, stringMaximum: number, unitMaximum: number) {
  const add = (text: number, bytes = text) => {
    counts.text += text; counts.bytes += bytes;
    if (counts.text > maximum || counts.bytes > maximum) fail("limit");
  };
  const string = (text: string, key = false) => {
    if (text.length > (key ? 1024 : stringMaximum) || (counts.units += text.length) > unitMaximum) fail("limit");
    add(2);
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c === 34 || c === 92 || c === 8 || c === 9 || c === 10 || c === 12 || c === 13) add(2);
      else if (c < 32) add(6);
      else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) { add(2, 4); i++; }
      else if (c >= 0xd800 && c <= 0xdfff) add(6);
      else add(1, c < 128 ? 1 : c < 2048 ? 2 : 3);
    }
  };
  const item = (value: unknown, depth: number): void => {
    if (++counts.values > 65536) fail("limit");
    if (typeof value === "string") return string(value);
    if (value === null || value === undefined || typeof value === "function" || typeof value === "symbol") { add(4); return; }
    if (typeof value === "boolean") { add(value ? 4 : 5); return; }
    if (typeof value === "number") { add(Number.isFinite(value) ? String(value).length : 4); return; }
    if (typeof value !== "object" || depth >= 16 || ++counts.containers > 16384) fail("limit");
    const array = Array.isArray(value);
    if (!array && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) fail("protocol");
    const toJson = Object.getOwnPropertyDescriptor(value, "toJSON");
    if (toJson && (!Object.hasOwn(toJson, "value") || typeof toJson.value === "function")) fail("protocol");
    add(2); let first = true;
    if (array) {
      for (let i = 0; i < value.length; i++) {
        if (++counts.entries + counts.members > 32768) fail("limit");
        if (!first) add(1); first = false;
        const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
        if (descriptor && !Object.hasOwn(descriptor, "value")) fail("protocol");
        item(descriptor?.value, depth + 1);
      }
    } else for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!Object.hasOwn(descriptor, "value")) fail("protocol");
      const child: unknown = descriptor.value;
      if (child === undefined || typeof child === "function" || typeof child === "symbol") continue;
      if (++counts.members + counts.entries > 32768) fail("limit");
      if (!first) add(1); first = false;
      string(key, true); add(1); item(child, depth + 1);
    }
  };
  return { item, add, string, counts };
}
