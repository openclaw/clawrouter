export function cancel(reader: ReadableStreamDefaultReader<Uint8Array>): void { void reader.cancel().catch(() => {}); }

export async function read(reader: ReadableStreamDefaultReader<Uint8Array>, signal: AbortSignal): Promise<ReadableStreamReadResult<Uint8Array>> {
  signal.throwIfAborted();
  let listener: () => void = () => {};
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        listener = () => { cancel(reader); reject(new Error("private stream aborted")); };
        signal.addEventListener("abort", listener, { once: true });
        if (signal.aborted) listener();
      }),
    ]);
  } finally { signal.removeEventListener("abort", listener); }
}

export async function boundedJson(body: ReadableStream<Uint8Array> | null, limit: number, signal: AbortSignal): Promise<unknown> {
  if (!body) throw new Error("missing private body");
  const reader = body.getReader(), decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "", bytes = 0;
  try {
    while (true) {
      const result = await read(reader, signal);
      if (result.done) break;
      bytes += result.value.byteLength;
      if (bytes > limit) throw new Error("private body limit");
      text += decoder.decode(result.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally { cancel(reader); }
}
