// Serialized into the synthetic upstream, never shipped in the Worker.
export function createMusicSourceLifetime(signal, call, context, watchdogMs, runtime = {
  setTimeout: (callback, delay) => setTimeout(callback, delay), clearTimeout: handle => clearTimeout(handle),
}) {
  if (!signal || typeof signal.aborted !== "boolean" || !Number.isSafeInteger(watchdogMs) || watchdogMs <= 0 || watchdogMs > 120000) {
    throw new Error("invalid music source lifetime");
  }
  const faults = [], originals = [], callbacks = [];
  const state = call.sourceLifetime = { pending: 0, timerActive: false, listenerActive: false,
    timer: "pending", terminal: null, finished: false, cancelCalls: 0, cancelReturned: 0, abortCalls: 0, abortReturned: 0, faults: 0 };
  const fault = reason => { faults.push(reason); state.faults++; };
  const retain = pending => {
    originals.push(pending); state.pending++;
    void pending.then(() => { state.pending--; }, () => { state.pending--; });
    return pending;
  };
  let notify, resolveTimer, timer, attached = false, notified = false;
  const notification = retain(new Promise(resolve => { notify = value => {
    if (!notified) { notified = true; resolve(value); }
  }; }));
  // A real request-owned timer keeps the held producer live. Cancellation has a
  // distinct result; only its actual callback can report expiry.
  const timerPromise = retain(new Promise(resolve => {
    resolveTimer = resolve;
    timer = runtime.setTimeout(() => {
      state.timerActive = false; state.timer = "expired"; call.expired = true;
      resolve({ kind: "expired" });
    }, watchdogMs);
    state.timerActive = true;
  }));
  const timerObserved = timerPromise.then(value => value, reason => ({ kind: "failed", reason }));
  const aborted = event => {
    state.abortCalls++;
    if (event?.target !== signal || !signal.aborted || state.abortCalls !== 1) {
      const reason = new Error("foreign or duplicate source abort"); fault(reason); notify({ kind: "failed", reason }); return;
    }
    call.aborted = true; notify({ kind: "abort" });
    state.abortReturned++;
  };
  try {
    signal.addEventListener("abort", aborted); attached = state.listenerActive = true;
    if (signal.aborted) aborted({ target: signal });
  } catch (reason) { fault(reason); notify({ kind: "failed", reason }); }
  const done = retain((async () => {
    try {
      const first = await Promise.race([notification, timerObserved]);
      state.terminal = first.kind;
      if (first.kind === "expired") fault(new Error("music source watchdog expired"));
      else if (first.kind === "failed") fault(first.reason);
    } finally {
      if (attached) {
        try { signal.removeEventListener("abort", aborted); attached = state.listenerActive = false; }
        catch (reason) { fault(reason); }
      }
      if (state.timerActive) {
        try { runtime.clearTimeout(timer); state.timerActive = false; state.timer = "canceled"; resolveTimer({ kind: "canceled" }); }
        catch (reason) { fault(reason); }
      }
      // Detach the original observation after another terminal event. This is
      // not an observed abort and cannot set call.aborted/call.canceled.
      notify({ kind: "detached" });
      await Promise.allSettled([timerPromise, notification]);
      state.finished = true;
    }
    if (faults.length) throw new AggregateError(faults, "music source lifetime failed");
  })());
  const join = async () => {
    const errors = []; let cursor = 0;
    while (cursor < originals.length) {
      const batch = originals.slice(cursor); cursor = originals.length;
      for (const result of await Promise.allSettled(batch)) if (result.status === "rejected") errors.push(result.reason);
    }
    if (state.timerActive || state.listenerActive || state.pending) errors.push(new Error("music source ownership remains pending"));
    if (faults.length || errors.length) throw new AggregateError([...faults, ...errors], "music source originals failed");
  };
  const joined = join();
  void joined.catch(() => {});
  const register = pending => {
    try { context.waitUntil(pending); }
    catch (reason) { fault(reason); notify({ kind: "failed", reason }); }
  };
  register(joined);
  return {
    done, joined, join, originals, callbacks,
    fail(reason) {
      fault(reason); notify({ kind: "failed", reason });
      return done;
    },
    cancel(owner = signal) {
      state.cancelCalls++;
      if (owner !== signal || state.cancelCalls !== 1) {
        const reason = new Error("foreign or duplicate source cancellation"); fault(reason); notify({ kind: "failed", reason });
        const rejected = retain(Promise.reject(reason)); callbacks.push(rejected); register(rejected); return rejected;
      }
      call.canceled = true; notify({ kind: "cancel" });
      const pending = retain(done.then(() => { state.cancelReturned++; }));
      callbacks.push(pending); register(pending); return pending;
    },
    dispose() {
      if (!state.finished) { const reason = new Error("music source disposed before termination"); fault(reason); notify({ kind: "failed", reason }); }
      return join();
    },
  };
}
