import { createSseFrames, type UsageInspection } from "./token-usage.ts";

interface NativeEventInspector {
  accept(value: unknown): void;
  unavailable(): void;
  result(): UsageInspection;
}

// Reuse bounded SSE framing, with strict native JSON evidence. The caller keeps
// the original reader, bytes, demand and cancellation; this never fetches/tees.
export function createNativeEventObserver(inspector: NativeEventInspector) {
  let closed = false;
  function data(frame: string): string | null {
    const values: string[] = [];
    for (const line of frame.split("\n")) {
      if (!line || line.startsWith(":")) continue;
      const colon = line.indexOf(":"), name = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
      if (name === "data") values.push(value);
      else if (!["event", "id", "retry"].includes(name)) { inspector.unavailable(); return null; }
    }
    return values.length ? values.join("\n") : null;
  }
  const frames = createSseFrames(frame => {
    if (frame === null) { inspector.unavailable(); return; }
    const value = data(frame);
    if (value === null || !value.trim()) return;
    try { inspector.accept(JSON.parse(value)); }
    catch { inspector.unavailable(); }
  }, true);
  return {
    push(bytes: Uint8Array) { if (!closed) frames.push(bytes); },
    result(): UsageInspection {
      if (!closed) {
        const pending = frames.pending();
        if (pending === null || data(pending)?.trim()) inspector.unavailable();
        closed = true;
      }
      return inspector.result();
    },
  };
}
