// The existing image leaf owns JSON validation. This borrowed stream owns only
// the upstream reader lifetime: its cancellation acknowledgement must finish
// before the common response charge can be released. No byte copies or parsing.
export function ownMiniMaxImageInput(response: Response): { response: Response; retire(reason?: unknown): Promise<void> } {
  if (!response.body) return { response, retire: async () => undefined };
  if (response.redirected) {
    // The unchanged leaf rejects redirects. Capture its input retirement before
    // that rejection can initiate a second, already-closed cancellation.
    const cleanup = response.body.cancel().catch(() => undefined);
    return { response, retire: () => cleanup };
  }
  const reader = response.body.getReader();
  let pending: Promise<ReadableStreamReadResult<Uint8Array>> | undefined;
  let cleanup: Promise<void> | undefined;
  let eof = false, stopped = false, locked = true;
  let relay: ReadableStreamDefaultController<Uint8Array> | undefined;
  const unlock = () => { if (locked) { locked = false; reader.releaseLock(); } };
  const retire = (reason?: unknown): Promise<void> => {
    if (cleanup) return cleanup;
    stopped = true;
    cleanup = (async () => {
      try {
        if (!eof) await reader.cancel(reason).catch(() => undefined);
        await pending?.catch(() => undefined);
      } finally { unlock(); }
    })();
    if (!eof) { try { relay?.close(); } catch { /* canceled relay is already closed */ } }
    return cleanup;
  };
  const body = new ReadableStream<Uint8Array>({
    start(controller) { relay = controller; },
    async pull(controller) {
      if (stopped) return;
      try {
        pending = reader.read();
        const chunk = await pending; pending = undefined;
        if (stopped) return;
        if (chunk.done) { eof = true; unlock(); controller.close(); }
        else controller.enqueue(chunk.value);
      } catch (error) {
        // Never turn a failed source read into an apparently complete JSON EOF.
        try { controller.error(error); } catch { /* canceled relay is already closed */ }
        await retire(error);
      }
    },
    cancel: retire,
  }, { highWaterMark: 0 });
  return { response: new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers }), retire };
}
