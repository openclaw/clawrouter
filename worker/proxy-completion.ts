/** Logical custody for one ordinary HTTP caller. No payloads or rejection reasons are retained here. */
export interface ProxyCompletionReceipt { readonly failed: boolean; readonly unused: boolean }

export class ProxyCompletion {
  private open = true;
  private pending = 0;
  private started = false;
  private failed = false;
  private resolve!: (receipt: ProxyCompletionReceipt) => void;
  readonly completion = new Promise<ProxyCompletionReceipt>(resolve => { this.resolve = resolve; });

  /** An active parent may enroll children after its own parent has sealed. */
  fork(): ProxyCompletion {
    if (!this.open) throw new TypeError("HTTP completion enrollment is closed");
    this.started = true;
    this.pending++;
    const child = new ProxyCompletion();
    void child.completion.then(receipt => {
      this.failed ||= receipt.failed;
      this.pending--;
      this.finish();
    });
    return child;
  }

  /** Reserve before invoking even synchronous work; return its ORIGINAL promise/outcome. */
  start<T>(start: (children: ProxyCompletion) => Promise<T>): Promise<T> {
    const children = this.fork();
    let work: Promise<T>;
    try { work = start(children); }
    catch (error) { children.fail(); children.seal(); throw error; }
    void work.then(() => { children.seal(); }, () => { children.fail(); children.seal(); });
    return work;
  }

  /** @internal Complete private leaf only; dynamic callers keep fork/start. */
  startPrivateLeaf<T>(invoke: () => Promise<T>): Promise<T> {
    if (!this.open) throw new TypeError("HTTP completion enrollment is closed");
    this.started = true;
    this.pending++;
    let work: Promise<T>;
    try { work = invoke(); }
    catch (error) { this.failed = true; this.pending--; this.finish(); throw error; }
    finally { invoke = undefined as never; }
    this.observePrivateLeaf(work);
    return work;
  }

  private observePrivateLeaf(work: Promise<unknown>): void {
    // This scope holds no invocation callback, fulfilled value or reject reason.
    let pending = true;
    try {
      void work.then(() => {
        if (!pending) return;
        pending = false; this.pending--; this.finish();
      }, () => {
        if (!pending) return;
        pending = false; this.failed = true; this.pending--; this.finish();
      });
    } catch (error) {
      // Observation failed after work started. Keep its enrollment UNKNOWN;
      // even a partially installed observer must not manufacture retirement.
      pending = false; this.failed = true; throw error;
    } finally { work = undefined as never; }
  }

  /** A fulfilled false accounting result is a settled failure, not successful accounting. */
  fail(): void { this.failed = true; }
  seal(): void { this.open = false; this.finish(); }
  private finish(): void {
    if (!this.open && this.pending === 0) this.resolve(Object.freeze({ failed: this.failed, unused: !this.started }));
  }
}
