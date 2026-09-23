type Cause = "caller" | "deadline" | "upstream" | "publication" | "complete";

// Internal consumers must identify their own deadline or failed consumption;
// an arbitrary provider AbortError is not evidence of either caller cancellation or timeout.
export class InternalHttpAbort extends Error {
  readonly cause: "deadline" | "upstream";
  constructor(cause: "deadline" | "upstream", message: string) { super(message); this.cause = cause; }
}

export class HttpOperation {
  private readonly controller = new AbortController();
  readonly signal = this.controller.signal;
  private cause?: Cause | "client_rejection" | "provider_rejection";
  private ending?: Cause;
  private timer?: ReturnType<typeof setTimeout>;
  private readonly caller?: AbortSignal;
  private readonly canceled = () => this.cancel(this.caller?.reason);

  constructor(caller?: AbortSignal, timeoutMs?: number) {
    this.caller = caller;
    if (caller?.aborted) this.canceled();
    else {
      caller?.addEventListener("abort", this.canceled, { once: true });
      if (timeoutMs !== undefined) this.timer = setTimeout(() => this.stop("deadline", new InternalHttpAbort("deadline", "upstream execution deadline exceeded")), timeoutMs);
    }
  }

  get status(): "client_error" | "timeout" | "provider_error" | undefined {
    return this.cause === "caller" || this.cause === "client_rejection" ? "client_error" : this.cause === "deadline" ? "timeout" : this.cause && this.cause !== "complete" ? "provider_error" : undefined;
  }

  get delivery(): "complete" | "canceled" | "failed" | undefined {
    return this.ending === "complete" ? "complete" : this.ending === "caller" ? "canceled" : this.ending ? "failed" : undefined;
  }

  // Accept only the final selected rejection. Recording its receipt cause must
  // neither dispose its readable error body nor retire the endpoint deadline.
  acceptRejection(status: number): void { this.cause ??= status < 500 ? "client_rejection" : "provider_rejection"; }

  retireDeadline(): void { clearTimeout(this.timer); this.timer = undefined; }

  cancel(reason?: unknown): void { this.stop(reason instanceof InternalHttpAbort ? reason.cause : "caller", reason); }

  stop(cause: Cause, reason?: unknown): void {
    if (this.ending) return;
    // The cause owns cleanup: reciprocal aborts and late registration results
    // cannot rewrite it. A parsed protocol terminal alone is not delivery EOF.
    this.cause ??= cause;
    this.ending = cause;
    this.retireDeadline();
    this.caller?.removeEventListener("abort", this.canceled);
    if (cause !== "complete") this.controller.abort(reason);
  }

  wait<T>(pending: Promise<T>, failure?: "upstream" | "publication", discard?: (value: T) => void): Promise<T> {
    return new Promise((resolve, reject) => {
      const aborted = () => { this.signal.removeEventListener("abort", aborted); reject(this.signal.reason); };
      if (this.signal.aborted) aborted();
      else this.signal.addEventListener("abort", aborted, { once: true });
      pending.then(value => {
        this.signal.removeEventListener("abort", aborted);
        if (this.signal.aborted) discard?.(value);
        else resolve(value);
      }, error => {
        if (failure) this.stop(failure, error);
        this.signal.removeEventListener("abort", aborted);
        reject(error);
      });
    });
  }
}
