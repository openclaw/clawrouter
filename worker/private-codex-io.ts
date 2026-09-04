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

export type PrivateBodyPredicate = "body.missing" | "body.read" | "body.aborted" | "body.limit" | "body.utf8" | "body.json";

export class PrivateBodyError extends Error {
  readonly predicate: PrivateBodyPredicate;
  readonly bytes: number | null;

  constructor(predicate: PrivateBodyPredicate, bytes: number | null) {
    super("private body rejected");
    this.predicate = predicate;
    this.bytes = bytes;
  }
}

export async function boundedRequestJson(body: ReadableStream<Uint8Array> | null, limit: number, signal: AbortSignal): Promise<{ value: unknown; bytes: number }> {
  if (!body) throw new PrivateBodyError("body.missing", null);
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try { reader = body.getReader(); } catch { throw new PrivateBodyError("body.read", 0); }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "", bytes = 0;
  try {
    while (true) {
      let result: ReadableStreamReadResult<Uint8Array>;
      try { result = await read(reader, signal); }
      catch { throw new PrivateBodyError(signal.aborted ? "body.aborted" : "body.read", bytes); }
      if (result.done) break;
      bytes += result.value.byteLength;
      if (bytes > limit) throw new PrivateBodyError("body.limit", bytes);
      try { text += decoder.decode(result.value, { stream: true }); }
      catch { throw new PrivateBodyError("body.utf8", bytes); }
    }
    try { text += decoder.decode(); }
    catch { throw new PrivateBodyError("body.utf8", bytes); }
    try { return { value: JSON.parse(text), bytes }; }
    catch { throw new PrivateBodyError("body.json", bytes); }
  } catch (error) {
    if (error instanceof PrivateBodyError) throw error;
    throw new PrivateBodyError(signal.aborted ? "body.aborted" : "body.read", bytes);
  } finally { cancel(reader); }
}

export async function boundedJson(body: ReadableStream<Uint8Array> | null, limit: number, signal: AbortSignal): Promise<unknown> {
  return (await boundedRequestJson(body, limit, signal)).value;
}
