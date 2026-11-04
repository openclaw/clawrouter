// A reader's operation result is not proof that its source has retired. This
// owner joins the actual read, FIRST cancellation and optional source/pipe tail.
// It owns no buffers, budget, deadlines, signals or accounting decisions.
export interface InputRetirement {
  read<T>(start: () => Promise<T>): Promise<T>;
  retire(kind: "eof" | "cancel", reason?: unknown): Promise<void>;
  readonly retired: Promise<void>;
}

export function inputRetirement(
  reader: { cancel(reason?: unknown): Promise<void>; releaseLock(): void },
  sourceRetired?: Promise<void>,
): InputRetirement {
  let pending: Promise<unknown> | undefined;
  let retirement: Promise<void> | undefined;
  let stopped = false;
  let resolve!: () => void, reject!: (reason: unknown) => void;
  const retired = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  // Owners may attach their capacity continuation after cancellation starts.
  void retired.catch(() => undefined);
  // Observe a source failure immediately, but still join its settlement below.
  const source = sourceRetired?.then(() => ({ ok: true as const }), error => ({ ok: false as const, error }));
  return {
    retired,
    read<T>(start: () => Promise<T>): Promise<T> {
      if (stopped || pending) return Promise.reject(new Error("input reader is retired or already reading"));
      let read: Promise<T>;
      try { read = Promise.resolve(start()); } catch (error) { return Promise.reject(error); }
      pending = read;
      return read.finally(() => { if (pending === read) pending = undefined; });
    },
    retire(kind, reason) {
      if (retirement) return retirement;
      stopped = true;
      retirement = retired; // Publish before cancel can synchronously re-enter.
      const reading = pending;
      let cancellation: Promise<void> | undefined;
      if (kind === "cancel") {
        try { cancellation = Promise.resolve(reader.cancel(reason)); }
        catch (error) { cancellation = Promise.reject(error); }
      }
      void (async () => {
        // A failed cleanup still must settle alongside the read and source tail.
        // Preserve the original read/accounting outcome, not the cleanup error.
        await Promise.allSettled([reading, cancellation]);
        const sourceResult = await source;
        reader.releaseLock();
        if (sourceResult && !sourceResult.ok) throw sourceResult.error;
      })().then(resolve, reject);
      return retirement;
    },
  };
}
